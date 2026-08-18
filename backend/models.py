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
    # Which embedding provider/model actually produced this document's
    # current chunks — compared against AppSettings.embedding_provider/
    # embedding_model (apis/documents.py's needs_reembed) to tell a stale
    # document apart from a current one after an owner switches providers.
    embedding_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
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
    # Only meaningful when chat_provider == "custom" or
    # vision_provider == "custom" — the one caller-configured
    # OpenAI-compatible endpoint (llama.cpp, vLLM, ...) those two share,
    # see providers/custom.py. custom_api_key is optional (most local
    # servers don't require one). Embedding does NOT share this endpoint
    # (see embedding_base_url below) — a real setup this project was built
    # against runs chat/vision and embedding as two separate llama.cpp
    # processes (embedding needs its own `--embedding`-mode server, a
    # process-level flag that can't coexist with a chat model in the same
    # router instance), so forcing them to share one address broke that
    # exact case.
    custom_base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    custom_api_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The one active embedding config — see DocumentChunk.embedding's
    # comment for why this is a single active slot rather than several
    # coexisting ones. embedding_dimensions is the *actual* length of the
    # last successfully computed vector (set in apis/documents.py after a
    # real embed() call), not a static per-provider claim — the source of
    # truth for "what dimension is document_chunks.embedding in right now."
    embedding_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    embedding_dimensions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Only meaningful when embedding_provider == "custom" — its own
    # endpoint, deliberately separate from custom_base_url/custom_api_key
    # above (see the comment there).
    embedding_base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    embedding_api_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Image generation (2026-08-18) — comfyui/openai/gemini, no separate
    # "model" field since each provider has exactly one sensible default
    # this round (see providers/comfyui.py, providers/openai.py's
    # OpenAIImageProvider, providers/gemini.py's GeminiImageProvider).
    # image_comfyui_url is only meaningful when image_provider == "comfyui"
    # (or unset, since comfyui is the default) — None means "use the
    # env-var-configured instance," same fallback shape as every other
    # provider field above.
    image_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    image_comfyui_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Checkpoint choice within ComfyUI itself (2026-08-18) — only
    # meaningful when image_provider == "comfyui". None means "use the
    # fixed workflow's own default" (z_image_turbo_bf16.safetensors /
    # qwen_3_4b.safetensors / ae.safetensors, see apis/api.py's
    # _build_payload_txt2img). Only swaps files within the same
    # UNETLoader+CLIPLoader+VAELoader node shape the workflow already
    # has — not a different SD architecture (see providers/comfyui.py's
    # docstring for why that's a bigger, separate ask).
    image_comfyui_unet: Mapped[str | None] = mapped_column(String(300), nullable=True)
    image_comfyui_clip: Mapped[str | None] = mapped_column(String(300), nullable=True)
    image_comfyui_vae: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # An owner-supplied ComfyUI workflow (2026-08-19, pasted as ComfyUI's
    # own "Save (API Format)" JSON export) — lets an owner bring an
    # arbitrary, self-designed graph (any checkpoint architecture, not
    # just the fixed z_image_turbo-shaped one above) instead of this
    # app's built-in workflow. When set, it's used INSTEAD of
    # _build_payload_txt2img + the unet/clip/vae fields above, not
    # alongside them — see providers/comfyui.py's generate(). Text, not
    # String, since a real ComfyUI API-format export can be large.
    # prompt_node/prompt_field say where to splice the prompt text in
    # (e.g. node "6", field "text" for a typical CLIPTextEncode) — this
    # round only wires up the prompt text, not seed/width/height/etc.
    # (those stay whatever the pasted workflow already has baked in).
    image_comfyui_workflow: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_comfyui_prompt_node: Mapped[str | None] = mapped_column(String(50), nullable=True)
    image_comfyui_prompt_field: Mapped[str | None] = mapped_column(String(100), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )


