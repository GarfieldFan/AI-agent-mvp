"""Admin/owner "agent console" — interface reserved, not implemented yet.

Every route here is gated by `require_role(admin, owner)`: a plain `user`
(the public chatbot visitor) can never reach these, only an authenticated
admin/owner acting through the dashboard. This is the powered-up side of
the RBAC split described in the repo root AGENTS.md — document ingestion,
generation, CRM, and reporting, the kind of actions that need real tool
access and should NOT be reachable from anonymous chatbot traffic.

Each handler currently just returns 501 so the request/response contracts
below are stable and the frontend can be built against them today. When
each capability actually ships, it should proxy into a purpose-built,
narrowly-scoped agent/skill — explicitly NOT the user's personal openclaw
instance, which has broad personal-account access (email, calendar, SSH)
that has no business being reachable from this app. See project plan
Phase 6 for the permission-boundary work that has to land first.
"""

import base64
import json
import os
import re
from typing import Annotated, Literal, Union

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
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
from apis.model_settings import resolve_vision_model
from db import get_db

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


class ThemeImage(BaseModel):
    url: str
    alt: str


class HeroSection(BaseModel):
    type: Literal["hero"] = "hero"
    eyebrow: str | None = None
    headline: str
    subheadline: str | None = None
    ctas: list[ThemeCta] = []
    image: ThemeImage | None = None


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
    badge: str | None = None


class FeatureGridSection(BaseModel):
    type: Literal["feature-grid"] = "feature-grid"
    heading: str | None = None
    subheading: str | None = None
    items: list[FeatureItem]
    columns: Literal[2, 3, 4] = 3
    layout: Literal["stacked", "split"] = "stacked"


class CarouselSection(BaseModel):
    type: Literal["carousel"] = "carousel"
    heading: str | None = None
    slides: list[ThemeImage]


class TextBlockSection(BaseModel):
    type: Literal["text-block"] = "text-block"
    icon: str | None = None
    heading: str
    body: str
    align: Literal["left", "center"] = "left"
    image: ThemeImage | None = None
    image_position: Literal["left", "right"] = "right"
    background_image: ThemeImage | None = None


class CtaBannerSection(BaseModel):
    type: Literal["cta-banner"] = "cta-banner"
    heading: str
    body: str | None = None
    ctas: list[ThemeCta]


class BadgeListSection(BaseModel):
    type: Literal["badge-list"] = "badge-list"
    heading: str
    badges: list[str]


PageSection = Annotated[
    Union[
        HeroSection,
        FeatureGridSection,
        CarouselSection,
        TextBlockSection,
        CtaBannerSection,
        BadgeListSection,
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
of the photo/image next to the headline, if there is one>"}}. Omit "image" entirely if the hero is \
text-only.

2. Feature grid — a grid/row of cards, icon+text blocks, or similar repeated items.
{"type": "feature-grid", "heading": "<optional>", "subheading": "<optional>", "columns": 2|3|4, \
"layout": "stacked|split", "items": [{"title": "<item title>", "description": "<item description>", \
"href": "#", "icon": "<icon key, optional — omit if the item has a real photo instead of an icon>", \
"image": {"url": "#", "alt": "<description of the item's photo, only if it has one — omit this whole \
field if the item uses an icon or has no image>"}, "badge": "<small label like 'New', optional>"}]}. \
How to choose "layout": check whether the heading and the first grid image start at roughly the same \
height, side by side on the same row — a narrow text column (heading/subheading/button, roughly a \
quarter of the row's width) next to a wider multi-image grid (roughly three-quarters of the width) \
filling the rest of that row. If so, use "split". If instead the heading spans the FULL width of the \
section with the grid entirely below it, use "stacked". When genuinely unsure, look again at whether \
the heading's left edge and the grid's top edge line up on the same row before deciding.

Every image "url" you write should just be "#" — you cannot produce a working image URL, so don't try; \
always write a specific, useful "alt" description instead (what the photo actually shows), since \
that's what gets displayed in place of the real photo.

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
- Always include your best-guess "accent_color" — don't omit it.
- Do not invent section types outside the six listed above.
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
    except json.JSONDecodeError as e:
        # finish_reason == "length" means Ollama's max_tokens cap cut the
        # response off mid-generation — worth distinguishing from the
        # model simply producing malformed JSON on its own.
        finish_reason = choice.get("finish_reason")
        raise HTTPException(
            status_code=502,
            detail=(
                f"Model did not return valid JSON ({e}). finish_reason={finish_reason!r}. "
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


@router.post("/agent/crm/entries", response_model=CrmEntryResponse)
async def create_crm_entry(req: CrmEntryRequest) -> CrmEntryResponse:
    """Push a captured lead/inquiry (e.g. from the chatbot's structured
    intent capture) into a CRM — third-party API integration placeholder."""
    raise HTTPException(status_code=501, detail="CRM integration is not implemented yet.")


class ReportRequest(BaseModel):
    report_type: str
    date_range: str


class ReportResponse(BaseModel):
    report_url: str


@router.post("/agent/reports/generate", response_model=ReportResponse)
async def generate_report(req: ReportRequest) -> ReportResponse:
    """Generate an operational report/chart (e.g. chat volume, RAG query trends)."""
    raise HTTPException(status_code=501, detail="Report generation is not implemented yet.")
