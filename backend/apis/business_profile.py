"""Owner-facing business profile (2026-08-21) — the structured "who/
where/how to reach us" facts this app was missing for real GEO
(Generative Engine Optimization): a schema.org `LocalBusiness` JSON-LD
block meant for AI/search crawlers to read, not primarily a human-facing
page (the same audience `generate_geo_page`'s prose page targets, but
structured data instead of prose — see this router's own docstring
below for why both matter).

Deliberately owner-entered/confirmed, never LLM-written directly — the
same "misread real-world fact has real consequences" posture already
established for Product pricing and IntentSchema definitions elsewhere
in this app (a wrong phone number in a JSON-LD block that an AI system
then repeats to a real customer is a worse failure mode than a wrong
price, not a better one). `POST /agent/business-profile/suggest` mirrors
`apis/intent_schemas.py`'s `detect_business_type`/`propose_intent_schema`
precedent exactly: an LLM CAN draft values from ingested documents, but
never saves anything — the owner reviews and explicitly saves via the
plain `PUT` endpoint.

No secrets live here — every field is safe to echo back, and in fact
meant to be publicly crawlable. `public_router`'s `GET /api/business-profile`
has no auth gate at all, unlike payment/notification/map's write-only
credential fields."""

import os

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.agent import _gather_ready_document_text
from apis.deps import Role, require_role
from apis.model_settings import resolve_chat_provider
from db import get_db
from llm_json import parse_lenient_json
from models import AppSettings
from providers.base import ProviderNotConfigured

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()


class BusinessProfile(BaseModel):
    business_name: str | None
    business_description: str | None
    business_type: str | None
    business_email: str | None
    business_phone: str | None
    business_street_address: str | None
    business_locality: str | None
    business_region: str | None
    business_postal_code: str | None
    business_country: str | None
    business_url: str | None
    business_logo_url: str | None
    business_hours: list[str]
    business_social_links: list[str]


def _to_profile(row: AppSettings | None) -> BusinessProfile:
    default_url = os.environ.get("FRONTEND_PUBLIC_URL")
    return BusinessProfile(
        business_name=row.business_name if row else None,
        business_description=row.business_description if row else None,
        business_type=row.business_type if row else None,
        business_email=row.business_email if row else None,
        business_phone=row.business_phone if row else None,
        business_street_address=row.business_street_address if row else None,
        business_locality=row.business_locality if row else None,
        business_region=row.business_region if row else None,
        business_postal_code=row.business_postal_code if row else None,
        business_country=row.business_country if row else None,
        business_url=(row.business_url if row else None) or default_url,
        business_logo_url=row.business_logo_url if row else None,
        business_hours=(row.business_hours if row else None) or [],
        business_social_links=(row.business_social_links if row else None) or [],
    )


@admin_router.get("/business-profile", response_model=BusinessProfile)
def get_business_profile_admin(db: Session = Depends(get_db)) -> BusinessProfile:
    return _to_profile(db.get(AppSettings, 1))


@public_router.get("/business-profile", response_model=BusinessProfile)
def get_business_profile_public(db: Session = Depends(get_db)) -> BusinessProfile:
    """Public, no-auth — the whole point of this data is to be read by
    AI/search crawlers and by the frontend's own JSON-LD/metadata
    generation (root layout, sitemap). Nothing here is sensitive."""
    return _to_profile(db.get(AppSettings, 1))


class UpdateBusinessProfileRequest(BaseModel):
    business_name: str | None = None
    business_description: str | None = None
    business_type: str | None = None
    business_email: str | None = None
    business_phone: str | None = None
    business_street_address: str | None = None
    business_locality: str | None = None
    business_region: str | None = None
    business_postal_code: str | None = None
    business_country: str | None = None
    business_url: str | None = None
    business_logo_url: str | None = None
    business_hours: list[str] = []
    business_social_links: list[str] = []


