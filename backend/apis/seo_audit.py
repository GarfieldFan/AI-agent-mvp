"""Read-only GEO/SEO health check (2026-09-08) — the owner-agent-facing
"check_seo_schema" tool from the GEO implementation plan
(AI-agent-mvp_GEO实施方案). Deliberately produces a diagnostic report only,
never writes anything — the same propose-then-owner-applies posture this
app already holds for `propose_intent_schema`/`propose_products`, just
with nothing to "apply" here at all (every underlying fix, e.g. filling
in a missing business_phone, is a plain owner edit in `BusinessProfilePanel`,
not something this endpoint could safely automate).

Deliberately does NOT re-implement a real NAP (Name/Address/Phone)
cross-page consistency scan the way the GEO plan originally describes —
that check exists to catch a hand-authored multi-page site where the
phone number typed on one page drifts from the one typed on another.
This app has no such risk structurally: `AppSettings`'s single
`business_*` row is the one source of NAP data, read by every page's
JSON-LD (`SiteJsonLd`) and by `llms.txt`/`generateMetadata` alike — so
"consistency" is already guaranteed by the architecture, not something
worth faking a per-page scan for. This checks completeness instead (see
`_check_business_profile` below) and says so plainly in its own report.
"""

import os
import re
from xml.etree import ElementTree

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import AppSettings, Product

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Docker-internal DNS (docker-compose.yml's FRONTEND_INTERNAL_URL), NOT
# FRONTEND_PUBLIC_URL — this module fetches the frontend from inside the
# backend container, which can't reach "localhost:3000" (that resolves to
# itself, not the frontend container) the way a real public domain would
# in production. Same internal-vs-public split as COMFYUI_URL vs
# COMFYUI_PUBLIC_URL.
FRONTEND_INTERNAL_URL = os.environ.get("FRONTEND_INTERNAL_URL", "http://frontend:3000")

_FETCH_TIMEOUT = 8.0

# Same list the GEO plan itself names and app/robots.ts already allows —
# kept here as this endpoint's own copy rather than importing across
# services (backend has no access to the frontend's TypeScript source).
_AI_CRAWLER_AGENTS = [
    "GPTBot",
    "ChatGPT-User",
    "ClaudeBot",
    "anthropic-ai",
    "Google-Extended",
    "PerplexityBot",
]


class SeoCheckItem(BaseModel):
    check: str
    label: str
    status: str  # "ok" | "warning" | "error"
    detail: str


class SeoCheckReport(BaseModel):
    items: list[SeoCheckItem]


def _check_business_profile(settings: AppSettings | None) -> SeoCheckItem:
    if settings is None or not settings.business_name:
        return SeoCheckItem(
            check="business_profile",
            label="Business profile (NAP) completeness",
            status="error",
            detail=(
                "No business profile configured at all — AI systems have nothing to cite. "
                "Fill in at least the name, address, and phone in the SEO & AI discoverability panel."
            ),
        )

    missing = []
    if not settings.business_phone:
        missing.append("phone")
    if not settings.business_email:
        missing.append("email")
    if not (settings.business_street_address or settings.business_locality):
        missing.append("address")
    if not settings.business_hours:
        missing.append("business hours")

    note = (
        "NAP data lives in one shared record used by every page's structured data, so cross-page "
        "consistency is already guaranteed by this app's own architecture — this checks completeness, "
        "not drift."
    )
    if missing:
        return SeoCheckItem(
            check="business_profile",
            label="Business profile (NAP) completeness",
            status="warning",
            detail=f"Business name is set, but missing: {', '.join(missing)}. {note}",
        )
    return SeoCheckItem(
        check="business_profile",
        label="Business profile (NAP) completeness",
        status="ok",
        detail=f"Name, address, phone, email, and hours are all set. {note}",
    )


async def _fetch_text(client: httpx.AsyncClient, path: str) -> tuple[int | None, str]:
    try:
        resp = await client.get(f"{FRONTEND_INTERNAL_URL}{path}", timeout=_FETCH_TIMEOUT)
        return resp.status_code, resp.text
    except httpx.HTTPError as e:
        return None, f"__error__:{e}"


async def _check_robots(client: httpx.AsyncClient) -> SeoCheckItem:
    status_code, text = await _fetch_text(client, "/robots.txt")
    if status_code is None:
        return SeoCheckItem(
            check="robots_txt",
            label="robots.txt allows AI crawlers",
            status="error",
            detail=f"Could not reach {FRONTEND_INTERNAL_URL}/robots.txt: {text.removeprefix('__error__:')}",
        )
    if status_code != 200:
        return SeoCheckItem(
            check="robots_txt",
            label="robots.txt allows AI crawlers",
            status="error",
            detail=f"/robots.txt returned HTTP {status_code}.",
        )
    lowered = text.lower()
    missing = [agent for agent in _AI_CRAWLER_AGENTS if agent.lower() not in lowered]
    has_sitemap_line = "sitemap:" in lowered
    if missing:
        return SeoCheckItem(
            check="robots_txt",
            label="robots.txt allows AI crawlers",
            status="warning",
            detail=f"/robots.txt is reachable but doesn't mention: {', '.join(missing)}.",
        )
    return SeoCheckItem(
        check="robots_txt",
        label="robots.txt allows AI crawlers",
        status="ok",
        detail="Every known AI crawler user-agent is named"
        + (" and a Sitemap: line is present." if has_sitemap_line else ", but no Sitemap: line was found."),
    )


async def _check_llms_txt(client: httpx.AsyncClient) -> SeoCheckItem:
    status_code, text = await _fetch_text(client, "/llms.txt")
    if status_code is None:
        return SeoCheckItem(
            check="llms_txt",
            label="llms.txt present",
            status="error",
            detail=f"Could not reach {FRONTEND_INTERNAL_URL}/llms.txt: {text.removeprefix('__error__:')}",
        )
    if status_code != 200 or not text.strip():
        return SeoCheckItem(
            check="llms_txt",
            label="llms.txt present",
            status="warning",
            detail=f"/llms.txt returned HTTP {status_code} or was empty.",
        )
    return SeoCheckItem(check="llms_txt", label="llms.txt present", status="ok", detail="/llms.txt is reachable.")


async def _check_sitemap(client: httpx.AsyncClient) -> SeoCheckItem:
    status_code, text = await _fetch_text(client, "/sitemap.xml")
    if status_code is None:
        return SeoCheckItem(
            check="sitemap_xml",
            label="sitemap.xml is fresh",
            status="error",
            detail=f"Could not reach {FRONTEND_INTERNAL_URL}/sitemap.xml: {text.removeprefix('__error__:')}",
        )
    if status_code != 200:
        return SeoCheckItem(
            check="sitemap_xml",
            label="sitemap.xml is fresh",
            status="error",
            detail=f"/sitemap.xml returned HTTP {status_code}.",
        )
    try:
        root = ElementTree.fromstring(text)
        url_count = sum(1 for _ in root)
    except ElementTree.ParseError:
        return SeoCheckItem(
            check="sitemap_xml",
            label="sitemap.xml is fresh",
            status="error",
            detail="/sitemap.xml returned HTTP 200 but the body isn't valid XML.",
        )
    if url_count == 0:
        return SeoCheckItem(
            check="sitemap_xml",
            label="sitemap.xml is fresh",
            status="warning",
            detail="/sitemap.xml is valid but lists zero URLs.",
        )
    return SeoCheckItem(
        check="sitemap_xml",
        label="sitemap.xml is fresh",
        status="ok",
        detail=f"/sitemap.xml lists {url_count} URL(s). It's generated live on every request, so this "
        "always reflects the current catalog/pages.",
    )


_LD_JSON_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.DOTALL)


