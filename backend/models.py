"""ORM models: users (real auth, see apis/auth.py + apis/deps.py) and page
storage — a `Page` (identified by `slug`) has many `PageVersion`s.

Every page save creates a new version rather than overwriting — "restore"
(see apis/pages.py) works by copying an old version's content into a *new*
version, so history is never destroyed and a bad generation is always
undoable.
"""

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, Numeric, String, Text, func
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
    # Local resource coordination between chat/vision and ComfyUI
    # (2026-08-19, see resource_broker.py) — opt-in, off by default so
    # this changes nothing for anyone not running local processes at all
    # (cloud-only OpenAI/Anthropic setups have no local footprint to
    # coordinate). headroom_mb is "only unload the chat/vision model if
    # ComfyUI reports less free RAM/VRAM than this" — a real
    # owner-configurable number, not a hardcoded heuristic, since
    # unloading unnecessarily costs a real reload delay on the next chat
    # turn (measured up to 159s for a 27B model this session).
    resource_coordination_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    resource_coordination_headroom_mb: Mapped[int] = mapped_column(Integer, nullable=False, server_default="4096")
    # Owner-agent-set (set_order_status_options tool, 2026-08-19) — the
    # status labels OrderPanel's Select offers for an Order.status, same
    # "null means use the in-code default" posture as chat_provider etc.
    # above. Deliberately no manual dashboard editor for this in v1 —
    # owner-agent is the only way to set it, matching how IntentView's
    # status_options also has no manual editor, only manage_review_queue.
    order_status_options: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True, default=None)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )


class OwnerAgentRun(Base):
    """One completed owner-agent run (2026-08-19) — queryable history to
    go alongside `owner-agent/logging_.py`'s per-step JSONL file, not a
    replacement for it: the JSONL write stays (owner-agent is still
    DB-less by design, see its own main.py docstring — that file is its
    only durable record if this backend call itself fails), this table
    is what makes runs actually queryable rather than "greppable if
    you're on the host machine with a shell open." Written once per run
    (not once per step, unlike the JSONL) via `POST
    /agent/owner-agent/runs`, called by `owner-agent/main.py` right
    after a run completes — best-effort, a logging failure never fails
    the run response the owner is waiting on."""

    __tablename__ = "owner_agent_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_email: Mapped[str] = mapped_column(String(255))
    command: Mapped[str] = mapped_column(Text)
    final_answer: Mapped[str] = mapped_column(Text)
    stopped_reason: Mapped[str] = mapped_column(String(50))
    # The full step trace (tool/args/result per step) — same shape
    # main.py's own RunResponse.steps already returns to the frontend,
    # stored as-is rather than normalized into their own rows: nobody
    # queries into individual steps yet, and this keeps one run == one
    # row, trivial to page through.
    steps: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


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
    # Owner-configurable structured collection (2026-08-19, see
    # IntentSchema/IntentField below) — all three nullable/defaulted so
    # existing rows and owners who never configure a schema are
    # completely unaffected. intent_schema_id identifies *what kind* of
    # request this is (an owner-defined scenario, e.g. "insurance
    # claim"); collected_fields holds the actual {field_key: value}
    # data matching that schema's IntentFields; chat_session_id is the
    # join key apis/chat.py uses to find and update THIS SAME record
    # across multiple turns of one conversation instead of inserting a
    # new partial row every time a visitor gives one more field.
    intent_schema_id: Mapped[int | None] = mapped_column(
        ForeignKey("intent_schemas.id", ondelete="SET NULL"), default=None
    )
    collected_fields: Mapped[dict] = mapped_column(JSONB, default=dict)
    chat_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="SET NULL"), default=None
    )
    # Added 2026-08-20 — a stub for real human handoff (deliberately not
    # built yet, see the root AGENTS.md): apis/chat.py's lead-extraction
    # call sets this true when a visitor explicitly asks to speak with a
    # person rather than continue with the chatbot. No live-transfer/
    # notification infrastructure exists — this is purely a flag an
    # admin/owner can see and act on manually (CrmPanel/ReviewQueuePanel),
    # ready for a real handoff feature to build on top of later.
    wants_human: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class IntentSchema(Base):
    """An owner-defined "kind of request" the public chatbot should
    collect structured information for (2026-08-19) — e.g. "insurance
    application" vs. "insurance claim," each needing different fields.
    Generalizes CrmEntry's old fixed `category` enum
    (appointment/quote/claim/inquiry, still the default when an owner
    configures nothing here) into something any vertical can define for
    itself: real estate, a clinic's appointment intake, a restaurant's
    reservation form, a law firm's initial-consultation questionnaire,
    ... — the mechanism is identical, only the fields differ, so adding
    a new vertical is the owner filling in this table again, not new
    code. See apis/chat.py's `_lead_extraction_system_prompt` for how
    this actually drives collection during a conversation."""

    __tablename__ = "intent_schemas"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str] = mapped_column(String(255))
    # Tells the model *when* this schema applies — e.g. "the visitor
    # wants to file or check on an existing insurance claim."
    description: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    fields: Mapped[list["IntentField"]] = relationship(
        back_populates="intent_schema",
        order_by="IntentField.sort_order",
        cascade="all, delete-orphan",
    )


