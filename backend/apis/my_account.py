"""Self-service account-scoped views (2026-08-22) — "user isolation": a
logged-in visitor's own orders/CRM entries/chat history, visible to that
account and no one else. A genuinely new kind of gate in this app — not
"admin sees everything" (apis/products.py/apis/agent.py/
apis/chat_sessions.py's own admin-gated equivalents) and not "fully
public" — `apis/deps.py`'s `require_authenticated_user` alone (any role,
but must actually be logged in), then every query is filtered to rows
matching the caller's own email, never a caller-supplied id.

Directly motivated by the OAuth work in apis/oauth.py — a social login
only really matters if there's somewhere for a newly-authenticated
visitor to actually see their own history afterward; this is that
somewhere."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from apis.agent import CrmEntryResponse, _crm_entry_response
from apis.deps import CurrentUser, require_authenticated_user
from apis.products import OrderListResponse, _to_order_summary
from db import get_db
from models import ChatMessage, ChatSession, CrmEntry, Order

router = APIRouter(prefix="/my")


@router.get("/orders", response_model=OrderListResponse)
def list_my_orders(
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(require_authenticated_user),
) -> OrderListResponse:
    condition = Order.contact_email == current.email
    total = db.execute(select(func.count()).select_from(Order).where(condition)).scalar_one()
    rows = (
        db.execute(select(Order).where(condition).order_by(Order.created_at.desc()).limit(limit).offset(offset))
        .scalars()
        .all()
    )
    return OrderListResponse(items=[_to_order_summary(r) for r in rows], total=total)


@router.get("/crm-entries", response_model=list[CrmEntryResponse])
def list_my_crm_entries(
    db: Session = Depends(get_db), current: CurrentUser = Depends(require_authenticated_user)
) -> list[CrmEntryResponse]:
    """Unpaginated — a single visitor's own lead/claim/inquiry history is
    realistically a handful of rows, unlike the admin-facing equivalent
    which paginates across every visitor's entries."""
    rows = (
        db.execute(select(CrmEntry).where(CrmEntry.contact_email == current.email).order_by(CrmEntry.created_at.desc()))
        .scalars()
        .all()
    )
    return [_crm_entry_response(r) for r in rows]


class MyChatSessionSummary(BaseModel):
    id: int
    session_key: str
    created_at: str
    last_seen_at: str
    message_count: int


@router.get("/chat-sessions", response_model=list[MyChatSessionSummary])
def list_my_chat_sessions(
    db: Session = Depends(get_db), current: CurrentUser = Depends(require_authenticated_user)
) -> list[MyChatSessionSummary]:
    sessions = (
        db.execute(select(ChatSession).where(ChatSession.user_email == current.email).order_by(ChatSession.last_seen_at.desc()))
        .scalars()
        .all()
    )
    counts_by_session = dict(
        db.execute(
            select(ChatMessage.session_id, func.count())
            .where(ChatMessage.session_id.in_([s.id for s in sessions]))
            .group_by(ChatMessage.session_id)
        ).all()
    )
    return [
        MyChatSessionSummary(
            id=s.id,
            session_key=s.session_key,
            created_at=s.created_at.isoformat(),
            last_seen_at=s.last_seen_at.isoformat(),
            message_count=counts_by_session.get(s.id, 0),
        )
        for s in sessions
    ]


class MyChatMessageSummary(BaseModel):
    id: int
    role: str
    content: str
    created_at: str


@router.get("/chat-sessions/{session_id}/messages", response_model=list[MyChatMessageSummary])
def get_my_chat_session_messages(
    session_id: int, db: Session = Depends(get_db), current: CurrentUser = Depends(require_authenticated_user)
) -> list[MyChatMessageSummary]:
    session = db.get(ChatSession, session_id)
    # 404, not 403 — never confirm to the caller that a session with this
    # id exists at all if it isn't theirs (same "don't leak existence"
    # reasoning as apis/crm_resume.py's own generic-response posture).
    if session is None or session.user_email != current.email:
        raise HTTPException(status_code=404, detail="No chat session found.")
    messages = (
        db.execute(select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at.asc()))
        .scalars()
        .all()
    )
    return [
        MyChatMessageSummary(id=m.id, role=m.role, content=m.content, created_at=m.created_at.isoformat())
        for m in messages
    ]
