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
import json
import os
import re
from datetime import date, datetime, timedelta
from typing import Annotated, Literal, Union

import httpx
from fastapi import APIRouter, Depends, HTTPException
from json_repair import repair_json
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy import func
from sqlalchemy.orm import Session

from apis.api import (
    COMFYUI_PUBLIC_URL,
    COMFYUI_URL,
    TextOverlayRequest,
    _build_payload_txt2img,
    add_text_overlay,
    wait_for_completion,
)
from apis.deps import Role, require_role
from apis.model_settings import resolve_chat_provider, resolve_vision_model
from apis.pages import _get_or_create_page
from db import get_db
from models import ChatMessage, ChatSession, CrmEntry, Document, PageVersion
from providers.base import ProviderNotConfigured

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1")
# Which model actually gets used is resolved per-request now (see
# resolve_vision_model, apis/model_settings.py) — an owner can pick any
# vision-capable Ollama model from the dashboard, persisted globally. It
# falls back to model_settings.DEFAULT_VISION_MODEL when nothing's been
# explicitly chosen. Vision generation only works via Ollama today (see
# model_settings.py's module docstring) — a non-"ollama" resolved provider
# is a 501, not silently ignored.


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
    # Forward reference to `Block`, defined just below — Pydantic can't
    # resolve this until ContainerBlock.model_rebuild() runs after `Block`
    # actually exists (standard pattern for a self-referential discriminated
    # union: ContainerBlock is itself one of Block's variants).
    children: list["Block"] = []


Block = Annotated[
    Union[ImageBlock, TextContentBlock, ButtonBlock, ContainerBlock],
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


def _extract_json_object(text: str) -> str:
    """Best-effort cleanup of the model's raw output before json.loads().

    Handles two things models do despite being told not to: qwen3.6 is a
    "thinking" model and may prepend a <think>...</think> reasoning block,
    and models in general like to wrap JSON in ```json fences. Falls back
    to slicing between the first '{' and the last '}' if neither pattern
    matches, so a merely-surrounded-by-prose response still has a chance
    to parse.
    """
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fence_match:
        return fence_match.group(1)

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


_PAGE_SECTION_ADAPTER: TypeAdapter[PageSection] = TypeAdapter(PageSection)


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
    page sections (see PageSection above), not raw markup.

    Sends the image + a schema-describing prompt to a vision-capable local
    Ollama model (owner-selectable — see resolve_vision_model) via the
    OpenAI-compatible /v1/chat/completions endpoint (same one
    backend/apis/chat.py uses, just with an image content part added). The
    model's job is to *pick* which section types apply and fill in their
    content — never to emit HTML/CSS — so the result renders through the
    same reusable components (frontend/src/components/theme/) as the
    hand-authored default template, safely and on-brand, with no
    dangerouslySetInnerHTML.
    """
    vision_provider, vision_model = resolve_vision_model(db)
    if vision_provider != "ollama":
        raise HTTPException(
            status_code=501,
            detail=f"Vision generation via {vision_provider!r} isn't implemented yet — "
            "only Ollama is wired up for this today. See apis/model_settings.py.",
        )

    image_b64 = req.design_image_base64
    if image_b64.strip().lower().startswith("data:") and "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    user_text = "Convert this landing page design into the section JSON described in your instructions."
    if req.notes:
        user_text += f" Additional notes from the site owner: {req.notes}"

    messages = [
        {"role": "system", "content": _VISION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            ],
        },
    ]

    try:
        # Vision + a 36B model + a full page's worth of structured JSON is
        # slow — much slower than chat.py's plain-text gemma4 replies.
        # Budget minutes, not seconds.
        async with httpx.AsyncClient(timeout=240) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/chat/completions",
                json={
                    "model": vision_model,
                    "messages": messages,
                    "response_format": {"type": "json_object"},
                    "stream": False,
                    # Deliberately NOT setting max_tokens: tried 4096 here
                    # once and it backfired — qwen3.6 is a "thinking" model
                    # that burns a large, variable number of tokens on
                    # internal reasoning before it starts writing the
                    # actual JSON answer, and 4096 was consumed entirely by
                    # that reasoning, leaving zero budget for the content
                    # (finish_reason: "length", empty message.content).
                    # Leaving this unset lets Ollama use the model's full
                    # context window, which is what every working test so
                    # far actually ran with.
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach Ollama at {OLLAMA_BASE_URL} (model={vision_model}): {e}",
        )

    try:
        choice = data["choices"][0]
        raw_content = choice["message"]["content"]
    except (KeyError, IndexError):
        raise HTTPException(status_code=502, detail=f"Unexpected response shape from Ollama: {data}")

    cleaned = _extract_json_object(raw_content)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as strict_error:
        # Real failure mode seen 2026-08-05 testing the container/block
        # schema: a long, content-rich generation (several sections deep)
        # came back with a literal unescaped newline inside a string
        # value — valid-looking JSON apart from that one character, but
        # json.loads() has no tolerance for it at all. json_repair handles
        # exactly this class of near-miss (unescaped control characters,
        # trailing commas, unquoted keys, ...) that LLMs produce far more
        # often than outright garbage. Tried only as a fallback, never
        # first — a repair library papering over a *systematically* broken
        # prompt would be worse than a clear error, so strict parsing
        # stays the default path and this only kicks in once it's already
        # failed.
        try:
            parsed = repair_json(cleaned, return_objects=True)
            if not isinstance(parsed, dict):
                raise ValueError(f"repaired output was not a JSON object: {type(parsed)}")
        except Exception:
            # finish_reason == "length" means Ollama's max_tokens cap cut
            # the response off mid-generation — worth distinguishing from
            # the model simply producing malformed JSON on its own.
            finish_reason = choice.get("finish_reason")
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Model did not return valid JSON ({strict_error}), and the automatic repair "
                    f"couldn't fix it either. finish_reason={finish_reason!r}. "
                    f"Raw output: {raw_content[:2000]}"
                ),
            )

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

# Reuses PageSection's schema and _coerce_sections/_extract_json_object
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

    cleaned = _extract_json_object(raw_content)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as strict_error:
        try:
            parsed = repair_json(cleaned, return_objects=True)
            if not isinstance(parsed, dict):
                raise ValueError(f"repaired output was not a JSON object: {type(parsed)}")
        except Exception:
            raise HTTPException(
                status_code=502,
                detail=f"Model did not return valid JSON ({strict_error}), and the automatic repair "
                f"couldn't fix it either. Raw output: {raw_content[:2000]}",
            )

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


@router.get("/agent/integrations", response_model=IntegrationsResponse)
async def get_integrations() -> IntegrationsResponse:
    """Lightweight reachability check for third-party services a stub
    route below would actually need — currently just ComfyUI (poster
    generation). Read-only, no side effects on ComfyUI itself. Lets the
    dashboard gray out "Generate poster" up front with a clear reason
    instead of only discovering it's unreachable after clicking "Try it"
    and getting a generic 502. Not meant to grow into a general health-
    check system — add an entry here only when a real capability actually
    depends on that service being reachable."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{COMFYUI_URL}/system_stats")
            resp.raise_for_status()
        comfyui = IntegrationStatus(available=True)
    except httpx.HTTPError as e:
        comfyui = IntegrationStatus(available=False, detail=f"ComfyUI unreachable at {COMFYUI_URL}: {e}")
    return IntegrationsResponse(comfyui=comfyui)


