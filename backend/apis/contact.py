"""Public "contact us" form (2026-09-09) — a plain, no-auth way for a
visitor to reach the business directly, independent of the chatbot's own
automatic lead capture (apis/chat.py). Built alongside the frontend's
`not-found.tsx` — a visitor landing on a page that doesn't exist yet (a
site still being staged/built) still needs a way to reach the business
without going through /chat at all.

Deliberately its own tiny router, not folded into apis/agent.py's
`create_crm_entry` (admin/owner-gated) — this is the one path that lets
an unauthenticated visitor create a CrmEntry row directly, so it needs
its own narrower, rate-limited surface rather than widening an already-
privileged route. Rate-limited in rate_limit.py, same tier as
`/api/chat/upload` — a real public mutation with no auth gate at all."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from apis.turnstile_settings import is_turnstile_enabled
from db import get_db
from models import AppSettings, CrmEntry
from turnstile import verify_turnstile_token

router = APIRouter()


class ContactFormRequest(BaseModel):
    name: str
    email: str
    message: str
    # Cloudflare Turnstile response token (2026-09-10) — see
    # backend/turnstile.py's own docstring.
    turnstile_token: str | None = None

    @field_validator("name", "email", "message")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class ContactFormResponse(BaseModel):
    ok: bool


@router.post("/contact", response_model=ContactFormResponse)
async def submit_contact_form(req: ContactFormRequest, request: Request, db: Session = Depends(get_db)) -> ContactFormResponse:
    """Stores directly as a CrmEntry (category="inquiry", tags=["contact-form"])
    — the same table apis/chat.py's automatic capture writes to, so a
    submission shows up in CrmPanel's existing "Inquiries" group with no
    new dashboard UI needed."""
    settings_row = db.get(AppSettings, 1)
    if is_turnstile_enabled(settings_row):
        client_ip = request.client.host if request.client else None
        if not await verify_turnstile_token(settings_row.turnstile_secret_key, req.turnstile_token, client_ip):
            raise HTTPException(status_code=428, detail="Bot verification required.")

    if "@" not in req.email:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")

    entry = CrmEntry(
        contact_email=req.email,
        contact_name=req.name,
        summary=req.message,
        tags=["contact-form"],
        category="inquiry",
    )
    db.add(entry)
    db.commit()
    return ContactFormResponse(ok=True)
