"""Admin/owner "agent console" — interface reserved, not implemented yet.

Every route here is gated by `require_role(admin, owner)`: a plain `user`
(the public chatbot visitor) can never reach these, only an authenticated
admin/owner acting through the dashboard. This is the powered-up side of
the RBAC split described in the repo root AGENTS.md — document ingestion,
generation, CRM, and reporting, the kind of actions that need real tool
access and should NOT be reachable from anonymous chatbot traffic.

Handlers started out all returning 501 so the request/response contracts
were stable and the frontend could be built against them immediately —
generate_landing_page, generate_poster, generate_geo_page, CRM entry
capture, and report generation are all real now; document ingestion
lives in apis/documents.py. Each real implementation here is a
deterministic, non-agentic pipeline call (no LLM tool-selection, no
agent loop) — not the kind of real tool access Phase 6's isolation
principle is actually guarding against. When a capability here ever
does grow into that (an actual agent loop calling arbitrary tools), it
should proxy into a purpose-built, narrowly-scoped agent/skill —
explicitly NOT the user's personal openclaw instance, which has broad
personal-account access (email, calendar, SSH) that has no business
being reachable from this app. See project plan Phase 6 for the
permission-boundary work that has to land first, before that day comes.
"""

import base64
from datetime import date, datetime, timedelta
from typing import Annotated, Literal, Union

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import chat_attachments
from apis.api import TextOverlayRequest, add_text_overlay
from apis.deps import CurrentUser, Role, get_current_user, require_role
from apis.model_settings import _list_image_providers, resolve_chat_provider, resolve_image_provider, resolve_vision_provider
from apis.pages import _get_or_create_page
from db import get_db
from llm_json import parse_lenient_json
from models import ChatMessage, ChatSession, CrmEntry, Document, OwnerAgentRun, PageVersion
from providers.base import ProviderNotConfigured
from resource_broker import maybe_release_llm_memory

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Which provider/model actually gets used is resolved per-request (see
# resolve_vision_provider, apis/model_settings.py) — an owner can pick any
# vision-capable model from the dashboard (Ollama, custom/llama.cpp, or a
# configured cloud provider), persisted globally. Falls back to Ollama +
# model_settings.DEFAULT_VISION_MODEL when nothing's been explicitly
# chosen.


class GenerateLandingPageRequest(BaseModel):
    design_image_base64: str
    notes: str = ""


# Mirrors frontend/src/lib/theme.ts's PageSection union exactly — keep the
# two in sync. The vision LLM's output is a *page schema* (which section
# types, in what order, with what content), never raw HTML/CSS: rendering
# happens by mapping each section to an existing reusable component
# (frontend/src/components/theme/), so a generated page can't inject
# arbitrary markup, can't drift from the site's Tailwind/shadcn styling,
# and doesn't need to be pixel-perfect — just the closest matching section
# per identified design block.


class ThemeCta(BaseModel):
    label: str
    href: str
    variant: Literal["default", "outline", "secondary", "ghost", "link"] = "default"
    # Added 2026-08-06 for CTE style editing — plain hex, applied as
    # inline style on top of "variant"'s fixed palette. All optional;
    # unset means every existing CTA renders unchanged.
    background_color: str | None = None
    text_color: str | None = None
    border_color: str | None = None
    rounded: Literal["none", "sm", "lg", "full"] | None = None
    size: Literal["sm", "default", "lg"] | None = None
    border_width: Literal["thin", "thick"] | None = None


class ThemeImage(BaseModel):
    url: str
    alt: str


# Added 2026-08-06 for CTE style editing. Every headline/heading/
# subheading/body field below accepts `str | RichText` — a plain string
# (the only shape the vision LLM ever produces) means "use this section's
# own default styling"; only a CTE edit that sets a color/size/weight
# upgrades a field to this object form. See frontend/src/lib/theme.ts's
# matching type for the full rationale (not xxx_color/xxx_size sibling
# fields per text field — one shared shape instead).
class RichText(BaseModel):
    content: str
    color: str | None = None
    # Plain pixel number, not a fixed enum — unlike every other size-ish
    # field in this schema (e.g. TextContentBlock.size below). A headline
    # needs a wider, continuous range than a handful of fixed stops can
    # cover; see frontend/src/lib/theme.ts's RichText doc comment for the
    # 2026-08-06 real-world finding that prompted this. Bounds match the
    # frontend's NumberField (RT_SIZE_MIN/RT_SIZE_MAX) — still a bounded,
    # controlled number, never open-ended.
    size: float | None = Field(default=None, ge=12, le=96)
    weight: Literal["normal", "medium", "semibold", "bold"] | None = None


class HeroSection(BaseModel):
    type: Literal["hero"] = "hero"
    eyebrow: str | None = None
    headline: str | RichText
    subheadline: str | RichText | None = None
    ctas: list[ThemeCta] = []
    image: ThemeImage | None = None
    # Plain hex color for a colored banner-style hero — same controlled
    # pattern as ContainerBlock.background_color. Without this, a hero
    # with a distinct background color (e.g. a full-width colored strip
    # right above a separate full-width photo section) had no way to be
    # represented at all.
    background_color: str | None = None
    # Which side `image` renders on. Defaults to "right" (text first,
    # image second — the only order this section supported before this
    # field existed).
    image_position: Literal["left", "right"] = "right"


class FeatureItem(BaseModel):
    title: str
    description: str
    # Defaults to "#" rather than being required: the model is told to
    # write "#" for hrefs it can't determine, but in practice sometimes
    # omits the field entirely instead — defaulting absorbs that without
    # needing the whole item dropped by _coerce_sections below.
    href: str = "#"
    icon: str | None = None
    image: ThemeImage | None = None
    # "avatar" -> small circular headshot beside the title, the
    # testimonial/review pattern (round profile photo + name + quote)
    # instead of a large rectangular photo card. Only meaningful when
    # `image` is set.
    image_style: Literal["photo", "avatar"] = "photo"
    badge: str | None = None


class FeatureGridSection(BaseModel):
    type: Literal["feature-grid"] = "feature-grid"
    heading: str | RichText | None = None
    subheading: str | RichText | None = None
    # Only meaningful for layout "split" — a longer supporting paragraph /
    # a single button in the left column, below heading/subheading.
    body: str | RichText | None = None
    cta: ThemeCta | None = None
    items: list[FeatureItem]
    columns: Literal[2, 3, 4] = 3
    layout: Literal["stacked", "split"] = "stacked"
    # "card" (default): rounded box with border/background, the existing
    # avatar/photo/icon variants. "plain": same grid/row arrangement, no
    # card chrome, image position via item_image_position. "list": ignores
    # columns entirely — a single-column list of rows, image left, text
    # right, divided by a line between rows. Not every design presents
    # repeated items as cards.
    item_style: Literal["card", "plain", "list"] = "card"
    # Only meaningful when item_style is "plain".
    item_image_position: Literal["top", "bottom"] = "top"


class CarouselSection(BaseModel):
    type: Literal["carousel"] = "carousel"
    heading: str | None = None
    slides: list[ThemeImage]


class TextBlockSection(BaseModel):
    type: Literal["text-block"] = "text-block"
    icon: str | None = None
    heading: str | RichText
    body: str | RichText
    align: Literal["left", "center"] = "left"
    image: ThemeImage | None = None
    image_position: Literal["left", "right"] = "right"
    background_image: ThemeImage | None = None


class CtaBannerSection(BaseModel):
    type: Literal["cta-banner"] = "cta-banner"
    heading: str | RichText
    body: str | RichText | None = None
    ctas: list[ThemeCta]


class BadgeListSection(BaseModel):
    type: Literal["badge-list"] = "badge-list"
    heading: str | RichText
    badges: list[str]


# Generic, composable block primitives — added 2026-08-05 alongside
# ContainerBlock, mirroring frontend/src/lib/theme.ts's Block union
# exactly. Distinct from the fixed composite sections above: a small set
# of atomic building blocks (image / text / button) plus a row/column/grid
# container that can hold them — including other containers, so a
# design's "row split into two padded columns" layout is just two levels
# of nesting, not a special case. Every style knob here is a constrained
# enum or a plain hex color string (same controlled-color pattern as
# accent_color below) — no free-form CSS anywhere, and deliberately no
# input/textarea/select-type blocks (the chatbot handles interactive
# needs elsewhere). See ContainerBlock's own note on how the recursive
# `children` type is wired up.

# How much of a `layout: "row"` container's width one child should take,
# relative to its siblings — added 2026-08-05 for uneven splits (e.g. a
# banner's headline column wider than its subheadline column). A small,
# fixed set of discrete stops rather than an arbitrary fraction on
# purpose — see the matching field's doc comment in frontend/src/lib/theme.ts
# for the full reasoning. "auto" (the default) is this schema's original
# equal-split behavior, unchanged.
BlockWidth = Literal["auto", "1/4", "1/3", "1/2", "2/3", "3/4", "full"]


class ImageBlock(BaseModel):
    type: Literal["image"] = "image"
    image: ThemeImage
    aspect_ratio: Literal["square", "video", "portrait", "auto"] = "auto"
    rounded: Literal["none", "sm", "lg", "full"] = "lg"
    width: BlockWidth = "auto"


class TextContentBlock(BaseModel):
    type: Literal["text"] = "text"
    content: str
    size: Literal["sm", "base", "lg", "xl", "2xl", "3xl"] = "base"
    weight: Literal["normal", "medium", "semibold", "bold"] = "normal"
    color: str | None = None
    align: Literal["left", "center", "right"] = "left"
    width: BlockWidth = "auto"


class ButtonBlock(BaseModel):
    type: Literal["button"] = "button"
    label: str
    href: str
    background_color: str | None = None
    text_color: str | None = None
    border_color: str | None = None
    rounded: Literal["none", "sm", "lg", "full"] | None = None
    size: Literal["sm", "default", "lg"] = "lg"
    border_width: Literal["thin", "thick"] | None = None
    width: BlockWidth = "auto"
    # Added 2026-08-20 — see frontend/src/lib/theme.ts's matching field for
    # the full "owner-composed product promo block" design. "link" (the
    # default) is this field's original, only behavior — href navigates,
    # unchanged. "add_to_cart" ignores href and calls the same
    # POST /api/cart/add every other add-to-cart control uses, for
    # product_id.
    action: Literal["link", "add_to_cart"] = "link"
    product_id: int | None = None


class ContainerBlock(BaseModel):
    type: Literal["container"] = "container"
    layout: Literal["row", "column", "grid"]
    columns: Literal[2, 3, 4] = 2
    gap: Literal["none", "sm", "md", "lg"] = "md"
    padding: Literal["none", "sm", "md", "lg"] = "none"
    # Same fixed-stop pattern as padding — space outside the border
    # instead of inside it. Added 2026-08-06 for CTE style editing.
    margin: Literal["none", "sm", "md", "lg"] = "none"
    background_color: str | None = None
    background_image: ThemeImage | None = None
    border_color: str | None = None
    align: Literal["start", "center", "end", "stretch"] = "stretch"
    # justify's counterpart to align — main-axis instead of cross-axis, for
    # row/column layouts only (ignored for grid). None (unset) keeps the
    # original "start" behavior every existing container already renders
    # with. Added 2026-08-06 for CTE style editing.
    justify: Literal["start", "center", "end", "between"] | None = None
    # Meaningful when *this* container is itself a child inside another
    # container's "children" (a nested row/column being given a share of
    # its parent row's width) — same field, same meaning as on the leaf
    # block types above.
    width: BlockWidth = "auto"
    # Only meaningful when this ContainerBlock is a top-level PageSection —
    # skips the page's standard max-width wrapper for this one section so
    # it spans the full viewport edge-to-edge (e.g. a full-width banner
    # photo with no side whitespace). See frontend/src/lib/theme.ts's
    # matching field for the full doc comment.
    full_bleed: bool = False
    # A fixed set of stops, not an arbitrary value — same "controlled
    # options" reasoning as `width`/BlockWidth. Without this, a
    # background_image container's height is purely whatever its children/
    # padding add up to, which leaves a hero-banner/photo-card style
    # container far shorter than the design shows if its children are just
    # a couple of lines of text. None (unset) applies no min-height, so
    # every container without this field renders exactly as before it
    # existed.
    min_height: Literal["sm", "md", "lg", "xl", "screen"] | None = None
    # Added 2026-08-20 — see frontend/src/lib/theme.ts's matching field for
    # the full "stretched-link product promo" design. None/unset (every
    # existing container) renders exactly as before this field existed.
    link_product_id: int | None = None
    # Forward reference to `Block`, defined just below — Pydantic can't
    # resolve this until ContainerBlock.model_rebuild() runs after `Block`
    # actually exists (standard pattern for a self-referential discriminated
    # union: ContainerBlock is itself one of Block's variants).
    children: list["Block"] = []


class ProductListBlock(BaseModel):
    type: Literal["product-list"] = "product-list"
    # None = every available product; set to filter to one category
    # (matches Product.category's own free-text values, e.g. "Coffee").
    category: str | None = None
    # Added 2026-08-20 — an explicit ordered allow-list, takes priority
    # over `category` when both are set. See the matching frontend field's
    # doc comment for the full "feature exactly these products" design.
    product_ids: list[int] | None = None
    width: BlockWidth = "auto"


class ProductCardBlock(BaseModel):
    """Added 2026-08-20 — a single product card (ProductListBlock's
    one-item counterpart), for featuring ONE product somewhere a full grid
    doesn't fit. Owner-inserted only via CTE, same posture as
    ProductListBlock (never vision-generated)."""

    type: Literal["product-card"] = "product-card"
    product_id: int | None = None
    width: BlockWidth = "auto"


Block = Annotated[
    Union[ImageBlock, TextContentBlock, ButtonBlock, ContainerBlock, ProductListBlock, ProductCardBlock],
    Field(discriminator="type"),
]

ContainerBlock.model_rebuild()


PageSection = Annotated[
    Union[
        HeroSection,
        FeatureGridSection,
        CarouselSection,
        TextBlockSection,
        CtaBannerSection,
        BadgeListSection,
        ContainerBlock,
    ],
    Field(discriminator="type"),
]


class GenerateLandingPageResponse(BaseModel):
    sections: list[PageSection]
    # Hex color (e.g. "#c9a227") the vision LLM picked out as the design's
    # dominant/brand color. frontend/src/components/theme/section-renderer.tsx
    # applies it as a --primary CSS custom-property override scoped to the
    # render — retints existing components rather than allowing arbitrary
    # generated CSS. snake_case on the wire like every other field here —
    # no camelCase aliasing in this API, keep it that way.
    accent_color: str | None = None


# Deliberately asks the model for the *schema*, not markup — see the
# module-level comment above PageSection for why. Kept in sync by hand
# with the Pydantic models just above; if a section type gains/loses a
# field, update this prompt too or the model won't know about it.
_VISION_SYSTEM_PROMPT = """You are a UI-to-schema converter. You will be shown an image of a landing \
page design (a screenshot, mockup, or rough sketch). Analyze its visual structure and describe it as \
an ordered list of typed sections, each mapped to one of a fixed set of section types — NOT raw HTML \
or CSS.

Respond with ONLY a single JSON object, no markdown code fences, no commentary, no explanation before \
or after — just the JSON object described below.

Output shape: {"sections": [ <section>, <section>, ... ], "accent_color": "#rrggbb"}

"accent_color" is the single dominant/brand color you see in the design (a button color, a highlight \
color, a background tint — whatever reads as "the brand color") as a hex string. Always include your \
best guess, even a rough one.

Each <section> is one of the following, matching its "type" field exactly:

1. Hero — the top banner/headline area.
{"type": "hero", "eyebrow": "<short label above the headline, optional>", "headline": "<main heading \
text>", "subheadline": "<supporting paragraph, optional>", "ctas": [{"label": "<button text>", "href": \
"#", "variant": "default|outline|secondary|ghost|link"}], "image": {"url": "#", "alt": "<description \
of the photo/image next to the headline, if there is one>"}, "background_color": "#rrggbb (optional)", \
"image_position": "left|right"}. \
Omit "image" entirely if the hero is text-only. Set "background_color" only if the hero's headline sits \
on a distinctly colored band (not the page's plain background) — omit it otherwise. "image_position" \
controls which side "image" renders on relative to the text column — defaults to "right" (text on the \
left, image on the right) if omitted, so only set "image_position": "left" when the photo is actually \
on the LEFT side of the design and the headline/text sit on the right.

IMPORTANT — a colored headline banner immediately followed by a large separate photo (the photo is \
NOT beside the headline, it's a distinct block below/after the banner) is TWO sections, not one: output \
a text-only hero (no "image" field, set "background_color" for the band) followed immediately by a \
Container section (type 7 below) holding a single image block, with "full_bleed": true if that photo \
touches both page edges. Do not try to cram the photo into the hero's own "image" field in this case.

IMPORTANT — the hero type ("hero") always stacks its own headline ABOVE its subheadline in one column \
(with an optional image beside that whole column) — it has no way to put the headline and subheadline \
themselves SIDE BY SIDE as two separate columns. If the design's banner shows the headline text and the \
supporting text in two side-by-side columns (not one above the other) — check specifically whether \
their left edges start at different horizontal positions, roughly matching the columns of a "row" — do \
NOT use "hero" for that banner at all. Instead output it as a Container (type 7): "layout": "row", \
"full_bleed": true if the band touches both page edges, "background_color" set to the band's color, \
with two "text" children (the headline as one, sized larger/bolder; the supporting text as the other, \
smaller) — set "width" on each (see the Container section below) if one column is clearly wider than \
the other, matching whichever of these two patterns actually applies to what you see.

2. Feature grid — a grid/row of cards, icon+text blocks, or similar repeated items.
{"type": "feature-grid", "heading": "<optional>", "subheading": "<optional>", "body": "<optional, \
"split" layout only>", "cta": {"label": "...", "href": "#", "variant": "default"} (optional, "split" \
layout only), "columns": 2|3|4, "layout": "stacked|split", "item_style": "card|plain|list", \
"item_image_position": "top|bottom", "items": [{"title": "<item title>", "description": "<item \
description>", "href": "#", "icon": "<icon key, optional — omit if the item has a real photo instead \
of an icon>", "image": {"url": "#", "alt": "<description of the item's photo, only if it has one — \
omit this whole field if the item uses an icon or has no image>"}, "image_style": "photo|avatar", \
"badge": "<small label like 'New', optional>"}]}. \
"body"/"cta" only apply when "layout" is "split" — a longer supporting paragraph and/or a single \
button in the left column, below the heading/subheading, for a split layout whose left column has \
more than just a heading (e.g. a paragraph of body copy plus a button like "Explore Our Services"). \
Omit both for a left column that's heading-only. \
"item_style" controls each item's visual chrome — NOT every repeated-item design is a card. Use \
"card" (the default — omit this field entirely for the normal case) when items are visually distinct \
boxes with their own border, background, or shadow. Use "plain" when items have NO card chrome at all \
(no border/background/shadow) but are still arranged in the same grid/row as "card" would use — set \
"item_image_position" to "top" (default) or "bottom" depending on whether each item's photo sits above \
or below its text. Use "list" when items are a single vertical column of rows, each row a small photo \
next to its text, usually separated by thin divider lines between rows — "list" ignores "columns" \
entirely, so don't bother setting columns meaningfully when using it. \
How to choose "layout": check whether the heading and the first grid image start at roughly the same \
height, side by side on the same row — a narrow text column (heading/subheading/button, roughly a \
quarter of the row's width) next to a wider multi-image grid (roughly three-quarters of the width) \
filling the rest of that row. If so, use "split". If instead the heading spans the FULL width of the \
section with the grid entirely below it, use "stacked". When genuinely unsure, look again at whether \
the heading's left edge and the grid's top edge line up on the same row before deciding. A second, \
simpler tell for "split": is there a "subheading" sentence positioned to the RIGHT of the main heading \
(same row, not stacked directly underneath it)? A subheading below the heading means "stacked"; a \
subheading beside the heading, with the grid then further right or below, is a strong signal for \
"split" — check heading/subheading's relative position specifically, not just the heading/grid position.

"image_style" (only meaningful when the item has "image" set) — use "avatar" for a testimonial/review \
item whose photo is a small, round profile/headshot photo next to a person's name (renders as a \
circular avatar beside the name, not a big rectangular photo card). Use "photo" (the default — you can \
omit this field entirely for the normal case) for every other photo card, including full-size/rectangular \
product or space photos.

Every image "url" you write should just be "#" — you cannot produce a working image URL, so don't try; \
always write a specific, useful "alt" description instead (what the photo actually shows), since \
that's what gets displayed in place of the real photo.

IMPORTANT — a section mixing testimonial cards with a call-to-action (a heading + button, e.g. "Ready \
to get started?") and/or a stray product photo, all arranged in an irregular staggered/uneven grid \
(cards at different heights, gaps where a card is "missing"), is NOT something to reproduce exactly — \
do not try to match the irregular positions or leave gaps in the grid. Instead split it into TWO \
ordinary sections in order: (1) a feature grid of just the testimonial items (a normal, complete grid — \
"columns" matching however many testimonials there are, "image_style": "avatar" if they have profile \
photos), then (2) a separate "cta-banner" section (type 5) for the call-to-action text/button. Drop a \
lone product photo mixed into that area entirely rather than forcing it in somewhere — approximate, \
don't force an exact layout match here.

3. Carousel — a slideshow/image carousel/rotating banner.
{"type": "carousel", "heading": "<optional>", "slides": [{"url": "#", "alt": "<description of the \
image>"}]}

4. Text block — a single block of heading + paragraph text, optionally with an icon. Not a grid.
{"type": "text-block", "icon": "<icon key, optional>", "heading": "<heading>", "body": "<paragraph \
text>", "align": "left|center", "image": {"url": "#", "alt": "<description>"}, "image_position": \
"left|right", "background_image": {"url": "#", "alt": "<description>"}}. Use "image"+"image_position" \
when a photo sits beside this block's text (side by side, like the hero's image). Use \
"background_image" instead when the heading/body are overlaid directly on top of a full-bleed photo \
(with a dark scrim behind the text) — these two are mutually exclusive, use at most one per text \
block, and omit both entirely if the block is plain text on the page background.

5. CTA banner — a closing call-to-action band with a heading and button(s).
{"type": "cta-banner", "heading": "<heading>", "body": "<optional supporting text>", "ctas": \
[{"label": "...", "href": "#", "variant": "default"}]}

6. Badge list — a row of small tags/pills/labels (e.g. a tech-stack or category list).
{"type": "badge-list", "heading": "<heading>", "badges": ["<label>", "<label>", ...]}

7. Container — a generic row/column/grid layout holding other blocks (image, text, button, or nested \
containers). Use this when a layout doesn't match any of the six section types above — most commonly a \
ROW split into side-by-side columns, each with its own padding, each holding a photo with a caption \
underneath. Check specifically: does a photo+caption pair repeat side by side, each sitting in its own \
padded whitespace with NO card border or card background behind it (if there IS a visible card border/ \
background, that's a feature grid, not a container)? If so, use a container.
{"type": "container", "layout": "row|column|grid", "columns": 2|3|4 (grid only), "gap": \
"none|sm|md|lg", "padding": "none|sm|md|lg", "margin": "none|sm|md|lg" (optional, outside the border — \
omit unless the design clearly shows extra space around the whole block), "background_color": \
"#rrggbb (optional)", "background_image": {"url": "#", "alt": "..."} (optional), "border_color": \
"#rrggbb (optional)", "align": "start|center|end|stretch", "justify": "start|center|end|between" \
(optional, main-axis position within a row/column — omit for the default "start"), "full_bleed": \
true|false, "min_height": "sm|md|lg|xl|screen" (optional), "children": [<block>, ...]}

"min_height" gives a container a guaranteed minimum height regardless of how little text its children \
add up to — omit it for a normal content container (its height should just come from its content). Set \
it specifically for a "column" container that ALSO has "background_image" set — a photo meant to read \
as a substantial block (a full-bleed hero banner with the headline overlaid on a photo, or a smaller \
photo-filled card with a number/title overlaid near the bottom) would otherwise collapse to whatever \
height a couple of lines of text happen to need, far shorter than the actual photo block in the design. \
Use "lg" or "xl" for a page-opening hero-style banner, "sm" for a smaller card (e.g. one cell in a grid \
of photo cards). When both are set, text children are anchored to the BOTTOM of the container \
automatically — no extra field needed for that.

IMPORTANT — a hero-style banner where the headline/subheadline/button are overlaid directly ON TOP of a \
full-bleed photo (not beside it — the photo fills the entire banner, text sits on top near a corner or \
the bottom) is NOT the "hero" section type (type 1) — "hero" only supports a photo BESIDE the text \
column, never behind it. Use a Container instead: "layout": "column", "background_image" set, \
"min_height": "lg" or "xl", "full_bleed": true if it touches both page edges, with "text"/"button" \
children for the headline/subheadline/CTA. Same idea for a repeated grid of cards where each card's \
ENTIRE background is a photo with a number/title/short caption overlaid on it (not a card with a \
separate photo-then-text layout) — use a "grid" container whose children are "column" containers, each \
with its own "background_image" and "min_height": "sm", holding the number/title as "text" children.

Set "full_bleed": true ONLY at the top level (not on a nested container inside "children") when this \
section's photo/background visibly touches BOTH left and right edges of the page with no side margin — \
most content sections have visible whitespace on the sides and should leave "full_bleed" false \
(equivalent to omitting it). An image inside a "full_bleed": true container should almost always use \
"rounded": "none" — a rounded corner on a photo that itself touches the screen edge looks visually \
broken. Reserve "sm"/"lg"/"full" rounding for images that sit inside page whitespace with visible \
margin around them.

IMPORTANT — keep nesting as shallow as possible; deep nesting is where you are most likely to make \
mistakes (duplicated content, wrong nesting level, an accidentally-empty container). Concretely:
- For N EQUAL-width columns side by side (e.g. 3 columns of the same width, each holding its own \
text/image stack) — use ONE container with "layout": "grid", "columns": N, and put each column's \
content as ONE child per column position, NOT a separate "layout": "row" container manually wrapping N \
"layout": "column" children. Grid already handles equal columns without any nesting at all.
- Only use nested containers (a container inside another container's "children") for the specific case \
"layout": "row" holding two or more UNEVEN or independently-styled columns (different widths, different \
padding, or one has a background_color and another doesn't) — the 50/50-photo-columns example above is \
the canonical case. Two levels of nesting (a row containing columns) is the expected maximum; if you \
find yourself nesting a third level deep, stop and reconsider whether "grid" already covers what you're \
trying to build.
- Never output an empty "children": [] — if a container would have no content, omit that container \
entirely instead.

Each <block> inside "children" is one of (all four also accept an optional "width", see below):
- {"type": "image", "image": {"url": "#", "alt": "<description>"}, "aspect_ratio": \
"square|video|portrait|auto", "rounded": "none|sm|lg|full"}. RULE, no exceptions: if this image is the \
child of a "full_bleed": true container, "rounded" MUST be "none" — a rounded corner on a photo that \
itself touches the screen edge always looks broken. Only use "sm"/"lg"/"full" when the image sits \
inside page whitespace with visible margin around it (i.e. NOT full_bleed).
- {"type": "text", "content": "<the actual text>", "size": "sm|base|lg|xl|2xl|3xl", "weight": \
"normal|medium|semibold|bold", "color": "#rrggbb (optional)", "align": "left|center|right"}
- {"type": "button", "label": "<button text>", "href": "#", "background_color": "#rrggbb (optional)", \
"text_color": "#rrggbb (optional)", "border_color": "#rrggbb (optional)"}
- {"type": "container", ...} — a nested container, same shape as above (this is how you build e.g. a \
row containing two column-containers)

"width": "auto|1/4|1/3|1/2|2/3|3/4|full" — ONLY meaningful on a direct child of a "layout": "row" \
container (ignored inside "column"/"grid"). "auto" (the default — omit the field entirely for this, \
the common case) STRETCHES to fill whatever space is left in the row, splitting it evenly between every \
"auto" sibling. Set an explicit fraction instead whenever you want a child to hold a fixed share of the \
row and NOT stretch — two different real cases:
1. That column is clearly NOT the same width as its sibling(s) — e.g. a banner with a wider headline \
column beside a narrower subheadline column, or a heading column noticeably narrower than the content \
beside it. Pick whichever listed fraction looks closest — exact pixel-perfect matching to the source \
design doesn't matter, correctly noticing "this one's wider" and picking a reasonable stop does.
2. The row is conceptually N even columns but you only have real content for FEWER than N of them, and \
the source design shows genuine empty/blank space where the missing column(s) would be (not other \
content stretched to cover the gap). Give EVERY real child the fraction that column would have if all N \
were present (e.g. two real children in a conceptually-3-column row both get "1/3", not "auto") — this \
leaves the remaining space blank instead of stretching your real children to fill it, matching what you \
actually see. Only do this when the source design genuinely shows blank space there — if the visible \
columns actually do span the row's full width, use "auto" instead.

Example — a row split into two even columns, each a photo with a bold caption and a body line beneath \
it, each with breathing-room padding:
{"type": "container", "layout": "row", "gap": "md", "children": [
  {"type": "container", "layout": "column", "padding": "md", "children": [
    {"type": "image", "image": {"url": "#", "alt": "..."}},
    {"type": "text", "content": "...", "weight": "semibold"},
    {"type": "text", "content": "..."}
  ]},
  {"type": "container", "layout": "column", "padding": "md", "children": [
    {"type": "image", "image": {"url": "#", "alt": "..."}},
    {"type": "text", "content": "...", "weight": "semibold"},
    {"type": "text", "content": "..."}
  ]}
]}

A container is also how you represent a large photo with NO text/heading/caption at all (a full-width \
or full-section image used purely for visual impact, common between content sections) — do not skip a \
visually significant photo just because it has no text on/near it. Use a container holding a single \
image block — set "full_bleed": true here too if the photo touches both page edges (this is the most \
common real case for a full_bleed section):
{"type": "container", "layout": "row", "padding": "none", "full_bleed": true, "children": [
  {"type": "image", "image": {"url": "#", "alt": "..."}, "aspect_ratio": "video"}
]}

Valid icon keys — use one if a section clearly has an icon, otherwise omit the field: library, \
messages-square, mouse-pointer-click, shield-check, sparkles, home, info, layout-dashboard, quote, \
rocket, star, zap, users, file-text, image, bar-chart, settings. Use "quote" for testimonials/reviews \
— not bar-chart, settings, or layout-dashboard, which don't fit that content.

Rules:
- Output sections in the same top-to-bottom order they appear in the image.
- Use "#" for any href/url you cannot determine from the image.
- Approximate — you do not need to reproduce the design pixel-for-pixel. Identify the closest \
matching section type and its visible content (use real text from the image where legible, otherwise \
a reasonable placeholder).
- If a hero or feature item shows an actual photo/illustration (not just an icon), include its \
"image" field with a real "alt" description — don't drop it just because you can't provide a URL.
- Do not skip a visually significant photo section just because it has no heading/caption/text near \
it — represent it as a Container holding a single image block (see the example above) rather than \
omitting it from "sections" entirely.
- Always include your best-guess "accent_color" — don't omit it.
- Do not invent section types outside the seven listed above (or block types outside the four listed \
under Container).
- Prefer the specific section types (1-6) over Container whenever one of them already fits — Container \
exists for row/column layouts none of the others can express, not as a default choice.
- Output ONLY the JSON object — no ```json fences, no prose before or after it."""


_PAGE_SECTION_ADAPTER: TypeAdapter[PageSection] = TypeAdapter(PageSection)


# Section/block types the model has been caught emitting instead of the
# real shape ("type": "container", "layout": "row"|"column"|"grid") —
# added 2026-08-07 after a real generation failure showed "type": "row"
# as a bare top-level section. The system prompt already warns against
# this exact confusion in several places (see the "IMPORTANT — a
# hero-style banner..." and "Prefer the specific section types..."
# passages in _VISION_SYSTEM_PROMPT above) and the model still did it —
# worth absorbing defensively rather than trusting prompt text alone to
# eliminate it.
_LAYOUT_TYPE_ALIASES = {"row", "column", "grid"}


def _normalize_container_type_aliases(node: object) -> object:
    """Recursively rewrites any dict with `"type": "row"|"column"|"grid"`
    into `{"type": "container", "layout": <that value>, ...rest}` — the
    schema's real Container shape — before Pydantic ever sees it. Walks
    into every nested dict/list (not just top-level sections) since the
    same mislabeling can just as easily show up inside a container's own
    `"children"` array, which `_coerce_sections` below has no separate
    per-item salvage pass for (unlike feature-grid items) — Pydantic
    validates nested `Block`s as one atomic unit, so a single mislabeled
    nested child would otherwise fail the whole parent container, not
    just that one child. Non-dict/list values pass through unchanged;
    a dict already using "container" (or missing "type" entirely, e.g. a
    `ThemeImage`/`FeatureItem`) is untouched."""
    if isinstance(node, dict):
        normalized = {key: _normalize_container_type_aliases(value) for key, value in node.items()}
        if normalized.get("type") in _LAYOUT_TYPE_ALIASES:
            layout = normalized.pop("type")
            normalized = {"type": "container", "layout": layout, **normalized}
        return normalized
    if isinstance(node, list):
        return [_normalize_container_type_aliases(item) for item in node]
    return node


def _coerce_sections(raw_sections: list) -> list[PageSection]:
    """Validates each section — and each feature-grid item — on its own,
    dropping only the pieces that don't fit the schema instead of failing
    the whole response over one bad field.

    A long, content-rich page asks qwen3.6 for a lot of structured JSON in
    one shot (a hero, several feature grids, testimonials, a CTA banner —
    easily a dozen-plus items), and it doesn't always finish every item
    correctly (a missing `href`, or occasionally a whole item's fields
    smeared across two entries). Throwing away an otherwise-good 90%
    generation because of a couple of malformed cards is worse than
    quietly dropping just those cards — same principle as
    SectionRenderer's `default: return null` on the frontend for an
    unrecognized section type.
    """
    sections: list[PageSection] = []

    for raw in raw_sections:
        if not isinstance(raw, dict):
            continue

        raw = _normalize_container_type_aliases(raw)

        if raw.get("type") == "feature-grid" and isinstance(raw.get("items"), list):
            valid_items = []
            for raw_item in raw["items"]:
                try:
                    valid_items.append(FeatureItem(**raw_item))
                except (ValidationError, TypeError):
                    continue
            if not valid_items:
                continue  # nothing salvageable in this section
            raw = {**raw, "items": valid_items}

        try:
            sections.append(_PAGE_SECTION_ADAPTER.validate_python(raw))
        except ValidationError:
            continue

    return sections


@router.post("/agent/landing-page/generate", response_model=GenerateLandingPageResponse)
async def generate_landing_page(
    req: GenerateLandingPageRequest, db: Session = Depends(get_db)
) -> GenerateLandingPageResponse:
    """Vision LLM: turn an uploaded design mockup into an ordered list of
    page sections (see PageSection above), not raw markup. See
    _generate_landing_page_sections for the actual implementation —
    this route just strips an optional data-URI prefix first, same as
    every other base64-image-accepting route in this codebase."""
    image_b64 = req.design_image_base64
    if image_b64.strip().lower().startswith("data:") and "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    return await _generate_landing_page_sections(db, image_b64, req.notes)


class GenerateLandingPageFromUrlRequest(BaseModel):
    image_url: str
    notes: str = ""


@router.post("/agent/landing-page/generate-from-url", response_model=GenerateLandingPageResponse)
async def generate_landing_page_from_url(
    req: GenerateLandingPageFromUrlRequest, db: Session = Depends(get_db)
) -> GenerateLandingPageResponse:
    """Same generation as generate_landing_page above, but takes an
    already-uploaded image's URL instead of raw base64 — built
    specifically for owner-agent's generate_landing_page tool (see
    owner-agent/tools.py), since asking the model to reproduce a whole
    image as base64 inside its own tool-call JSON is neither reliable
    nor something a text-generation model should be doing at all. The
    owner uploads a design image via the dashboard's media library (or
    CTE's ImageFieldEditor "Upload" tab) first, gets a URL back, then
    tells owner-agent to use it — resolve_media_local_path
    (apis/media.py) does the same paranoid URL-to-local-file resolution
    chat_attachments.resolve_local_path already does for chat
    attachments before this ever touches disk."""
    from apis.media import resolve_media_local_path

    local_path = resolve_media_local_path(req.image_url)
    if local_path is None:
        raise HTTPException(
            status_code=400,
            detail="image_url must point at an image already uploaded to this app's own media library "
            "(dashboard → Document manager/media, or CTE's Upload tab) — got a URL that doesn't resolve "
            "to a real file there.",
        )
    image_b64 = base64.b64encode(local_path.read_bytes()).decode("ascii")
    return await _generate_landing_page_sections(db, image_b64, req.notes)


async def _generate_landing_page_sections(db: Session, image_b64: str, notes: str) -> GenerateLandingPageResponse:
    """Sends the image + a schema-describing prompt to whatever vision-
    capable model the owner has selected (Ollama, a custom
    OpenAI-compatible endpoint, or a configured cloud provider — see
    resolve_vision_provider, apis/model_settings.py) via the shared
    `ChatProvider.chat()` abstraction, same one backend/apis/chat.py uses
    for plain text, just with an image content part added (see
    providers/base.py's ChatProvider docstring for the shape). The
    model's job is to *pick* which section types apply and fill in their
    content — never to emit HTML/CSS — so the result renders through the
    same reusable components (frontend/src/components/theme/) as the
    hand-authored default template, safely and on-brand, with no
    dangerouslySetInnerHTML. `image_b64` must already have any data-URI
    prefix stripped — both callers above handle that themselves."""
    vision = resolve_vision_provider(db)

    user_text = "Convert this landing page design into the section JSON described in your instructions."
    if notes:
        user_text += f" Additional notes from the site owner: {notes}"

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            ],
        },
    ]

    try:
        # Vision + a full page's worth of structured JSON is slow — much
        # slower than chat.py's plain-text replies. Every provider's
        # chat() now budgets 600s for exactly this reason (was previously
        # a dedicated timeout on this route's own httpx call) — see
        # providers/custom.py's comment for the real timing data behind
        # that number.
        # Deliberately NOT capping output tokens beyond each provider's
        # own default: tried a 4096 cap here once and it backfired —
        # qwen3.6 is a "thinking" model that burns a large, variable
        # number of tokens on internal reasoning before it starts writing
        # the actual JSON answer, and 4096 was consumed entirely by that
        # reasoning, leaving zero budget for the content (finish_reason:
        # "length", empty message.content).
        raw_content = await vision.chat(messages, system=_VISION_SYSTEM_PROMPT, json_mode=True)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.TimeoutException:
        # httpx.TimeoutException's str() is empty by default — a blank
        # error message here would look like a broken feature rather than
        # what it actually is. A cold model load (a large local model
        # llama.cpp/Ollama hasn't loaded into memory yet) can easily blow
        # past 240s on top of the generation itself — confirmed for real
        # this session: the model finished loading seconds after this
        # timeout fired, and a retry succeeded immediately.
        raise HTTPException(
            status_code=504,
            detail=f"{vision.name} (model={getattr(vision, 'model', '?')}) didn't respond within the "
            "time budget — if this is a large local model being used for the first time, it may still "
            "be loading. Try again in a moment.",
        )
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach {vision.name} (model={getattr(vision, 'model', '?')}): {e}",
        )

    try:
        parsed = parse_lenient_json(raw_content)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))

    raw_sections = parsed.get("sections")
    if not isinstance(raw_sections, list):
        raise HTTPException(
            status_code=502,
            detail=f"Model output had no 'sections' array. Raw output: {raw_content[:2000]}",
        )

    sections = _coerce_sections(raw_sections)
    if not sections:
        raise HTTPException(
            status_code=502,
            detail=f"None of the model's sections matched the page-section schema. Raw output: {raw_content[:2000]}",
        )

    accent_color = parsed.get("accent_color")
    return GenerateLandingPageResponse(
        sections=sections,
        accent_color=accent_color if isinstance(accent_color, str) else None,
    )