class GeneratePosterRequest(BaseModel):
    prompt: str
    overlay_text: str = ""


class GeneratePosterResponse(BaseModel):
    image_url: str


@router.post("/agent/poster/generate", response_model=GeneratePosterResponse)
async def generate_poster(req: GeneratePosterRequest) -> GeneratePosterResponse:
    """Generate a text+image poster: submit a ComfyUI text-to-image job,
    wait for it to finish, then (if `overlay_text` was given) composite
    real rendered text onto the result. No new image pipeline — this
    composes apis/api.py's existing ComfyUI wrapper (the same functions
    its own manual-test form uses), called directly as plain Python
    functions rather than a self-HTTP round-trip since it's the same
    process. Deliberately a direct, deterministic call with no LLM/agent
    reasoning involved — matches the "structured admin request, not a
    chatbot command" direction settled on in the root AGENTS.md, and
    keeps this out of the agent-isolation problem entirely (see that
    file's Phase 6 note) since there's no agent loop here to isolate."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must not be empty")

    payload = _build_payload_txt2img(prompt=req.prompt)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{COMFYUI_URL}/prompt", json=payload)
            resp.raise_for_status()
            submit_result = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach ComfyUI at {COMFYUI_URL}: {e}")

    if submit_result.get("node_errors"):
        raise HTTPException(status_code=422, detail={"node_errors": submit_result["node_errors"]})
    prompt_id = submit_result.get("prompt_id")
    if not prompt_id:
        raise HTTPException(status_code=502, detail=f"ComfyUI did not return a prompt_id: {submit_result}")

    # Reuses apis/api.py's /wait route function directly (websocket-first,
    # polling fallback, cancel-on-timeout — see its own docstring) instead
    # of reimplementing any of that here.
    outcome = await wait_for_completion(prompt_id, timeout=180.0)
    if outcome["status"] != "completed":
        raise HTTPException(status_code=502, detail=f"Image generation did not complete: {outcome}")

    image_url = outcome["images"][0]["url"]

    if req.overlay_text.strip():
        # image_url is built from COMFYUI_PUBLIC_URL (localhost:8188) —
        # correct for the *browser* to load, but unreachable from inside
        # this container (its own localhost, not the host running
        # ComfyUI). Same class of bug as the frontend's
        # INTERNAL_API_URL-vs-NEXT_PUBLIC_API_URL gotcha (root AGENTS.md)
        # — swap in COMFYUI_URL (host.docker.internal:8188) for this
        # server-side fetch only; the URL returned to the caller below
        # still uses the public one.
        internal_image_url = image_url.replace(COMFYUI_PUBLIC_URL, COMFYUI_URL, 1)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                img_resp = await client.get(internal_image_url)
                img_resp.raise_for_status()
                image_b64 = base64.b64encode(img_resp.content).decode("ascii")
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Image generated but failed to fetch it back for text overlay: {e}",
            )

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
    summary: str
    tags: list[str] = []


class CrmEntryResponse(BaseModel):
    crm_id: str
    contact_email: str
    summary: str
    tags: list[str]
    created_at: datetime


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
    entry = CrmEntry(contact_email=req.contact_email, summary=req.summary, tags=req.tags)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return CrmEntryResponse(
        crm_id=str(entry.id),
        contact_email=entry.contact_email,
        summary=entry.summary,
        tags=entry.tags,
        created_at=entry.created_at,
    )


@router.get("/agent/crm/entries", response_model=list[CrmEntryResponse])
def list_crm_entries(db: Session = Depends(get_db)) -> list[CrmEntryResponse]:
    """Most-recent-first — lets an admin see what's actually been
    captured so far, the same "not just a black-box POST" bar every other
    real capability in this file already meets (DocumentManager,
    PageManager, ...)."""
    entries = db.query(CrmEntry).order_by(CrmEntry.created_at.desc()).all()
    return [
        CrmEntryResponse(
            crm_id=str(e.id), contact_email=e.contact_email, summary=e.summary, tags=e.tags, created_at=e.created_at
        )
        for e in entries
    ]


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