@admin_router.put("/business-profile", response_model=BusinessProfile)
def update_business_profile(req: UpdateBusinessProfileRequest, db: Session = Depends(get_db)) -> BusinessProfile:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.business_name = req.business_name
    row.business_description = req.business_description
    row.business_type = req.business_type
    row.business_email = req.business_email
    row.business_phone = req.business_phone
    row.business_street_address = req.business_street_address
    row.business_locality = req.business_locality
    row.business_region = req.business_region
    row.business_postal_code = req.business_postal_code
    row.business_country = req.business_country
    row.business_url = req.business_url
    row.business_logo_url = req.business_logo_url
    row.business_hours = req.business_hours or None
    row.business_social_links = req.business_social_links or None

    db.commit()
    db.refresh(row)
    return _to_profile(row)


_SUGGEST_SYSTEM_PROMPT = """You are given raw text extracted from a company's own documents. Extract ONLY \
facts explicitly present in the text below, for a structured business profile. Do NOT invent, guess, or \
infer anything not directly stated — leave a field null if the source text doesn't clearly state it. This \
data will be published as machine-readable structured data that AI systems and search engines repeat to \
real customers, so accuracy matters far more than completeness.

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{"business_name": "<company name, or null>", "business_description": "<a factual one-to-two sentence \
summary of what the company does, or null>", "business_type": "<a short schema.org-style business \
category, e.g. 'Plumber', 'Restaurant', 'Dentist', 'LocalBusiness' if genuinely unclear, or null>", \
"business_email": "<contact email if stated, or null>", "business_phone": "<contact phone if stated, or \
null>", "business_street_address": "<street address if stated, or null>", "business_locality": "<city if \
stated, or null>", "business_region": "<state/province if stated, or null>", "business_postal_code": \
"<postal code if stated, or null>", "business_country": "<country if stated, or null>", "business_hours": \
["<one schema.org openingHours-format string per known day/range, e.g. 'Mo-Fr 09:00-17:00', only if hours \
are explicitly stated, otherwise an empty array>"]}"""


class SuggestBusinessProfileResponse(BaseModel):
    suggestion: BusinessProfile
    document_count: int


@admin_router.post("/business-profile/suggest", response_model=SuggestBusinessProfileResponse)
async def suggest_business_profile(db: Session = Depends(get_db)) -> SuggestBusinessProfileResponse:
    """Best-effort draft from currently-ingested RAG documents — never
    writes anything, mirrors `apis/intent_schemas.py`'s
    detect_business_type/propose_intent_schema precedent exactly. The
    owner reviews the draft in BusinessProfilePanel and explicitly saves
    (or edits first) via PUT /agent/business-profile. Degrades to an
    all-null suggestion (not an error) when there are no ready documents,
    same posture as every other RAG-adjacent feature in this app."""
    doc_text, doc_count = _gather_ready_document_text(db)
    if doc_count == 0:
        return SuggestBusinessProfileResponse(suggestion=_to_profile(None), document_count=0)

    messages = [{"role": "user", "content": f"Here is the source document text:\n\n{doc_text}"}]
    try:
        provider = resolve_chat_provider(db)
        raw_content = await provider.chat(messages, system=_SUGGEST_SYSTEM_PROMPT, json_mode=True)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    try:
        parsed = parse_lenient_json(raw_content)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))

    hours = parsed.get("business_hours")
    suggestion = BusinessProfile(
        business_name=parsed.get("business_name") or None,
        business_description=parsed.get("business_description") or None,
        business_type=parsed.get("business_type") or None,
        business_email=parsed.get("business_email") or None,
        business_phone=parsed.get("business_phone") or None,
        business_street_address=parsed.get("business_street_address") or None,
        business_locality=parsed.get("business_locality") or None,
        business_region=parsed.get("business_region") or None,
        business_postal_code=parsed.get("business_postal_code") or None,
        business_country=parsed.get("business_country") or None,
        business_url=None,
        business_logo_url=None,
        business_hours=[h for h in hours if isinstance(h, str)] if isinstance(hours, list) else [],
        business_social_links=[],
    )
    return SuggestBusinessProfileResponse(suggestion=suggestion, document_count=doc_count)