# A single, fixed slug rather than a picker like PageGeneratorPanel's —
# there's exactly one canonical GEO/SEO page for a site, not an arbitrary
# number of generated pages, so there's no "which slug" decision for the
# admin to make. Editing/deleting it both go through the already-generic
# page endpoints (apis/pages.py) — nothing GEO-specific needed there.
GEO_PAGE_SLUG = "seo"

# Reuses PageSection's schema and _coerce_sections/parse_lenient_json
# below — same validation/leniency infrastructure as generate_landing_page,
# just fed by ingested document text instead of a design image, and via
# the plain ChatProvider abstraction (resolve_chat_provider) rather than a
# hardcoded Ollama vision call, since this is ordinary text generation, not
# vision. A separate, shorter prompt rather than sharing _VISION_SYSTEM_
# PROMPT's text: the two have genuinely different inputs (an image vs raw
# document text) and this one deliberately excludes every image-related
# instruction (there is no photo to describe) — some duplication with the
# vision prompt's section-shape descriptions is the accepted cost of
# keeping each prompt self-contained and easy to reason about on its own.
_GEO_SYSTEM_PROMPT = """You are given raw text extracted from a company's own documents (product/service \
descriptions, policies, background info — not a design image). Synthesize it into a clear, factual \
company-profile page meant to be read by search engines and AI systems answering questions about this \
company on a visitor's behalf, not primarily by a human scanning quickly — prioritize complete, accurate \
coverage of what the company does over visual variety or marketing flourish. Do not invent facts not \
present in the source text.

Respond with ONLY a single JSON object, no markdown code fences, no commentary — just the JSON object \
described below.

Output shape: {"sections": [ <section>, <section>, ... ], "accent_color": null}
Always set "accent_color" to null — there is no design to pick a brand color from here.

There are no photos available — never include an "image", "background_image", or "icon" field on any \
section or item below; omit those fields entirely everywhere they'd normally appear.

Each <section> is one of the following, matching its "type" field exactly:

1. Hero — a brief, factual opening: what the company is/does in one or two sentences.
{"type": "hero", "headline": "<company name or a one-line summary>", "subheadline": "<a factual \
sentence expanding on it, optional>"}

2. Text block — a heading + paragraph covering one topic in depth (e.g. "About Us", "Our History", \
"Our Approach"). Use one of these per distinct topic rather than cramming everything into one section.
{"type": "text-block", "heading": "<heading>", "body": "<paragraph text — can be several sentences, be \
thorough>", "align": "left"}

3. Feature grid — for a list of distinct offerings (products, services, or similar repeated items). \
Always set "item_style": "list" and omit "image" from every item — there are no photos.
{"type": "feature-grid", "heading": "<optional>", "item_style": "list", "items": [{"title": "<item \
name>", "description": "<factual description>", "href": "#"}]}

4. Badge list — a row of short factual tags/labels (e.g. certifications, service areas, technologies used).
{"type": "badge-list", "heading": "<heading>", "badges": ["<label>", ...]}

5. CTA banner — closing contact/next-step information, if the source text mentions how to get in touch.
{"type": "cta-banner", "heading": "<heading, e.g. 'Get in Touch'>", "body": "<contact info or next \
steps mentioned in the source>", "ctas": [{"label": "Contact us", "href": "#"}]}

Rules:
- Cover the source material thoroughly — this page's whole purpose is being a complete, crawlable \
reference, not a short teaser. Use multiple sections (several text-blocks, a feature grid) rather than \
one short block, when the source material supports it.
- Every "href" should be "#" — you cannot produce a working URL.
- If the source text is too thin to produce anything meaningful, still output your best attempt rather \
than an empty "sections" array.
- Output ONLY the JSON object — no ```json fences, no prose before or after it."""


