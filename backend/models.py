"""ORM models: users (real auth, see apis/auth.py + apis/deps.py) and page
storage — a `Page` (identified by `slug`) has many `PageVersion`s.

Every page save creates a new version rather than overwriting — "restore"
(see apis/pages.py) works by copying an old version's content into a *new*
version, so history is never destroyed and a bad generation is always
undoable.
"""

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    # Plain string, not a DB enum — matches apis/deps.py's Role(str, Enum)
    # by value, kept as a string here so seeding/migrating doesn't need to
    # touch a Postgres enum type if roles ever change.
    role: Mapped[str] = mapped_column(String(32), default="user")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Page(Base):
    __tablename__ = "pages"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    versions: Mapped[list["PageVersion"]] = relationship(
        back_populates="page",
        order_by="PageVersion.created_at.desc()",
        cascade="all, delete-orphan",
    )


class PageVersion(Base):
    __tablename__ = "page_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"))
    # {"sections": [...], "accent_color": "#..."} — same shape as
    # GenerateLandingPageResponse / frontend's GeneratedPage. Stored
    # wholesale (never queried into), so one JSONB column is enough.
    content: Mapped[dict] = mapped_column(JSONB)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    page: Mapped["Page"] = relationship(back_populates="versions")


class Document(Base):
    """A RAG-ingested file (see apis/documents.py). The raw file lives on
    disk under the `document_storage` volume — `storage_path` is relative
    to that volume's root, never a full host path, so it stays valid
    regardless of where the volume is mounted."""

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(500))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    storage_path: Mapped[str] = mapped_column(String(1000))
    # pending -> processing -> ready, or -> error (see error_message)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    chunks: Mapped[list["DocumentChunk"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="DocumentChunk.chunk_index",
    )


class AppSettings(Base):
    """Singleton row (id is always 1) holding the owner-selected AI model
    for chat and vision generation. A missing row means "nothing chosen
    yet, use the env-var defaults" — see apis/model_settings.py's
    _current_settings(). Global and persisted deliberately: the whole
    point is that an owner picks a model once and it applies to every
    visitor's /api/chat call and every generate_landing_page call from
    then on, survives a restart, not just a per-session override."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    chat_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    vision_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    vision_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )


class ChatSession(Base):
    """Groups /api/chat turns from one anonymous visitor across page
    reloads, keyed by a client-generated UUID (localStorage, see
    frontend/src/lib/chat.ts's getChatSessionId) rather than a login —
    /api/chat has no auth (see apis/deps.py's RBAC note), so a session key
    is the only available way to tell one visitor's conversation apart
    from another's. Exists purely for the owner to review what visitors
    are asking (market-research read, per the root AGENTS.md) — nothing
    in the request/response path depends on this table; it degrades to a
    no-op if session_id is ever missing from a request."""

    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="session",
        order_by="ChatMessage.created_at",
        cascade="all, delete-orphan",
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16))  # "user" | "assistant"
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    session: Mapped["ChatSession"] = relationship(back_populates="messages")


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    # Fixed at 768 dims to match the default embedding provider (Ollama's
    # nomic-embed-text). pgvector requires a fixed column width, and a
    # similarity search can't compare vectors from two different embedding
    # spaces — switching EMBEDDING_PROVIDER to something with a different
    # output size means re-embedding every row here, not just a config
    # change. See providers/base.py's module docstring for the full story.
    embedding: Mapped[list[float]] = mapped_column(Vector(768))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    document: Mapped["Document"] = relationship(back_populates="chunks")