class IntentField(Base):
    """One field an IntentSchema requires — field_key is what
    apis/chat.py's extraction prompt and CrmEntry.collected_fields both
    key on; label/prompt_hint are what actually get shown to the model
    (and, for label, the dashboard) so the field means something beyond
    a raw identifier."""

    __tablename__ = "intent_fields"

    id: Mapped[int] = mapped_column(primary_key=True)
    intent_schema_id: Mapped[int] = mapped_column(ForeignKey("intent_schemas.id", ondelete="CASCADE"))
    field_key: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(255))
    # text|email|phone|date|number|note — a fixed, small vocabulary
    # (mirrors this project's other enum-not-free-text style knobs, e.g.
    # BlockWidth in the page schema) rather than an open type string.
    field_type: Mapped[str] = mapped_column(String(16), default="text")
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    prompt_hint: Mapped[str | None] = mapped_column(Text, default=None)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    intent_schema: Mapped["IntentSchema"] = relationship(back_populates="fields")


class IntentView(Base):
    """An owner-agent-generated "review queue" over one IntentSchema's
    captured entries (2026-08-19) — the follow-on to IntentSchema above.
    Built specifically so the owner never has to describe a workflow to
    *me*: they tell owner-agent something like "I want to review
    insurance applications people submit, approve or reject them," and
    owner-agent (via its `manage_review_queue` tool, see
    owner-agent/tools.py) creates or updates this row itself — including
    picking sensible default `status_options` when the owner didn't
    specify any. One row per schema in practice (POST /agent/intent-views
    upserts by schema_key rather than creating duplicates), not enforced
    with a DB constraint — simpler than handling a conflict error path
    for a case that shouldn't happen.

    `status_options` is what makes `CrmEntry.status` genuinely owner-
    defined per queue (e.g. pending/approved/rejected) instead of the
    original fixed new/contacted/closed three — see apis/agent.py's
    `CrmStatusUpdateRequest`, loosened from a `Literal` to a plain `str`
    specifically for this. The frontend's `ReviewQueuePanel` is what
    actually renders a queue's entries and lets an owner/admin change
    status by clicking through them; this row only describes the queue
    itself."""

    __tablename__ = "intent_views"

    id: Mapped[int] = mapped_column(primary_key=True)
    intent_schema_id: Mapped[int] = mapped_column(ForeignKey("intent_schemas.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    status_options: Mapped[list[str]] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    intent_schema: Mapped["IntentSchema"] = relationship()


class Product(Base):
    """A generic, owner-defined orderable thing (2026-08-19) — modeled on
    WooCommerce's product concept rather than anything restaurant- or
    retail-specific: a coffee-shop menu item, a physical good, a virtual/
    digital good, a bookable service, whatever the owner sells. This table
    is the same "we build the framework, the owner fills in the specific
    vertical" posture as IntentSchema above, just for things that get
    ordered with a quantity and a real price instead of collected as a
    flat field set.

    `tags` replaced the original single `category: str | None` column
    2026-08-20 (a real user design decision, not a rename for its own
    sake) — the two overlapped in purpose (both were "which bucket does
    this product belong to," category just a rigid single value where
    tags is a free list) and a single category string turned out to be a
    real limitation: `cart.search_products`'s matching is plain `ILIKE`
    text matching, not semantic, so a Chinese-speaking visitor searching
    "咖啡" could never match a product whose only category text was the
    English "Coffee" — no shared substring, zero overlap, unlike RAG's
    embedding-based retrieval which at least has *some* cross-lingual
    signal. A product can now carry several tags (`["Coffee", "咖啡",
    "Espresso-based"]`) — synonyms, translations, whatever the owner
    wants a visitor's phrasing to match against — same free-text,
    no-enum posture the single category string always had, just widened
    from one value to a list.

    v1 scope cut, deliberate: no variant/attribute matrix (WooCommerce's
    "variable product") — a "Latte Large" vs "Latte Small" are two
    separate rows here, not one product with a size attribute. No
    inventory/stock tracking either. Both deferred, not rejected.

    Created either directly (admin/owner's own dashboard form, ProductPanel)
    or via owner-agent's propose_products tool — but even then, only ever
    written by the owner's own explicit Apply click (see
    apis/products.py's propose_products docstring): a misread price
    directly affects what a real customer is quoted, so this follows the
    same propose-then-owner-applies posture as IntentSchema, not
    IntentView's apply-directly-then-adjust one."""

    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, default=None)
    price: Mapped[float] = mapped_column(Numeric(10, 2))
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    # Pure display data (2026-08-19) — never read server-side (never fed
    # to a vision model, unlike chat_attachments' own images), so it
    # needs none of chat_attachments.resolve_local_path's paranoid local-
    # path resolution. Expected to hold a URL the owner already got back
    # from the media library upload (apis/media.py) — this app never
    # fetches an owner-supplied external URL server-side (a real SSRF
    # surface), so nothing here validates or re-hosts the URL, it's
    # stored and rendered as-is.
    image_url: Mapped[str | None] = mapped_column(String(1000), default=None)
    # Owner-defined extra fields (2026-08-19) — mirrors CrmEntry.
    # collected_fields exactly: ProductFieldDefinition below is the
    # shared {field_key: label/type} definition list every product draws
    # from, this column holds one product's actual {field_key: value}
    # data.
    custom_fields: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ProductFieldDefinition(Base):
    """One owner-defined extra field available on every Product (2026-08-19)
    — e.g. "SKU", "subscribe", a spec-sheet link. A single flat shared
    list, unlike IntentSchema/IntentField: there's no per-vertical
    grouping need here, every product draws from the same definitions.
    Product.custom_fields holds the actual per-product values, keyed by
    field_key."""

    __tablename__ = "product_field_definitions"

    id: Mapped[int] = mapped_column(primary_key=True)
    field_key: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(255))
    # text|number|date|note|link — no email/phone (IntentField has those,
    # products don't need them); link is new here, for things like a
    # warranty page or spec sheet URL.
    field_type: Mapped[str] = mapped_column(String(16), default="text")
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class ProductRelation(Base):
    """A directed relation from one Product to another (2026-08-19) — one
    generic table for both "bundle" and "upsell" (relation_type, free
    text, same posture as CrmEntry.category) rather than two separate
    tables, since both are fundamentally "this product relates to that
    one," just with different display intent. A bundle prices itself
    independently (its own Product.price) — this table only records
    *what's inside* a bundle for display/fulfillment, it never drives
    price computation. `quantity` is only meaningful for relation_type
    "bundle" (how many of the component are included); ignored for
    "upsell"."""

    __tablename__ = "product_relations"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    related_product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    relation_type: Mapped[str] = mapped_column(String(32))
    quantity: Mapped[int | None] = mapped_column(Integer, default=None)


