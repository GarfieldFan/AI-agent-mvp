"""Cross-session CRM entry recovery via an emailed one-time code
(2026-08-20) — lets a visitor who abandoned a multi-turn structured
intake (backend/models.py's IntentSchema/CrmEntry) in one browser
session pick it back up in a new one, without trusting their stated
email alone (see CrmEntry.resume_code_hash's own docstring for the full
"why" — real PII sits behind this).

Public, no-auth (like /api/chat) — a visitor filing a claim was never
asked to create an account, so this can't require one either. Rate-
limited (rate_limit.py) at both steps: /request could otherwise be used
to spam a stranger's inbox with codes, /verify could otherwise be
brute-forced (on top of the per-entry `resume_code_attempts` cap, which
survives even if a caller spreads guesses across many source IPs).

**Deliberately NOT wired into the chat pipeline's own LLM-driven flow
yet** — apis/chat.py's lead-extraction logic has no idea this exists.
Whether a visitor should be able to trigger this conversationally ("I
want to continue my claim from before") — which would need real prompt
work in `_lead_extraction_system_prompt` to detect that intent, plus
deciding how a code gets requested/entered mid-conversation — is a
separate, later integration decision. This module only builds the
mechanism itself: two directly-callable endpoints, verified independent
of the chat/LLM layer entirely."""

import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.chat import _get_or_create_session
from apis.notifications import is_email_configured, resolve_email_provider
from db import get_db
from models import CrmEntry
from notifications import NotificationProviderNotConfigured

router = APIRouter()

RESUME_CODE_TTL_MINUTES = 10
MAX_RESUME_ATTEMPTS = 5


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _find_resumable_entry(db: Session, contact_email: str) -> CrmEntry | None:
    """No `schema_key` needed (2026-08-20, dropped from the original cut
    of this endpoint) — a real visitor-facing UI can't reasonably ask
    someone to know their own request's internal schema key, and there's
    no need to: the most recent schema-linked entry for this email,
    across every schema, is the one worth resuming. A visitor with more
    than one kind of request in flight is a real edge case this doesn't
    handle (they'd only ever get back the newest), acceptable for a v1
    of this feature."""
    return db.execute(
        select(CrmEntry)
        .where(CrmEntry.contact_email == contact_email, CrmEntry.intent_schema_id.isnot(None))
        .order_by(CrmEntry.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


class ResumeRequestBody(BaseModel):
    contact_email: str


class ResumeRequestResponse(BaseModel):
    # Deliberately generic, identical whether or not a match was found —
    # a response that differs based on "does this email have a request
    # on file" would let anyone probe for that (an enumeration/privacy
    # concern). A real match gets a real email; a non-match gets this
    # same response and nothing is sent.
    message: str


_GENERIC_RESPONSE = ResumeRequestResponse(
    message="If we found a matching in-progress request, we've emailed a code to continue it."
)


@router.post("/crm/resume/request", response_model=ResumeRequestResponse)
async def request_resume_code(req: ResumeRequestBody, db: Session = Depends(get_db)) -> ResumeRequestResponse:
    if not is_email_configured(db):
        raise HTTPException(
            status_code=503,
            detail="This business hasn't set up email yet, so a resume code can't be sent — contact them directly.",
        )

    entry = _find_resumable_entry(db, req.contact_email)
    if entry is None:
        return _GENERIC_RESPONSE

    code = f"{secrets.randbelow(1_000_000):06d}"
    entry.resume_code_hash = _hash_code(code)
    entry.resume_code_expires_at = datetime.utcnow() + timedelta(minutes=RESUME_CODE_TTL_MINUTES)
    entry.resume_code_attempts = 0
    db.commit()

    try:
        _, provider = resolve_email_provider(db)
        await provider.send_email(
            req.contact_email,
            "Your code to continue your request",
            f"Your code is {code}. It expires in {RESUME_CODE_TTL_MINUTES} minutes. "
            "If you didn't request this, you can ignore this email.",
        )
    except NotificationProviderNotConfigured:
        # Already checked is_email_configured above (bad/expired
        # credentials would only surface here, not there) — a live send
        # failure still shouldn't change what the caller sees, same
        # enumeration-avoidance reasoning as the "not found" case.
        pass

    return _GENERIC_RESPONSE


class ResumeVerifyBody(BaseModel):
    contact_email: str
    code: str
    session_id: str


class ResumeVerifyResponse(BaseModel):
    resumed: bool
    collected_fields: dict | None = None


@router.post("/crm/resume/verify", response_model=ResumeVerifyResponse)
def verify_resume_code(req: ResumeVerifyBody, db: Session = Depends(get_db)) -> ResumeVerifyResponse:
    entry = _find_resumable_entry(db, req.contact_email)
    if entry is None:
        return ResumeVerifyResponse(resumed=False)

    if (
        entry.resume_code_hash is None
        or entry.resume_code_expires_at is None
        or entry.resume_code_attempts >= MAX_RESUME_ATTEMPTS
        or entry.resume_code_expires_at < datetime.utcnow()
    ):
        return ResumeVerifyResponse(resumed=False)

    if _hash_code(req.code) != entry.resume_code_hash:
        entry.resume_code_attempts += 1
        db.commit()
        return ResumeVerifyResponse(resumed=False)

    # Success — rebind this entry to the visitor's NEW session so
    # apis/chat.py's own _find_active_entry (chat_session_id-scoped)
    # picks it up automatically on the very next turn, no change needed
    # to that existing logic at all. The code is single-use — cleared
    # immediately regardless of what happens after this.
    session = _get_or_create_session(db, req.session_id, None)
    entry.chat_session_id = session.id
    entry.resume_code_hash = None
    entry.resume_code_expires_at = None
    entry.resume_code_attempts = 0
    db.commit()
    return ResumeVerifyResponse(resumed=True, collected_fields=entry.collected_fields)