class ChatSession(Base):
    """Groups /api/chat turns from one visitor across page reloads, keyed
    by a client-generated UUID (localStorage, see
    frontend/src/lib/chat.ts's getChatSessionId) rather than a login — the
    session key, not a login, is still what ties one browser's turns
    together, since most /api/chat traffic is genuinely anonymous.
    Exists purely for the owner to review what visitors are asking
    (market-research read, per the root AGENTS.md) — nothing in the
    request/response path depends on this table; it degrades to a no-op
    if session_id is ever missing from a request.

    `user_email` added 2026-08-08: /api/chat now optionally resolves a
    caller's JWT (apis/deps.py's `get_current_user`, same
    never-rejects-just-resolves-anonymous behavior used elsewhere) purely
    to personalize replies and back-fill `CrmEntry.contact_email` — this
    column just carries that identity onto the session record when it's
    known, so an admin/owner reading chat history later can see which
    turns came from a logged-in account. Null for every anonymous
    session, same as before this column existed."""

    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_email: Mapped[str | None] = mapped_column(String(255), nullable=True, default=None)
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


class CrmEntry(Base):
    """A captured lead/inquiry — apis/agent.py's `create_crm_entry`, made
    real 2026-08-06. No third-party CRM account/API key exists for this
    project (unlike the AI providers, which have well-known, roughly
    standardized APIs to code a generic client against, there's no single
    "the" CRM API worth picking without a real vendor account to test
    it), so this is a genuine internal record store rather than a
    third-party push — the same "real, not faked" bar as every other
    capability in this file, just satisfied by storing the lead
    ourselves instead of forwarding it. Swapping this for a real
    third-party integration later is a matter of adding that call
    alongside this insert, not a schema change.

    `category`/`status` added 2026-08-08 alongside apis/chat.py's
    automatic chat-driven capture: `category` is a real column now
    (appointment/quote/claim/inquiry, or null for older/manually-entered
    rows that predate it) rather than a convention of "tags[0]", so the
    admin/owner leads view (CrmPanel) can group and filter on it without
    parsing `tags`. `status` is a plain, ungated string (not a DB enum,
    same reasoning as User.role above) that admin/owner move through
    new -> contacted -> closed themselves — nothing here changes it
    automatically.

    `attachment_url` added 2026-08-08 alongside apis/chat.py's public
    `/chat/upload` — a visitor filing a claim or requesting a quote can
    attach one photo/PDF right in the chat before this row is created.
    Just a URL onto backend/chat_attachments.py's own storage (never a raw
    file on this row) — nullable, since most leads still arrive with no
    attachment.

    `contact_name`/`contact_phone`/`analysis_notes` added 2026-08-08
    alongside `backend/chat_attachments.py`'s automatic vision/document
    analysis of that attachment — the chat model now *does* read the
    file's actual content (a revision of this column's original "never
    sees the contents" note): `contact_name`/`contact_phone` are best-
    effort fields the automatic per-turn extraction fills in alongside
    `contact_email` so a visitor filing a claim with, say, a signed
    estimate attached doesn't have to retype what's already legible on
    it. `analysis_notes` is different in kind — never touched by the
    automatic extraction, only appended to by an admin/owner explicitly
    requesting a deeper look (`POST /agent/crm/entries/{id}/scan`, also
    reachable as the owner-agent's `scan_crm_attachment` tool) with their
    own custom instructions, e.g. pulling a policy number and incident
    date off an insurance claim photo. Multiple scans accumulate
    (timestamped, newest appended), never overwrite."""

    __tablename__ = "crm_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    contact_email: Mapped[str] = mapped_column(String(255))
    contact_name: Mapped[str | None] = mapped_column(String(255), default=None)
    contact_phone: Mapped[str | None] = mapped_column(String(64), default=None)
    summary: Mapped[str] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    category: Mapped[str | None] = mapped_column(String(32), default=None)
    status: Mapped[str] = mapped_column(String(16), default="new", server_default="new")
    analysis_notes: Mapped[str | None] = mapped_column(Text, default=None)
    attachment_url: Mapped[str | None] = mapped_column(String(1000), default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    # Dimension-less pgvector column (no fixed width) — a similarity
    # search still can't compare vectors from two different embedding
    # spaces, but that's now an application-level invariant instead of a
    # DB-level one: apis/model_settings.py's update_settings() clears this
    # whole table the moment the owner's embedding provider/model actually
    # changes, so it's always either empty or fully consistent with
    # AppSettings.embedding_provider/embedding_dimensions (the real source
    # of truth for "what dimension is in here right now"). See
    # providers/base.py's module docstring for the full swapping story.
    embedding: Mapped[list[float]] = mapped_column(Vector())
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    document: Mapped["Document"] = relationship(back_populates="chunks")