def _gather_ready_document_text(db: Session, char_budget: int = 16000) -> tuple[str, int]:
    """Concatenates every ready-to-use ingested document's full text (its
    chunks, already ordered by chunk_index via the ORM relationship) up to
    a fixed character budget, stopping before exceeding it rather than
    truncating mid-document. A simple fixed cap, not real
    summarization/retrieval — appropriate for a company-profile page,
    where "everything currently ingested" is realistically a handful of
    documents for this project's scale, not a large corpus needing
    ranking. Returns (concatenated_text, documents_included_count)."""
    documents = db.query(Document).filter(Document.status == "ready").order_by(Document.id).all()
    parts: list[str] = []
    total_len = 0
    included = 0
    for doc in documents:
        full_text = "\n".join(chunk.content for chunk in doc.chunks).strip()
        if not full_text:
            continue
        block = f"### {doc.filename}\n{full_text}\n"
        if included > 0 and total_len + len(block) > char_budget:
            break
        parts.append(block)
        total_len += len(block)
        included += 1
    return "\n".join(parts), included


class GenerateGeoPageResponse(BaseModel):
    slug: str
    sections: list[PageSection]
    document_count: int
    version_id: int


@router.post("/agent/geo-page/generate", response_model=GenerateGeoPageResponse)
async def generate_geo_page(db: Session = Depends(get_db)) -> GenerateGeoPageResponse:
    """Text LLM: turn every ready ingested RAG document into a factual
    company-profile page, saved directly to the fixed GEO_PAGE_SLUG (no
    separate "save" step, unlike PageGeneratorPanel — there's only ever
    one of these, so there's no slug to choose). Meant for search engines
    and AI systems reading about this company on a visitor's behalf, not
    primarily for human visitors — see the root AGENTS.md's GEO section
    for the full rationale. Editing/deleting this page afterward reuses
    the already-generic /editor (CTE) and DELETE /agent/pages/{slug}
    endpoints — nothing else needed for those two actions."""
    doc_text, doc_count = _gather_ready_document_text(db)
    if doc_count == 0:
        raise HTTPException(
            status_code=400,
            detail="No ingested documents to generate from — upload at least one document "
            "(Agent console → Documents) and wait for it to finish processing first.",
        )

    messages = [
        {
            "role": "user",
            "content": f"Here is the source document text:\n\n{doc_text}",
        }
    ]

    try:
        provider = resolve_chat_provider(db)
        raw_content = await provider.chat(messages, system=_GEO_SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    try:
        parsed = parse_lenient_json(raw_content)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))

    raw_sections = parsed.get("sections")
    if not isinstance(raw_sections, list):
        raise HTTPException(
            status_code=502,
            detail=f"Model output had no 'sections' array. Raw output: {raw_content[:2000]}",
        )

    sections = _coerce_sections(raw_sections)
    if not sections:
        raise HTTPException(
            status_code=502,
            detail=f"None of the model's sections matched the page-section schema. Raw output: {raw_content[:2000]}",
        )

    content = GenerateLandingPageResponse(sections=sections, accent_color=None).model_dump(mode="json")
    page = _get_or_create_page(db, GEO_PAGE_SLUG)
    version = PageVersion(page_id=page.id, content=content, note=f"Generated from {doc_count} document(s)")
    db.add(version)
    db.commit()
    db.refresh(version)

    return GenerateGeoPageResponse(
        slug=GEO_PAGE_SLUG,
        sections=sections,
        document_count=doc_count,
        version_id=version.id,
    )