class Order(Base):
    """A visitor's order against the Product catalog above — captured by
    apis/chat.py's `_maybe_capture_order` (mirrors `_maybe_capture_lead`'s
    shape) as the visitor talks, or viewed/managed by admin/owner via
    OrderPanel. Unlike CrmEntry, contact_email/contact_name are both
    nullable — an order doesn't need contact info to be useful, the owner
    mainly needs to know what to prepare and when, identified well enough
    by chat_session_id alone.

    `is_open` (2026-08-19) is a deliberate, separate boolean from
    `status` — the user's own explicit call: status is free text
    owner-agent can set to whatever labels the owner wants
    (received/preparing/ready/delivered/paid/refunded, or anything else
    via set_order_status_options), so the code can't infer from it
    whether this order should still accept chat add-ons ("加单").
    `is_open` is the one hard signal for that, toggled explicitly by
    admin/owner in OrderPanel (or defaults True until they close it) —
    apis/chat.py's `_find_active_order` only ever looks up
    `is_open == True` rows to append to.

    `total_amount` is always recomputed server-side from real
    OrderItem.subtotal values, never trusted from the model — the
    extraction call only ever reports which products/quantities changed
    this turn, real arithmetic happens in Python. `pickup_time` is kept
    as free text ("9am", "in 5 minutes"), not strictly parsed — same
    posture as IntentField's "date" type already just storing whatever
    string the model extracted."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="SET NULL"), default=None
    )
    contact_email: Mapped[str | None] = mapped_column(String(255), default=None)
    contact_name: Mapped[str | None] = mapped_column(String(255), default=None)
    # Resolved against AppSettings.order_status_options at read time —
    # null here just means "not yet set," not an error, same posture as
    # AppSettings.chat_provider being nullable until the owner picks one.
    status: Mapped[str | None] = mapped_column(String(32), default=None)
    is_open: Mapped[bool] = mapped_column(Boolean, default=True)
    pickup_time: Mapped[str | None] = mapped_column(String(255), default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    total_amount: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
    )


class OrderItem(Base):
    """One line item on an Order — item_name_snapshot/unit_price_snapshot
    are captured at add-time so a line item stays human-readable and its
    original price stays intact even if the referenced Product is later
    renamed, repriced, or deleted (ON DELETE SET NULL on product_id, not
    a cascade — the same "keep the historical record readable" reasoning
    as CrmEntry.intent_schema_id).

    `comment`/`served` (2026-08-20) support a dine-in "kitchen ticket"
    workflow on top of the existing columns above, not a new table — the
    user's own explicit call: this app's scale doesn't need a separate
    fulfillment entity, two more columns on the line item that already
    exists is enough. `comment` is a free-text customization ("less
    sugar", "extra spicy") — same "just store what the visitor typed,
    don't strictly parse it" posture as `Order.pickup_time`. Because a
    comment distinguishes otherwise-identical line items (two lattes, one
    "less sugar" and one plain, must stay two separate rows, not merge
    into quantity=2), `cart.apply_order_delta` now matches an existing
    item to merge into by `(product_id, comment)`, not `product_id`
    alone — see that function's own docstring. `served` is a plain
    boolean, not a free-text status, mirroring `Order.is_open`'s own
    "one hard signal, not inferred from free text" reasoning — staff
    toggle it directly in OrderPanel; unlike `Order.status`, owner-agent
    has no tool to set it (this is a live kitchen-floor action, not a
    cheap-to-adjust configuration value)."""

    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), default=None)
    item_name_snapshot: Mapped[str] = mapped_column(String(255))
    unit_price_snapshot: Mapped[float] = mapped_column(Numeric(10, 2))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    subtotal: Mapped[float] = mapped_column(Numeric(10, 2))
    comment: Mapped[str | None] = mapped_column(String(255), default=None)
    served: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    order: Mapped["Order"] = relationship(back_populates="items")


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