async def _check_homepage_json_ld(client: httpx.AsyncClient) -> SeoCheckItem:
    status_code, text = await _fetch_text(client, "/")
    if status_code is None:
        return SeoCheckItem(
            check="homepage_json_ld",
            label="Homepage structured data (JSON-LD)",
            status="error",
            detail=f"Could not reach {FRONTEND_INTERNAL_URL}/: {text.removeprefix('__error__:')}",
        )
    if status_code != 200:
        return SeoCheckItem(
            check="homepage_json_ld",
            label="Homepage structured data (JSON-LD)",
            status="error",
            detail=f"Homepage returned HTTP {status_code}.",
        )
    match = _LD_JSON_RE.search(text)
    if not match:
        return SeoCheckItem(
            check="homepage_json_ld",
            label="Homepage structured data (JSON-LD)",
            status="error",
            detail="No <script type=\"application/ld+json\"> tag found on the homepage.",
        )
    has_local_business = '"@type":"LocalBusiness"' in match.group(1) or '"@type": "LocalBusiness"' in match.group(1)
    if has_local_business:
        return SeoCheckItem(
            check="homepage_json_ld",
            label="Homepage structured data (JSON-LD)",
            status="ok",
            detail="A JSON-LD block with a LocalBusiness entity is present.",
        )
    return SeoCheckItem(
        check="homepage_json_ld",
        label="Homepage structured data (JSON-LD)",
        status="warning",
        detail="A JSON-LD block is present but has no LocalBusiness entity — the business profile is "
        "likely unconfigured (a bare WebSite block is expected in that case).",
    )


