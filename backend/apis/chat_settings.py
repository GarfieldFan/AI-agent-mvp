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
user."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.chat import SYSTEM_PROMPT
from apis.deps import Role, require_role
from db import get_db
from models import AppSettings

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


class ChatPromptSettings(BaseModel):
    chat_system_prompt: str | None
    # Always the built-in constant, regardless of what's stored — lets
    # the dashboard show/diff against it and power a "Reset to default"
    # action without hardcoding a second copy of this text in the
    # frontend.
    default_chat_system_prompt: str


@router.get("/chat-settings", response_model=ChatPromptSettings)
def get_chat_settings(db: Session = Depends(get_db)) -> ChatPromptSettings:
    row = db.get(AppSettings, 1)
    return ChatPromptSettings(
        chat_system_prompt=row.chat_system_prompt if row else None,
        default_chat_system_prompt=SYSTEM_PROMPT,
    )


class UpdateChatPromptRequest(BaseModel):
    # None/blank resets to the built-in default — same "blank means
    # unset" convention as business_url etc.
    chat_system_prompt: str | None = None


@router.put("/chat-settings", response_model=ChatPromptSettings)
def update_chat_settings(req: UpdateChatPromptRequest, db: Session = Depends(get_db)) -> ChatPromptSettings:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.chat_system_prompt = (req.chat_system_prompt or "").strip() or None

    db.commit()
    db.refresh(row)
    return ChatPromptSettings(
        chat_system_prompt=row.chat_system_prompt,
        default_chat_system_prompt=SYSTEM_PROMPT,
    )