class IntegrationStatus(BaseModel):
    available: bool
    detail: str | None = None


class IntegrationsResponse(BaseModel):
    comfyui: IntegrationStatus
    # Added 2026-08-18 alongside image-gen becoming a provider capability
    # (see apis/model_settings.py) — openai/gemini image-gen availability
    # just reflects whether their API key is configured, same as every
    # other cloud-provider "configured" check in this codebase.
    openai_image: IntegrationStatus
    gemini_image: IntegrationStatus


@router.get("/agent/integrations", response_model=IntegrationsResponse)
async def get_integrations(db: Session = Depends(get_db)) -> IntegrationsResponse:
    """Lightweight reachability/configured check for the services image
    generation actually needs. Read-only, no side effects. Lets the
    dashboard gray out "Generate poster" up front with a clear reason
    instead of only discovering it's unreachable after clicking "Try it"
    and getting a generic 502. Not meant to grow into a general health-
    check system — add an entry here only when a real capability actually
    depends on that service being reachable.

    Reuses apis/model_settings.py's _list_image_providers (same
    reachability probe the model picker itself uses) rather than
    duplicating the check — comfyui's result reflects whatever address is
    *currently configured* (AppSettings.image_comfyui_url or the env-var
    default), not always the env-var one."""
    options = {opt.provider: opt for opt in await _list_image_providers(db)}
    return IntegrationsResponse(
        comfyui=IntegrationStatus(available=options["comfyui"].selectable, detail=options["comfyui"].note),
        openai_image=IntegrationStatus(
            available=options["openai"].selectable, detail=options["openai"].note
        ),
        gemini_image=IntegrationStatus(
            available=options["gemini"].selectable, detail=options["gemini"].note
        ),
    )


