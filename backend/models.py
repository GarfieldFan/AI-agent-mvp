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
    # Nullable (2026-08-22, was NOT NULL) — an account created via OAuth
    # (apis/oauth.py) has no local password at all; the owner confirmed
    # directly that admin/owner accounts stay password-only, so this is
    # only ever null for a `role == "user"` account. Login still checks
    # this the same way it always did (apis/auth.py's login) — an
    # OAuth-only account simply can never succeed there, which is
    # correct: its only real login path is the OAuth flow.
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Plain string, not a DB enum — matches apis/deps.py's Role(str, Enum)
    # by value, kept as a string here so seeding/migrating doesn't need to
    # touch a Postgres enum type if roles ever change.
    role: Mapped[str] = mapped_column(String(32), default="user")
    # Which OAuth provider last authenticated this account (2026-08-22,
    # e.g. "google") — null for a password-only account. Informational
    # only (shown in a future user-management UI); identity matching
    # itself is by email (see apis/oauth.py's find-or-create), not this
    # field — a real deployment's own choice to trust a provider's
    # verified email as the join key across providers, not a stored
    # per-provider subject id (out of scope for this app's current
    # single-tenant scale).
    oauth_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Added 2026-08-22, pre-emptively — this app has no public password
    # self-signup today (apis/auth.py's own docstring: "no signup"), so
    # the attack this guards against isn't exploitable yet, but the user
    # asked to close it now rather than risk forgetting once self-signup
    # ever gets built: WITHOUT this flag, an attacker could pre-register
    # an unverified password account under a victim's real email, then
    # silently retain access once the real owner later signs in with
    # Google (apis/oauth.py's find-or-create merges by email alone — see
    # that module's own docstring). False by default (the cautious
    # state) — any *future* account-creation path that doesn't
    # explicitly reason about this defaults to "not verified," never
    # "trusted." Only ever set True by a path that has real proof of
    # email ownership: seed.py's own admin-provisioned demo accounts,
    # and apis/oauth.py's Google callback (Google itself verifies the
    # email). apis/oauth.py's callback checks this on every "existing
    # user" merge — an unverified existing account gets its
    # `hashed_password` cleared and `email_verified` flipped to True
    # (the verified owner reclaims the account; whoever set that
    # original unverified password loses access), rather than silently
    # trusting whatever was there before.
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
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
    # Set only for a document ingested via POST /agent/documents/ingest-
    # from-url (2026-08-21) — null for every plain file upload. Lets
    # `_run_url_ingest` (apis/documents.py) re-fetch the same source on a
    # manual "Re-sync" click or a recurring ScheduledTask, and lets
    # DocumentManager show where a document actually came from.
    source_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # Added 2026-08-21 — a real distinction the user raised directly:
    # some ingested documents ARE facts about the business itself (a
    # service description, a company profile), others are background
    # reference material the business operates within but doesn't own
    # (a statute, a regulation, a legal code — the motivating example was
    # literally "the Constitution isn't company material, but the chatbot
    # still needs to know about it"). True (the default — every existing
    # and future document unless explicitly marked otherwise) means
    # "treat this as a fact about the business" — apis/agent.py's
    # _gather_ready_document_text (feeding generate_geo_page,
    # detect_business_type, propose_intent_schema, and
    # business_profile.py's suggest endpoint) only includes
    # is_company_material=True documents, since synthesizing "who is this
    # company" content from a law's own text would misrepresent it as a
    # company fact. False documents are still fully searchable in
    # ordinary RAG retrieval (apis/chat.py's /api/chat) — retrieve.py
    # flags them in the context block so the model treats them as
    # background reference, not an authoritative company fact, and (via
    # the owner's own configurable chat_system_prompt, see apis/
    # chat_settings.py) an owner can instruct the public chatbot to stay
    # general and defer specifics to a real professional consultation
    # when citing this kind of source — a boolean flag, not free-text
    # tags, same "one hard signal, not inferred from free text" posture
    # as Order.is_open/OrderItem.served elsewhere in this app.
    is_company_material: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Added 2026-08-21, generalizing the legal "repealed/proposed" example
    # the user raised into an industry-agnostic mechanism — free text, not
    # a fixed enum, same "owner defines their own vocabulary" posture as
    # CrmEntry.status/Order.status/IntentView.status_options elsewhere in
    # this app (a hardcoded "repealed"/"in-force"/"proposed" enum would
    # only fit law; the next owner might need "discontinued"/"superseded
    # form"/"experimental" for an entirely different industry). Null means
    # no status note at all — the common case, no behavior change.
    # apis/chat.py's context-block formatting surfaces this note to the
    # model alongside a retrieved chunk; SYSTEM_PROMPT tells the model to
    # weigh it when answering, without this app ever hardcoding what any
    # particular status word means. Settable manually or via an optional
    # LLM-suggested draft at ingest time (apis/documents.py's
    # _suggest_status_note) — conservative by design, only ever proposes a
    # note when the source text explicitly states its own status, never a
    # guess.
    status_note: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    # Payment gate (2026-08-20, see backend/payments.py) — same
    # "swappable provider, null means use the default" posture as every
    # AI provider above, extended to a new capability domain: actually
    # taking money for an Order. Deliberately a separate, distinct set of
    # fields from the AI-provider ones above, not reused, even though the
    # *pattern* is identical — this is not an AI capability. `null`/
    # `"test"` (the default) means no real charge ever happens; checkout
    # works with zero configuration, same as chat/vision/embedding/image
    # generation all falling back to Ollama/ComfyUI with nothing set.
    # `stripe_secret_key` is write-only, same echo-back rule as
    # `custom_api_key` — never returned by GET /agent/payment-settings.
    # `stripe_publishable_key` is the one exception: Stripe's own
    # publishable key is meant to be public (it's embedded in client-side
    # JS on every Stripe integration), safe to echo back and expose to
    # the browser. `stripe_webhook_secret` verifies that
    # POST /webhooks/stripe requests actually came from Stripe (HMAC
    # signature check, backend/payments.py's verify_stripe_webhook) —
    # without it, anyone who found that URL could POST a fake
    # "payment succeeded" event.
    payment_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stripe_secret_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stripe_publishable_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stripe_webhook_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Email + SMS gate (2026-08-20, see backend/notifications.py) — the
    # identical "swappable provider, null/'test' means the default no-op"
    # pattern as payment above, applied to a third capability domain.
    # Nothing in this app currently triggers a real send automatically
    # (see notifications.py's own docstring) — these fields exist purely
    # so a provider CAN be configured and tested; `apis/notifications.py`'s
    # test-send endpoints are the only current callers.
    # `mailgun_api_key`/`twilio_auth_token` are write-only, same echo-back
    # rule as `stripe_secret_key` above. `mailgun_domain`/
    # `mailgun_from_address`/`twilio_from_number`/`twilio_account_sid`
    # aren't secrets (a Twilio Account SID is a public identifier, the
    # same way a Stripe publishable key is) — safe to echo back.
    email_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mailgun_api_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mailgun_domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mailgun_from_address: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sms_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    twilio_account_sid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    twilio_auth_token: Mapped[str | None] = mapped_column(String(255), nullable=True)
    twilio_from_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Map embed gate (2026-08-21, see backend/maps.py) — same "swappable
    # provider, null/'test' means the safe zero-config default" pattern as
    # payment/email above, extended to a fourth capability domain: showing
    # a business location. `null`/`"test"` means no live in-page embed —
    # `MapBlock` still always renders a plain "open in Google Maps" link
    # built client-side from its own query text, independent of this
    # setting entirely (the redirect floor the owner asked about is
    # unconditional). Unlike stripe_secret_key/mailgun_api_key/
    # twilio_auth_token, Google's own Maps Embed API key is DESIGNED to be
    # used client-side (restricted via Google Cloud Console's own
    # HTTP-referrer allowlist, not a bearer-style secret) — still kept
    # write-only here anyway, same echo-back rule as every other
    # credential in this app, since backend/maps.py assembles the embed
    # URL server-side and the browser never needs the raw key at all.
    map_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    google_maps_api_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Business profile (2026-08-21, see backend/apis/business_profile.py) —
    # structured "who/where/how to reach us" facts, the input this app was
    # missing for real GEO (Generative Engine Optimization): a JSON-LD
    # schema.org LocalBusiness block only an AI/search crawler reads, not
    # a human-facing page. Deliberately owner-entered/confirmed, never
    # LLM-written directly — same "misread real-world fact has real
    # consequences" posture as Product pricing and IntentSchema
    # definitions elsewhere in this app (a wrong phone number sends a real
    # customer to the wrong place). An LLM CAN suggest a first draft from
    # ingested documents (mirrors detect_business_type's own "propose,
    # never auto-write" precedent) but never saves anything itself.
    # No secrets here — every field is safe to echo back and, in fact,
    # meant to be publicly crawlable (GET /api/business-profile has no
    # auth gate at all, unlike payment/notification/map's write-only
    # credential fields).
    business_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    business_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A schema.org type (https://schema.org/LocalBusiness and its many
    # subtypes, e.g. "Plumber", "Restaurant", "Dentist") — free text, not
    # a closed enum, since schema.org has hundreds of business subtypes
    # and this app has no reason to maintain its own copy of that list.
    # None/blank falls back to the generic "LocalBusiness" at JSON-LD
    # build time (frontend/src/lib/business-profile.ts).
    business_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    business_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    business_phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    business_street_address: Mapped[str | None] = mapped_column(String(255), nullable=True)
    business_locality: Mapped[str | None] = mapped_column(String(120), nullable=True)
    business_region: Mapped[str | None] = mapped_column(String(120), nullable=True)
    business_postal_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    business_country: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # None falls back to FRONTEND_PUBLIC_URL (this deployment's own known
    # public origin) at read time — see apis/business_profile.py.
    business_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    business_logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Each entry a schema.org openingHours-spec string (e.g.
    # "Mo-Fr 09:00-17:00", "Sa 10:00-14:00") — one owner-typed line per
    # entry (see BusinessProfilePanel), not a day-by-day time-picker UI;
    # a deliberate v1 scope cut, same "simplest thing that produces valid
    # structured data" posture as Order.pickup_time staying free text.
    business_hours: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    # sameAs URLs (other authoritative profiles: Google Business Profile,
    # Yelp, Facebook, ...) — corroborates entity identity for AI/search
    # crawlers the same way Product.tags corroborates product identity;
    # same JSONB-list-of-strings shape, kept consistent with that
    # existing precedent rather than a second, differently-shaped list
    # field.
    business_social_links: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    # Owner-configurable public-chat system prompt (2026-08-21, see
    # apis/chat.py's `_resolve_system_prompt` and apis/chat_settings.py) —
    # null/empty means "use the built-in SYSTEM_PROMPT default." A
    # deliberate, confirmed-with-the-user design: the owner may FULLY
    # REPLACE this text, not just append to it — safe to allow in full
    # because every dynamic per-turn fact (RAG excerpts, visitor
    # identity, in-progress intake state, order/cart state) is injected
    # into the USER message, never this system string, and the separate
    # lead-capture/order-extraction classification calls run against
    # their own fixed prompts this field never touches. See
    # `_resolve_system_prompt`'s own docstring for the full reasoning.
    chat_system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Social login for the public `user` tier only (2026-08-22, see
    # apis/oauth.py) — confirmed directly with the user: admin/owner stay
    # on the existing password+JWT system, never OAuth, since those
    # accounts hold real privilege and shouldn't depend on a third-party
    # identity provider's own account security/recovery. Same
    # owner-configured-credentials pattern as Stripe/Mailgun/Twilio —
    # `google_oauth_client_secret` is write-only, never echoed back by
    # GET /agent/oauth-settings; `google_oauth_client_id` is safe to echo
    # (it's embedded in the browser-visible authorize-URL redirect
    # anyway, same posture as Stripe's own publishable key). "Configured"
    # is derived from both being non-null — no separate enabled flag,
    # same posture as apis/notifications.py's is_email_configured.
    google_oauth_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_oauth_client_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Facebook (2026-08-22) — same authorization-code-grant shape as
    # Google, a real second implementation once Google was proven.
    facebook_oauth_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    facebook_oauth_client_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # X (2026-08-22) — NOT the same flow shape as Google/Facebook: OAuth
    # 2.0 with PKCE (apis/oauth.py generates and stores a code_verifier
    # per attempt, not just a state nonce). Flagged clearly to the owner
    # in OAuthSettingsPanel and in apis/oauth.py's own docstring: X's
    # standard API does not reliably return an email address at all —
    # that needs an elevated permission from X's own Developer Portal
    # this app has no control over, so X sign-in may simply fail at the
    # "no email returned" step depending on what the owner's X app is
    # actually approved for. Built anyway, honestly documented rather
    # than silently omitted, since the user asked for the interface to
    # exist and be ready.
    x_oauth_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    x_oauth_client_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
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
    # Cross-session resume via an emailed one-time code (2026-08-20,
    # apis/crm_resume.py) — closes a real gap flagged earlier: a visitor
    # who abandons a multi-turn structured intake (an insurance claim
    # mid-fill, say) in one browser session currently can't be reunited
    # with their own in-progress entry in a new one at all —
    # apis/chat.py's `_find_active_entry` is deliberately scoped to one
    # `chat_session_id` only (see that function's own docstring for the
    # scope decision behind that). Verifying a one-time code emailed to
    # the address already on file — rather than trusting a re-typed
    # email alone — is what makes resuming safe to build: without it,
    # anyone who merely knew a visitor's email could read/continue their
    # claim (real PII sits behind this: incident details, phone,
    # attached photos). `resume_code_hash` is a SHA-256 hash, never the
    # plaintext code — the code itself is only ever held in memory long
    # enough to email it. `resume_code_attempts` caps guesses at a fixed
    # limit (`apis/crm_resume.py`'s MAX_RESUME_ATTEMPTS) — a 6-digit code
    # has only a million possibilities, so a short expiry + a hard
    # attempt cap does the real work here, not hash strength. This whole
    # feature is inert until an owner configures a real email provider
    # (`apis/notifications.py`'s `is_email_configured`) — there's no way
    # to deliver a code otherwise.
    resume_code_hash: Mapped[str | None] = mapped_column(String(64), default=None)
    resume_code_expires_at: Mapped[datetime | None] = mapped_column(default=None)
    resume_code_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
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
    # Payment state (2026-08-20, backend/payments.py) — deliberately
    # separate from `status` above, not a value stuffed into that same
    # free-text field: `status` is a label owner-agent (or the owner
    # themselves) can set to literally anything via
    # set_order_status_options, so it can never be a trustworthy signal
    # for "did a real payment actually succeed." `payment_status` is
    # never owner-agent-writable — only POST /cart/checkout (for the
    # "test" provider's synchronous skip) and POST /webhooks/stripe (for
    # a real Stripe confirmation) ever set it. "unpaid" (default) ->
    # "paid" | "failed"; "refunded" exists as a value this column can
    # hold but nothing currently sets it — a real refund flow isn't
    # built yet, see the root AGENTS.md.
    payment_status: Mapped[str] = mapped_column(String(16), default="unpaid", server_default="unpaid")
    payment_provider: Mapped[str | None] = mapped_column(String(32), default=None)
    # Stripe's own Checkout Session id — what POST /webhooks/stripe
    # matches an incoming event back to the right Order by, never
    # anything the browser itself supplies (the browser can't be trusted
    # to say which order got paid).
    payment_reference: Mapped[str | None] = mapped_column(String(255), default=None)
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


class ScheduledTask(Base):
    """A generic recurring job (2026-08-21, see backend/scheduler.py) —
    not embed-specific despite the feature that motivated it (re-syncing
    a URL-ingested legal document daily). `task_type` is a dispatch key
    into `scheduler.TASK_REGISTRY`; any already-existing, already-real
    maintenance action in this app (re-sync a URL document, re-embed
    everything, clean up orphaned chat uploads, purge stale CRM entries,
    ...) becomes schedulable by adding one small registry entry that
    calls the function that already exists — this table doesn't know or
    care what a task_type actually does, only when to run it.

    Two independent interfaces write to this same table: a real CRUD API
    (apis/scheduled_tasks.py, for an owner who wants to inspect/edit
    directly) and owner-agent's `manage_scheduled_task` tool (for "just
    tell it what you want in plain language") — neither is more
    authoritative than the other, they're just two ways to reach the
    same mechanism, same "give the owner choices" posture as everything
    else in this app."""

    __tablename__ = "scheduled_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    task_type: Mapped[str] = mapped_column(String(64))
    task_args: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Standard 5-field cron syntax ("minute hour day month weekday"), e.g.
    # "0 3 * * *" for daily at 03:00 — parsed via APScheduler's own
    # CronTrigger.from_crontab, no custom scheduling DSL invented here.
    cron_expression: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    last_run_at: Mapped[datetime | None] = mapped_column(default=None)
    # "success" | "error" | null (never run yet)
    last_run_status: Mapped[str | None] = mapped_column(String(16), default=None)
    last_run_error: Mapped[str | None] = mapped_column(Text, default=None)
    created_by: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
