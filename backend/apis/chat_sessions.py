"""Admin/owner read-only viewer for the chat sessions/messages
`apis/chat.py` already persists on every `/api/chat` turn (2026-08-21) —
closes a real, long-flagged gap: the data has existed since chat history
logging first shipped (`ChatSession`/`ChatMessage`, `models.py`), but
nothing in the dashboard ever let an owner actually read a transcript —
only `ReportPanel`'s own aggregate day-by-day counts existed. Pure
market-research reading, same posture as `ChatSession`'s own docstring —
nothing in the live chat request/response path depends on this router at
all, it only ever reads.

A dedicated small file, not folded into `apis/agent.py` (already large)
— same "one concern, one file" precedent as `apis/payments.py`/
`apis/notifications.py`/`apis/maps.py`/`apis/business_profile.py`."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import ChatMessage, ChatSession

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


class ChatSessionSummary(BaseModel):
    id: int
    session_key: str
    user_email: str | None
    created_at: datetime
    last_seen_at: datetime
    message_count: int


class ChatSessionListResponse(BaseModel):
    items: list[ChatSessionSummary]
    total: int


@router.get("/chat-sessions", response_model=ChatSessionListResponse)
def list_chat_sessions(
    q: str | None = None, limit: int = 20, offset: int = 0, db: Session = Depends(get_db)
) -> ChatSessionListResponse:
    """Most-recently-active first. `q` (optional) matches session_key or
    user_email — a full-text search over message content is a real, bigger
    feature (would need its own index at any real scale) deliberately left
    for later; this covers "find the session for a known visitor" today."""
    stmt = select(ChatSession)
    count_stmt = select(func.count()).select_from(ChatSession)
    if q:
        condition = or_(ChatSession.session_key.ilike(f"%{q}%"), ChatSession.user_email.ilike(f"%{q}%"))
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)

    total = db.execute(count_stmt).scalar_one()
    sessions = (
        db.execute(stmt.order_by(ChatSession.last_seen_at.desc()).limit(limit).offset(offset)).scalars().all()
    )

    counts_by_session = dict(
        db.execute(
            select(ChatMessage.session_id, func.count())
            .where(ChatMessage.session_id.in_([s.id for s in sessions]))
            .group_by(ChatMessage.session_id)
        ).all()
    )

    return ChatSessionListResponse(
        items=[
            ChatSessionSummary(
                id=s.id,
                session_key=s.session_key,
                user_email=s.user_email,
                created_at=s.created_at,
                last_seen_at=s.last_seen_at,
                message_count=counts_by_session.get(s.id, 0),
            )
            for s in sessions
        ],
        total=total,
    )


class ChatMessageSummary(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime


class ChatMessageListResponse(BaseModel):
    items: list[ChatMessageSummary]
    total: int
    session: ChatSessionSummary


@router.get("/chat-sessions/{session_id}/messages", response_model=ChatMessageListResponse)
def list_chat_session_messages(
    session_id: int, limit: int = 50, offset: int = 0, db: Session = Depends(get_db)
) -> ChatMessageListResponse:
    """Oldest-first (natural reading order for a transcript, the opposite
    of the session list's newest-first) — paginated from the start of the
    session by default; a long-running session's later messages need a
    higher `offset`, not a `page` reversed like every other paginated list
    in this app, since "page 1" here means "the beginning of the
    conversation," not "the most recent activity."""
    session = db.get(ChatSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No chat session {session_id}")

    total = db.execute(
        select(func.count()).select_from(ChatMessage).where(ChatMessage.session_id == session_id)
    ).scalar_one()
    messages = (
        db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at.asc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    return ChatMessageListResponse(
        items=[ChatMessageSummary(id=m.id, role=m.role, content=m.content, created_at=m.created_at) for m in messages],
        total=total,
        session=ChatSessionSummary(
            id=session.id,
            session_key=session.session_key,
            user_email=session.user_email,
            created_at=session.created_at,
            last_seen_at=session.last_seen_at,
            message_count=total,
        ),
    )