async def _check_product_json_ld(client: httpx.AsyncClient, db: Session) -> SeoCheckItem:
    product = db.execute(
        select(Product).where(Product.available.is_(True)).order_by(Product.id.desc()).limit(1)
    ).scalar_one_or_none()
    if product is None:
        return SeoCheckItem(
            check="product_json_ld",
            label="Product page structured data (sampled)",
            status="warning",
            detail="No available products in the catalog — nothing to sample. Not an error if this "
            "business doesn't sell products through the catalog.",
        )

    status_code, text = await _fetch_text(client, f"/products/{product.id}")
    if status_code is None:
        return SeoCheckItem(
            check="product_json_ld",
            label="Product page structured data (sampled)",
            status="error",
            detail=f"Could not reach {FRONTEND_INTERNAL_URL}/products/{product.id}: "
            f"{text.removeprefix('__error__:')}",
        )
    if status_code != 200:
        return SeoCheckItem(
            check="product_json_ld",
            label="Product page structured data (sampled)",
            status="error",
            detail=f"/products/{product.id} returned HTTP {status_code}.",
        )
    has_product_type = '"@type":"Product"' in text or '"@type": "Product"' in text
    if has_product_type:
        return SeoCheckItem(
            check="product_json_ld",
            label="Product page structured data (sampled)",
            status="ok",
            detail=f"Sampled /products/{product.id} ({product.name!r}) — a Product/Offer JSON-LD block "
            "is present.",
        )
    return SeoCheckItem(
        check="product_json_ld",
        label="Product page structured data (sampled)",
        status="error",
        detail=f"Sampled /products/{product.id} ({product.name!r}) — no Product JSON-LD block found.",
    )


@admin_router.get("/seo/check", response_model=SeoCheckReport)
async def check_seo_schema(db: Session = Depends(get_db)) -> SeoCheckReport:
    """Runs every check concurrently against the live frontend deployment
    (FRONTEND_INTERNAL_URL) plus a direct DB read for the business profile
    — never raises on an individual probe failure, each check reports its
    own ok/warning/error status instead so one unreachable page doesn't
    hide every other finding. This is the backend half of owner-agent's
    `check_seo_schema` tool (owner-agent/tools.py)."""
    settings = db.get(AppSettings, 1)

    async with httpx.AsyncClient() as client:
        items = [
            _check_business_profile(settings),
            await _check_robots(client),
            await _check_llms_txt(client),
            await _check_sitemap(client),
            await _check_homepage_json_ld(client),
            await _check_product_json_ld(client, db),
        ]

    return SeoCheckReport(items=items)
