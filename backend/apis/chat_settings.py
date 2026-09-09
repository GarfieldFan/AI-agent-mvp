"""Owner-facing config for the public chatbot's system prompt
(2026-08-21) — a small, dedicated file (same "one concern, one file"
precedent as `apis/payments.py`/`apis/notifications.py`/`apis/maps.py`/
`apis/business_profile.py`/`apis/chat_sessions.py`), even though the
constant/resolver it configures (`SYSTEM_PROMPT`/`_resolve_system_prompt`)
lives in `apis/chat.py` itself — that file already owns the prompt's
definition and every place it's actually used, this file is purely the
owner-facing settings surface on top of it.

See `_resolve_system_prompt`'s own docstring (`apis/chat.py`) for the
full reasoning behind why a FULL replacement (not an append-only
override) was judged safe enough to allow, confirmed directly with the
user.

**`chat_intent_prompt` (2026-09-09) — now wired into `/api/chat`'s real
runtime.** `apis/chat.py`'s `_intent_triage_call` reads this (via
`_resolve_intent_prompt`) on a conversation's very first turn to decide
whether asking one structured clarifying question would help before the
main reply — replacing `chat-panel.tsx`'s old hardcoded 3-step category/
tags/channel wizard (see the root AGENTS.md's "real LLM-driven intent
recognition" section). `DEFAULT_INTENT_PROMPT` itself now lives in
`apis/chat.py` (imported here, same as `SYSTEM_PROMPT` already was) —
this file still owns the owner-facing settings surface (get/put/suggest)
on top of it."""

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from apis.agent import _gather_ready_document_text
from apis.chat import DEFAULT_INTENT_PROMPT, SYSTEM_PROMPT
from apis.deps import Role, require_role
from apis.model_settings import resolve_chat_provider
from db import get_db
from models import AppSettings, IntentSchema
from providers.base import ProviderNotConfigured

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


class ChatPromptSettings(BaseModel):
    chat_system_prompt: str | None
    # Always the built-in constant, regardless of what's stored — lets
    # the dashboard show/diff against it and power a "Reset to default"
    # action without hardcoding a second copy of this text in the
    # frontend.
    default_chat_system_prompt: str
    chat_intent_prompt: str | None
    default_chat_intent_prompt: str


def _settings_response(row: AppSettings | None) -> ChatPromptSettings:
    return ChatPromptSettings(
        chat_system_prompt=row.chat_system_prompt if row else None,
        default_chat_system_prompt=SYSTEM_PROMPT,
        chat_intent_prompt=row.chat_intent_prompt if row else None,
        default_chat_intent_prompt=DEFAULT_INTENT_PROMPT,
    )


@router.get("/chat-settings", response_model=ChatPromptSettings)
def get_chat_settings(db: Session = Depends(get_db)) -> ChatPromptSettings:
    return _settings_response(db.get(AppSettings, 1))


class UpdateChatPromptRequest(BaseModel):
    # None/blank resets to the built-in default — same "blank means
    # unset" convention as business_url etc. Each field is independently
    # optional-independent: omitting one leaves it untouched, an
    # explicit null/blank clears that one back to its own default.
    chat_system_prompt: str | None = None
    chat_intent_prompt: str | None = None


@router.put("/chat-settings", response_model=ChatPromptSettings)
def update_chat_settings(req: UpdateChatPromptRequest, db: Session = Depends(get_db)) -> ChatPromptSettings:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.chat_system_prompt = (req.chat_system_prompt or "").strip() or None
    row.chat_intent_prompt = (req.chat_intent_prompt or "").strip() or None

    db.commit()
    db.refresh(row)
    return _settings_response(row)


_SUGGEST_INTENT_SYSTEM_PROMPT = """You are drafting an "intent triage" system prompt for a business's public \
chatbot. This prompt will later guide a model that decides, before replying to a visitor, whether to ask one \
short structured clarifying question (and what its categories/options should be) based on what this specific \
business actually offers.

You are given raw text extracted from the company's own documents, plus a list of request types it has \
already explicitly configured for structured intake (if any). Write a prompt that:
- Names the realistic categories of visitor intent for THIS business specifically (grounded in the source \
text and the configured request types below — do not invent services the source text never mentions).
- Instructs the model to skip asking anything when the visitor's message is already clear enough.
- Instructs the model to keep any question short (a single multiple-choice or checkbox prompt, not a survey).

Respond with ONLY the prompt text itself — no markdown fences, no commentary, no JSON wrapper."""


class SuggestIntentPromptResponse(BaseModel):
    suggestion: str
    document_count: int


@router.post("/chat-settings/suggest-intent-prompt", response_model=SuggestIntentPromptResponse)
async def suggest_intent_prompt(db: Session = Depends(get_db)) -> SuggestIntentPromptResponse:
    """Best-effort draft from ingested company documents plus any
    configured IntentSchemas — never saves anything. The owner reviews
    (and may further edit) the draft in ChatPromptSettingsPanel before
    explicitly saving via PUT /agent/chat-settings, same posture as
    business_profile.py's suggest_business_profile. Degrades to an empty
    suggestion (not an error) when there are no ready documents."""
    doc_text, doc_count = _gather_ready_document_text(db)
    if doc_count == 0:
        return SuggestIntentPromptResponse(suggestion="", document_count=0)

    schemas = db.execute(select(IntentSchema).options(selectinload(IntentSchema.fields))).scalars().all()
    schema_lines = "\n".join(f"- {s.label}: {s.description or 'no description'}" for s in schemas) or "(none configured yet)"

    user_content = (
        f"Configured request types for structured intake:\n{schema_lines}\n\n"
        f"Source document text:\n\n{doc_text}"
    )
    messages = [{"role": "user", "content": user_content}]
    try:
        provider = resolve_chat_provider(db)
        raw_content = await provider.chat(messages, system=_SUGGEST_INTENT_SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    return SuggestIntentPromptResponse(suggestion=raw_content.strip(), document_count=doc_count)