class GeneratePosterRequest(BaseModel):
    prompt: str
    overlay_text: str = ""


class GeneratePosterResponse(BaseModel):
    image_url: str


@router.post("/agent/poster/generate", response_model=GeneratePosterResponse)
async def generate_poster(req: GeneratePosterRequest, db: Session = Depends(get_db)) -> GeneratePosterResponse:
    """Generate a text+image poster via whatever image-gen provider the
    owner has picked (ComfyUI, OpenAI/DALL·E, or Gemini/Imagen — see
    resolve_image_provider, apis/model_settings.py), then (if
    `overlay_text` was given) composite real rendered text onto the
    result. Deliberately a direct, deterministic call with no LLM/agent
    reasoning involved — matches the "structured admin request, not a
    chatbot command" direction settled on in the root AGENTS.md, and
    keeps this out of the agent-isolation problem entirely (see that
    file's Phase 6 note) since there's no agent loop here to isolate."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must not be empty")

    provider = resolve_image_provider(db)
    if provider.name == "comfyui":
        # Best-effort, opt-in (see resource_broker.py) — OpenAI/Gemini
        # image-gen have no local footprint to coordinate around.
        await maybe_release_llm_memory(db, provider.base_url)
    try:
        image_url, image_bytes = await provider.generate(req.prompt)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach {provider.name}: {e}")

    if req.overlay_text.strip():
        # ImageProvider.generate() always returns the raw bytes alongside
        # the URL (see providers/base.py's ImageProvider docstring) — no
        # more provider-specific "fetch it back" step needed here.
        image_b64 = base64.b64encode(image_bytes).decode("ascii")
        # background=True (unlike TextOverlayRequest's own default of
        # False) — a semi-transparent box behind the text is the sensible
        # poster default; without it, text over a busy generated photo is
        # often hard to read.
        overlay_result = await add_text_overlay(
            TextOverlayRequest(image_base64=image_b64, text=req.overlay_text, background=True)
        )
        image_url = overlay_result["url"]

    return GeneratePosterResponse(image_url=image_url)


class CrmEntryRequest(BaseModel):
    contact_email: str
    contact_name: str | None = None
    contact_phone: str | None = None
    summary: str
    tags: list[str] = []
    # Free-form like `tags` (not a DB enum — see models.CrmEntry's doc
    # comment), but apis/chat.py's automatic capture and CrmPanel's
    # manual-entry form both stick to appointment/quote/claim/inquiry so
    # the leads view below can actually group on it.
    category: str | None = None
    # Set by apis/chat.py's automatic capture when the visitor attached a
    # file via POST /chat/upload — see models.CrmEntry's doc comment. No
    # manual-entry UI for this yet (CrmPanel's own form has no file
    # picker), so this is null for hand-entered rows.
    attachment_url: str | None = None


class CrmEntryResponse(BaseModel):
    crm_id: str
    contact_email: str
    contact_name: str | None
    contact_phone: str | None
    summary: str
    tags: list[str]
    category: str | None
    status: str
    attachment_url: str | None
    analysis_notes: str | None
    created_at: datetime
    # Owner-configurable structured collection (2026-08-19) — see
    # models.py's IntentSchema/CrmEntry docstrings. intent_schema_id is
    # null for entries captured the old fixed-category way.
    intent_schema_id: int | None
    collected_fields: dict


def _crm_entry_response(entry: CrmEntry) -> CrmEntryResponse:
    return CrmEntryResponse(
        crm_id=str(entry.id),
        contact_email=entry.contact_email,
        contact_name=entry.contact_name,
        contact_phone=entry.contact_phone,
        summary=entry.summary,
        tags=entry.tags,
        category=entry.category,
        status=entry.status,
        attachment_url=entry.attachment_url,
        analysis_notes=entry.analysis_notes,
        created_at=entry.created_at,
        intent_schema_id=entry.intent_schema_id,
        collected_fields=entry.collected_fields,
    )


@router.post("/agent/crm/entries", response_model=CrmEntryResponse)
def create_crm_entry(req: CrmEntryRequest, db: Session = Depends(get_db)) -> CrmEntryResponse:
    """Store a captured lead/inquiry — real as of 2026-08-06. No
    third-party CRM account/API key exists for this project (unlike the
    AI providers, which have a small number of well-known, roughly
    standardized APIs to code a generic client against, CRM vendors are
    too fragmented to pick one without a real account to test against),
    so this is a genuine internal record, not a faked third-party push —
    see `models.CrmEntry`'s doc comment for the full reasoning. `crm_id`
    in the response is just the new row's own id, stringified — there's
    no external system assigning a different identifier."""
    entry = CrmEntry(
        contact_email=req.contact_email,
        contact_name=req.contact_name,
        contact_phone=req.contact_phone,
        summary=req.summary,
        tags=req.tags,
        category=req.category,
        attachment_url=req.attachment_url,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _crm_entry_response(entry)


@router.get("/agent/crm/entries", response_model=list[CrmEntryResponse])
def list_crm_entries(db: Session = Depends(get_db)) -> list[CrmEntryResponse]:
    """Most-recent-first — lets an admin see what's actually been
    captured so far, the same "not just a black-box POST" bar every other
    real capability in this file already meets (DocumentManager,
    PageManager, ...)."""
    entries = db.query(CrmEntry).order_by(CrmEntry.created_at.desc()).all()
    return [_crm_entry_response(e) for e in entries]


@router.delete("/agent/crm/entries/{entry_id}", status_code=204)
def delete_crm_entry(entry_id: int, db: Session = Depends(get_db)) -> None:
    """Removes a captured lead entirely — no undo, unlike the status
    `PATCH` below. Was a real gap until 2026-08-08: there was no way to
    clear out a spam/junk/test entry short of a direct DB query. Also
    best-effort deletes the entry's own attached file, if it had one —
    deleting "this lead and its evidence" together is the expected
    meaning of removing a lead, not a leak `cleanup_orphaned_uploads`
    would otherwise have to catch later."""
    entry = db.query(CrmEntry).filter(CrmEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="CRM entry not found")

    attachment_path = chat_attachments.resolve_local_path(entry.attachment_url) if entry.attachment_url else None
    db.delete(entry)
    db.commit()
    if attachment_path is not None:
        chat_attachments.delete_file(attachment_path)


class CrmStatusUpdateRequest(BaseModel):
    # Was Literal["new", "contacted", "closed"] — widened 2026-08-19
    # alongside IntentView/`manage_review_queue` (see models.py's
    # IntentView docstring): a queue's own `status_options` is now the
    # real source of truth for what's valid for entries under its
    # schema (e.g. "approved"/"pending"/"rejected"), enforced by the
    # frontend's Select, not a closed server-side enum — CrmEntry.status
    # was already a plain String(16) at the DB level, so this was purely
    # an API-level constraint that would have rejected a real queue's
    # own statuses.
    status: str


@router.patch("/agent/crm/entries/{entry_id}/status", response_model=CrmEntryResponse)
def update_crm_entry_status(
    entry_id: int, req: CrmStatusUpdateRequest, db: Session = Depends(get_db)
) -> CrmEntryResponse:
    """The one mutation a captured lead supports — moving it through
    new -> contacted -> closed as admin/owner follow up. Nothing else
    about an entry is editable after capture."""
    entry = db.query(CrmEntry).filter(CrmEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="CRM entry not found")
    entry.status = req.status
    db.commit()
    db.refresh(entry)
    return _crm_entry_response(entry)


class CrmScanRequest(BaseModel):
    # Freeform, owner-authored — e.g. "extract the policy number and
    # incident date" for an insurance claim photo. Unlike apis/chat.py's
    # automatic extraction (a fixed name/phone/email/intent schema), this
    # is deliberately open-ended: the owner decides what's worth pulling
    # out of any given attachment, not just the fields this app already
    # models.
    instructions: str


@router.post("/agent/crm/entries/{entry_id}/scan", response_model=CrmEntryResponse)
async def scan_crm_entry_attachment(
    entry_id: int, req: CrmScanRequest, db: Session = Depends(get_db)
) -> CrmEntryResponse:
    """Owner-triggered deep scan of a captured lead's attached file — also
    reachable as the owner-agent's `scan_crm_attachment` tool (see
    owner-agent/tools.py). Distinct from apis/chat.py's automatic
    extraction: that one runs unconditionally with a fixed schema the
    moment a visitor attaches something; this one runs on demand, once,
    with whatever the admin/owner actually asked for, and appends its
    answer to `analysis_notes` (timestamped, never overwriting an earlier
    scan) rather than silently dropping a failure — see
    chat_attachments.scan_with_instructions's docstring for why the two
    functions have opposite failure postures."""
    entry = db.query(CrmEntry).filter(CrmEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="CRM entry not found")
    if not entry.attachment_url:
        raise HTTPException(status_code=400, detail="This entry has no attached file to scan.")

    file_path = chat_attachments.resolve_local_path(entry.attachment_url)
    if file_path is None:
        raise HTTPException(status_code=404, detail="The attached file could not be found on disk.")

    try:
        result = await chat_attachments.scan_with_instructions(db, file_path, req.instructions)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Analysis provider request failed: {e}")
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))

    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    note = f"[{timestamp}] Scan ({req.instructions.strip()}):\n{result.strip()}"
    entry.analysis_notes = f"{entry.analysis_notes}\n\n{note}" if entry.analysis_notes else note
    db.commit()
    db.refresh(entry)
    return _crm_entry_response(entry)


class CleanupUploadsRequest(BaseModel):
    # A visitor uploads, then (normally) sends the chat turn referencing
    # it within seconds — but nothing enforces that. This is how long an
    # unreferenced file gets to "prove" it's actually attached to
    # something before it's considered abandoned, so a slow typer never
    # has their in-flight upload deleted out from under them.
    older_than_hours: int = chat_attachments.DEFAULT_ORPHAN_AGE_HOURS
    # True previews what would be deleted (freed_bytes/deleted_files still
    # populated) without touching disk — a "let me see first" pass.
    dry_run: bool = False


class CleanupUploadsResponse(BaseModel):
    scanned: int
    orphaned: int
    deleted: int
    freed_bytes: int
    deleted_files: list[str]


@router.post("/agent/storage/cleanup-uploads", response_model=CleanupUploadsResponse)
def cleanup_uploads(req: CleanupUploadsRequest, db: Session = Depends(get_db)) -> CleanupUploadsResponse:
    """Removes chat-upload files nothing in this app references anymore —
    a visitor who attached a photo and then never sent (or sent, but it
    never became a real lead) a turn referencing it leaves exactly this
    kind of orphan behind, with nothing else cleaning it up on its own.
    See chat_attachments.cleanup_orphaned_uploads for the "referenced"
    definition (checks both CrmEntry.attachment_url and any ChatMessage
    transcript, not just captured leads) and why there's an age floor.
    On-demand only, same as every other capability in this file — no
    scheduler/cron exists in this stack to run it automatically."""
    result = chat_attachments.cleanup_orphaned_uploads(
        db, older_than_hours=req.older_than_hours, dry_run=req.dry_run
    )
    return CleanupUploadsResponse(**result)


class ReportRequest(BaseModel):
    # Only one report exists today — a Literal (not a bare `str`) so an
    # unsupported value 422s immediately instead of silently returning an
    # empty report. Extend this union, not the meaning of "chat-volume"
    # itself, when a second report type ships.
    report_type: Literal["chat-volume"] = "chat-volume"
    start_date: date
    end_date: date


class ReportDayPoint(BaseModel):
    date: date
    session_count: int
    message_count: int


class ReportResponse(BaseModel):
    report_type: Literal["chat-volume"]
    start_date: date
    end_date: date
    points: list[ReportDayPoint]


@router.post("/agent/reports/generate", response_model=ReportResponse)
def generate_report(req: ReportRequest, db: Session = Depends(get_db)) -> ReportResponse:
    """Real as of 2026-08-06 — returns structured per-day data (new chat
    sessions, chat messages) for the frontend to chart directly, not a
    `report_url` pointing at a generated file: this project has no
    static-report-file generation infrastructure, and the actual
    underlying data (`ChatSession`/`ChatMessage`, see "Visitor
    conversation persistence" in the root AGENTS.md) is already
    relational — handing back numbers for the frontend's own chart
    library to render is both simpler and more honest about what's
    actually available than inventing a file/URL step with nothing
    behind it.

    Deliberately scoped to chat volume only — the request contract's
    original docstring also mentioned "RAG query trends," but whether a
    given `/api/chat` turn actually used retrieved context was never
    persisted (`ChatMessage` stores the reply text, not `sources`), so
    that series genuinely can't be computed from data this project has
    today. Extending this later means adding that column to `ChatMessage`
    first, not just adding a case here."""
    if req.end_date < req.start_date:
        raise HTTPException(status_code=422, detail="end_date must not be before start_date")

    day = func.date(ChatSession.created_at)
    session_rows = dict(
        db.query(day, func.count(ChatSession.id))
        .filter(func.date(ChatSession.created_at).between(req.start_date, req.end_date))
        .group_by(day)
        .all()
    )
    msg_day = func.date(ChatMessage.created_at)
    message_rows = dict(
        db.query(msg_day, func.count(ChatMessage.id))
        .filter(func.date(ChatMessage.created_at).between(req.start_date, req.end_date))
        .group_by(msg_day)
        .all()
    )

    points = []
    current = req.start_date
    while current <= req.end_date:
        points.append(
            ReportDayPoint(
                date=current,
                session_count=session_rows.get(current, 0),
                message_count=message_rows.get(current, 0),
            )
        )
        current += timedelta(days=1)

    return ReportResponse(report_type=req.report_type, start_date=req.start_date, end_date=req.end_date, points=points)


class ChatCompletionRequest(BaseModel):
    messages: list[dict]
    system: str | None = None
    json_mode: bool = False


class ChatCompletionResponse(BaseModel):
    reply: str


@router.post("/agent/chat-completion", response_model=ChatCompletionResponse)
async def chat_completion(req: ChatCompletionRequest, db: Session = Depends(get_db)) -> ChatCompletionResponse:
    """Thin proxy onto resolve_chat_provider(db).chat() — the one place
    the isolated owner-agent service (own container, no DB access — see
    the root AGENTS.md's "Owner agent" section) can reach the owner's
    actual chat provider/model pick (AppSettings, apis/model_settings.py)
    instead of being hardcoded to one vendor. Added 2026-08-18: the
    owner's own words on why — "this project isn't about making choices
    for the user, it's about giving the user choices," which a
    Ollama-only owner-agent brain contradicted.

    Same admin/owner gate as every other route in this router;
    owner-agent's own deps.py already requires owner specifically before
    ever forwarding the caller's bearer token here — defense in depth,
    same pattern its 8 tool calls (tools.py) already use, not a new
    trust boundary."""
    provider = resolve_chat_provider(db)
    try:
        reply = await provider.chat(req.messages, system=req.system, json_mode=req.json_mode)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")
    return ChatCompletionResponse(reply=reply)


class LogOwnerAgentRunRequest(BaseModel):
    command: str
    final_answer: str
    stopped_reason: str
    # Same shape as main.py's own StepResponse (owner-agent), passed
    # through as-is — see models.py's OwnerAgentRun.steps comment for why
    # this isn't normalized into its own rows.
    steps: list[dict] = []


class OwnerAgentRunSummary(BaseModel):
    id: int
    owner_email: str
    command: str
    final_answer: str
    stopped_reason: str
    steps: list[dict]
    created_at: datetime


@router.post("/agent/owner-agent/runs", response_model=OwnerAgentRunSummary)
def log_owner_agent_run(
    req: LogOwnerAgentRunRequest,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> OwnerAgentRunSummary:
    """Persists one completed owner-agent run — called by owner-agent's
    own main.py right after a run finishes (see models.py's
    OwnerAgentRun docstring for why this exists alongside, not instead
    of, owner-agent/logging_.py's per-step JSONL file). owner_email comes
    from the same forwarded bearer token every owner-agent tool call
    already carries, not a client-supplied field — this route sits
    behind this router's own admin/owner gate, and owner-agent's deps.py
    additionally requires owner specifically before it ever gets here."""
    row = OwnerAgentRun(
        owner_email=current.email or "unknown",
        command=req.command,
        final_answer=req.final_answer,
        stopped_reason=req.stopped_reason,
        steps=req.steps,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return OwnerAgentRunSummary(
        id=row.id,
        owner_email=row.owner_email,
        command=row.command,
        final_answer=row.final_answer,
        stopped_reason=row.stopped_reason,
        steps=row.steps,
        created_at=row.created_at,
    )


@router.get("/agent/owner-agent/runs", response_model=list[OwnerAgentRunSummary])
def list_owner_agent_runs(db: Session = Depends(get_db), limit: int = 50) -> list[OwnerAgentRunSummary]:
    """Most-recent-first — what makes owner-agent's history actually
    queryable (the JSONL file is greppable from a shell on the host,
    this is queryable from the dashboard/API without one)."""
    rows = db.execute(select(OwnerAgentRun).order_by(OwnerAgentRun.created_at.desc()).limit(limit)).scalars().all()
    return [
        OwnerAgentRunSummary(
            id=r.id,
            owner_email=r.owner_email,
            command=r.command,
            final_answer=r.final_answer,
            stopped_reason=r.stopped_reason,
            steps=r.steps,
            created_at=r.created_at,
        )
        for r in rows
    ]
