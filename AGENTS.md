# AI MVP — project reference

Read this before doing anything else in this repo. It's a **current-state
reference**, not a changelog — it tells you what exists and why, not the
story of how it got built. For the full chronological development log
(every bug found, every decision debated, every verification run) see
**`HISTORY.md`** — read it only when you need the deep "why" behind a
specific decision below; don't load it by default.

The original project plan (positioning, tech choices, phased build order,
interview talking points) is `ai-mvp-project-plan.pdf` — this file tracks
status against that plan, not the plan itself.

**Keep this file current**: when you finish a chunk of work, update the
relevant section here with the *current-state fact*, and put any bug
story/verification narrative worth preserving into `HISTORY.md` instead
of bloating this file. This file should stay short enough to read in
full every session; `HISTORY.md` is allowed to keep growing.

## Architecture snapshot

```
                +----------------------+
                |       Next.js UI     |
                +----------+-----------+
                           |
                          REST
                           |
                +----------v-----------+
                |        FastAPI        |
                +----------+-----------+
                           |
        +------------------+------------------+------------------+
        |                  |                  |                  |
+-------v------+   +-------v------+   +-------v-------+   +------v-------+
| AI Providers |   |     RAG      |   | Agent console |   | owner-agent  |
+-------+------+   +-------+------+   +-------+-------+   +------+-------+
        |                  |                  |                   |
  Ollama / OpenAI    pgvector DB +      deterministic        isolated LLM
  Anthropic /           Documents      pipelines only —      tool-calling
    Gemini                            no LLM tool-selection    loop, own
                                      (CRM, ComfyUI poster    container/port,
                                        gen, page gen)       owner-only, calls
                                                             agent console's
                                                             REST endpoints
```

REST only (no WebSocket — chat is a single non-streaming call today, see
Phase 3 below). "Agent console" is the deliberate name, not "AI Agent" —
see "Architecture decisions" below for why that distinction matters.
`owner-agent` is a genuinely separate service (own container, own port
8100), not another `backend` router — see "Agent execution must
eventually be isolated" below.

```
ai-employee/
├── ai-mvp-project-plan.pdf   the plan (source of truth for scope/rationale)
├── HISTORY.md                 full chronological development log — read on demand, not by default
├── docker-compose.yml        backend + frontend + postgres-db + owner-agent services
├── .env / .env.example       host/ports/ComfyUI config — see "Configuration" below
├── backend/                  FastAPI (Python) — see backend/main.py
│   ├── db.py                  SQLAlchemy engine/session (DATABASE_URL), Base, get_db dependency
│   ├── models.py               User / Page / PageVersion / Document / DocumentChunk / AppSettings / ChatSession / ChatMessage / CrmEntry ORM models
│   ├── auth.py                 password hashing (bcrypt) + JWT sign/verify (PyJWT)
│   ├── seed.py                 creates the 3 demo accounts — run manually after migrating
│   ├── ingest.py                RAG doc parsing (pdf/docx/md/txt) + chunking — pure functions, no I/O
│   ├── retrieval.py              RAG retrieval: embed -> pgvector search -> scored chunks (no router — called from apis/chat.py)
│   ├── llm_json.py                lenient JSON extraction from raw LLM output, shared by agent.py/chat.py/chat_attachments.py
│   ├── chat_attachments.py        public-chat file upload storage + vision/document analysis — see "Chat lead capture" below
│   ├── rate_limit.py               per-IP rate limiting for the 3 fully public routes — see "Rate limiting" below
│   ├── providers/                AI provider abstraction (Ollama/OpenAI/Anthropic/Gemini) — see "AI provider is swappable" below
│   ├── alembic/                 migrations — env.py wired to DATABASE_URL + models' metadata
│   └── apis/
│       ├── api.py             ComfyUI image-gen wrapper; URLs env-driven, see "Configuration" below
│       ├── auth.py            POST /auth/login, GET /auth/me
│       ├── chat.py            user-tier chat (public): retrieval.py + ChatProvider, RAG-grounded when relevant, no tools; logs sessions (ChatSession/ChatMessage)
│       ├── agent.py           admin/owner-only "agent console" — every route real (see "Agent console capabilities" below)
│       ├── documents.py        RAG document management (admin): upload/list/delete
│       ├── media.py            CTE media library (admin): list ComfyUI-output + uploaded images, upload
│       ├── model_settings.py   owner-facing AI model picker (admin): list models, get/set global chat+vision model
│       ├── pages.py            page storage: save/list/restore/delete (admin) + public read-by-slug
│       └── deps.py            RBAC: Role enum + require_role() dependency, backed by real JWTs
├── owner-agent/               isolated LLM tool-calling loop, own container/port 8100 — see "Owner agent" below
│   ├── deps.py                 owner-only JWT check (duplicated from backend, not imported — see below)
│   ├── tools.py                 fixed 8-tool allowlist + execute_tool() (HTTP calls onto backend)
│   ├── agent_loop.py             the loop itself: JSON-envelope tool selection against Ollama
│   ├── logging_.py                action log: stdout + logs/runs.jsonl (never the bearer token)
│   └── main.py                  FastAPI app: GET /health, POST /run
└── frontend/                 Next.js (TypeScript) — see frontend/AGENTS.md + frontend/HISTORY.md
    └── src/components/...    reusable component catalog lives there
```

All four services (`backend`, `frontend`, `postgres-db`, `owner-agent`) run
via `docker-compose up` — backend on :8000, frontend on :3000,
Postgres+pgvector on :5432, owner-agent on :8100. Both `backend/` and
`frontend/` are bind-mounted with hot reload; `frontend/node_modules` and
`frontend/.next` are anonymous volumes so the container's Linux-native
`node_modules` isn't shadowed by the host's Windows one (see
`frontend/Dockerfile`). `owner-agent/` is also bind-mounted with hot
reload (`--reload`, `WATCHFILES_FORCE_POLLING=true`, same as `backend`) —
`owner-agent/logs/` is a bind-mounted, gitignored directory, not a named
volume.

**Git**: the project root has its own git repo (separate from
`frontend/`'s own nested repo, a `create-next-app` scaffolding artifact)
— a rollback needs `git reset --hard` in both places if ever needed, not
just one.

## Configuration: root `.env`

`HOST`, `BACKEND_PORT`, `FRONTEND_PORT`, `OWNER_AGENT_PORT`, `JWT_SECRET`,
`COMFYUI_HOST`, `COMFYUI_PORT`,
`COMFYUI_HOST_OUTPUT_DIR` — copy `.env.example` to `.env` and adjust for
your machine; `docker-compose.yml` composes these into the actual URLs/
port-mappings/bind-mounts via `${VAR}` substitution, which
`backend/apis/api.py` reads via `os.environ.get(...)` with defaults
matching what used to be hardcoded. Nothing here is fixed on purpose —
ComfyUI could be swapped for a different SD backend, host/ports differ
per machine — same "swappable, not hardcoded" principle as the AI
providers below.

**`JWT_SECRET` must be a real random value in your own `.env`, not
`.env.example`'s literal default.** That default (`dev-only-insecure-
secret-change-me`) is public — it's committed to this repo's source —
so a process actually running with it lets anyone who's read this code
forge a valid `role: owner` JWT and get full admin access with no
credentials at all. A real local `.env` (2026-08-08) now sets this to a
generated random value; `.env.example` intentionally keeps the insecure
literal as a visible placeholder/warning, not a value anyone should
actually run with. Rotating this value invalidates every previously-
issued token — expected, not a bug, when it happens. **The frontend now
detects this on its own** (2026-08-09,
`components/modules/agent-console-section.tsx`): a still-cached
`localStorage` token that claims `admin`/`owner` gets re-verified against
`GET /api/auth/me` before any gated panel renders, and a confirmed-401
result triggers `clearAuth()` + a "your session has expired" message —
see "Known gotchas" below and `HISTORY.md`'s 2026-08-09 entry. A plain
page refresh after a secret rotation is enough to clear a dead session;
no manual logout/login is required to *see* the correct state, though
logging back in is still how you get a working one.

**Postgres's `5432` port is bound to `127.0.0.1` only (2026-08-08), not
`0.0.0.0`.** `backend`/`owner-agent` never use this host-side mapping at
all — they reach Postgres over Docker's internal network
(`postgres-db:5432`) — it exists purely so a local DB client on the same
machine (psql, pgAdmin, DBeaver, ...) can still connect for debugging.
Binding it to every interface would let anyone who can reach this
machine's network connect directly with the hardcoded `my_user`/
`my_password` credentials (`docker-compose.yml`) and read/write the
whole DB, bypassing every RBAC/JWT check in the app entirely.

## Architecture decisions

These are durable design choices — read them before touching the areas
they govern. Each links to `HISTORY.md` for the full reasoning/debate if
you need it.

**RBAC gates agent/tool access, not just data.** `/api/chat` (public,
`user` role, no auth) can only reach plain LLM inference — no tools, no
filesystem, no agent framework. `backend/apis/agent.py`'s routes
(document ingestion, page generation, poster generation, CRM, reports)
are all gated by `Depends(require_role(Role.admin, Role.owner))`
(`backend/apis/deps.py`) — a `user`-role request 403s before the handler
runs. This split exists specifically so a prompt-injected public chatbot
turn can never reach a privileged action. `backend/apis/deps.py` decodes
a real signed JWT (issued by `POST /api/auth/login`); no token or an
invalid one silently resolves to the anonymous `user` role (so the
public chatbot keeps working with no login), only `require_role`-gated
routes actually reject.

**Agent execution must eventually be isolated from the API process — now
partially built.** Every real `apis/agent.py` capability is still a
**deterministic, non-agentic pipeline call** (no LLM tool-selection, no
agent loop) — none of them are the kind of real, arbitrary tool access
this principle guards against. The rule this principle sets: any handler
that does grow into an actual agent loop calling tools must NOT run inside
the same container/process as the public-facing `backend` service — it
belongs in a separate, narrowly-scoped worker.

That worker now exists: **`owner-agent/`** (its own docker-compose
service, port 8100). It's a real LLM tool-calling loop — the owner types a
command, a local Ollama model decides which of a fixed 8-tool allowlist to
call, in what order, chaining results turn-to-turn (see "Owner agent" in
Phase 6 below for the full design). It independently re-verifies the
caller's JWT and requires `Role.owner` specifically (stricter than
`backend`'s admin+owner gate), forwards that same token on every tool call
so `backend`'s own `require_role` re-authorizes every real action too, and
has no DB connection, filesystem access, or shell — its only I/O is
Ollama and `backend`'s own REST surface. Explicitly NOT wired to the
user's personal openclaw instance (`ws://127.0.0.1:18789`, broad
personal-account access) — `owner-agent` reuses the *isolation pattern*
openclaw's docs describe, not openclaw itself.

**AI provider is swappable — a deliberate second differentiator, not a
RAG implementation detail.** `backend/providers/`: `ChatProvider`/
`EmbeddingProvider` protocols (`providers/base.py`), real implementations
per vendor (`ollama.py`, `openai.py`, `anthropic.py`, `gemini.py`,
`custom.py`), one selection point (`providers/registry.py` for the 4
named vendors, plus a `"custom"` special case in `apis/model_settings.py`
— see below), env-var or per-request override via the owner-facing model
picker. `backend/retrieval.py` and `backend/apis/chat.py` are built
against the protocols, never against Ollama directly. **Ollama, and now
`custom`, actually work today** — OpenAI/Anthropic/Gemini are real
API-call implementations, not stubs, but raise a clean
`ProviderNotConfigured` 503 until their API key env var is set (none are,
by design — no paid keys provided).
- **`custom` chat provider** (2026-08-18, `providers/custom.py`) — points
  at any self-hosted OpenAI-compatible chat endpoint (llama.cpp's
  `llama-server`, vLLM, LM Studio, ...) that speaks the same
  `/chat/completions` + `/models` surface this codebase already uses for
  Ollama. Unlike the 4 named providers, there's no fixed URL/env var —
  `AppSettings.custom_base_url`/`custom_api_key` (nullable columns) hold
  the one configured endpoint (shared with `vision_provider == "custom"`,
  see below), set via the model picker's "Test connection" flow (below),
  not an env var. `apis/model_settings.py`'s `resolve_chat_provider`/
  `resolve_vision_provider` special-case `provider == "custom"` directly
  (construct `CustomChatProvider` from the stored row) rather than
  routing through `providers/registry.py`, since the registry's
  `get_chat_provider(name, model)` has no slot for a per-install
  base_url/api_key.
- `ChatProvider` swaps freely, per-call, no side effects on stored data.
- **`EmbeddingProvider` is owner-configurable too now** (2026-08-18,
  `apis/model_settings.py`'s `resolve_embedding_provider`,
  `AppSettings.embedding_provider`/`embedding_model`/
  `embedding_dimensions`) — but switching it still isn't free, and was
  never going to be: different providers produce different vector
  dimensions (nomic-embed-text: 768, OpenAI: 1536, Gemini: 768, custom:
  unknown until probed), and pgvector can't compare vectors from
  different embedding spaces. `DocumentChunk.embedding` is now a
  **dimension-less** `Vector()` column (not a fixed `Vector(768)`) —
  consistency across rows is an application-level invariant instead of a
  DB-level one: `update_settings` clears the whole `document_chunks`
  table the instant the effective embedding provider/model actually
  changes, and `POST /agent/documents/reembed-all` (`apis/documents.py`)
  is the explicit recovery step that re-parses every document's
  still-on-disk raw file and repopulates it under the new config.
  `apis/chat.py`'s RAG retrieval degrades to plain chat (no citations,
  no 500) while a document is stale — see `DocumentSummary.needs_reembed`
  and `DocumentManager`'s "Re-embed all documents" banner. `custom`
  embedding gets its **own** endpoint — `AppSettings.embedding_base_url`/
  `embedding_api_key`, separate from `custom_base_url`/`custom_api_key`
  (chat+vision's shared endpoint) — 2026-08-18, split apart from an
  earlier "one shared endpoint for all three" design once a real setup
  needed it: llama.cpp's embedding mode (`--embedding`) is a
  process-level flag that can't coexist with a chat model in the same
  router instance, so a real local rig runs chat/vision and embedding as
  two separate `llama-server` processes on two different ports and needs
  two different `custom_base_url`-shaped fields to point at them. No
  `AnthropicEmbeddingProvider` exists — Anthropic has no embeddings API,
  a vendor gap, not an oversight.
- **Owner-facing model picker** (`ModelSettingsPanel`, `/dashboard`):
  `GET /agent/models` lists what's actually usable (Ollama queried live
  via `ollama show`'s `capabilities`, cloud entries `selectable: false`
  until their key is set), `GET/PUT /agent/settings` persists the pick
  globally (`AppSettings` singleton row, id always 1) — applies to every
  visitor immediately, survives a restart. **Chat model selection is
  fully real across every configured provider.** **Vision model
  selection is also real across every provider** (2026-08-18, no longer
  Ollama-only) — `resolve_vision_provider` mirrors `resolve_chat_provider`
  exactly, and every provider's `ChatProvider.chat()` now accepts an
  image content part (`providers/base.py`'s `parse_data_uri`,
  `providers/anthropic.py`'s `_to_anthropic_content`, `providers/
  gemini.py`'s `_to_gemini_parts` — Ollama/OpenAI/custom pass the
  OpenAI-compatible shape straight through). Every vision-capable
  provider (Ollama live-queried, custom live-queried, cloud providers
  assumed vision-capable on their default flagship model) is selectable,
  not just shown for roadmap visibility. **Embedding model selection is a
  third, independent picker** (2026-08-18) — see the `EmbeddingProvider`
  bullet above for what changing it actually does. Two independent
  "Custom endpoint" blocks sit in this panel, not one (2026-08-18 split —
  see the `EmbeddingProvider` bullet above): base URL + optional API key
  + **Test connection** (`POST /agent/models/test-custom`, doesn't
  persist anything, just probes `GET {base_url}/models`) — one instance
  feeds **both** the chat and vision dropdowns as `provider: "custom"`
  options (llama.cpp's `/models` output doesn't distinguish chat from
  embedding models, but does report vision capability per-model via
  `architecture.input_modalities`, which is what actually gates the
  vision dropdown's subset), a second, separate instance feeds embedding
  alone. `GET /agent/models` also live-queries both already-saved custom
  endpoints the same way it live-queries Ollama, so a previously-picked
  custom model still shows up selected after a reload without
  re-testing. Both `custom_api_key`/`embedding_api_key` are write-only —
  `GET /agent/settings` never echoes a saved key back to the browser;
  leaving a key field blank on save reuses that endpoint's
  previously-saved key **only** if its base URL is unchanged from what's
  stored. **`localhost`/
  `127.0.0.1`/`0.0.0.0`/`::1` are auto-rewritten to `host.docker.internal`**
  (`providers/base.py`'s `normalize_loopback_host` — moved there
  2026-08-18 so `providers/comfyui.py`'s image-gen "custom" endpoint can
  share it too, applied wherever a custom `base_url` is actually used —
  both provider classes and `list_custom_models`) — the address means
  "the `backend` container itself" from where the request actually runs,
  never what an admin filling in this field from their own browser means
  by it, so silently retargeting is the right default (same reasoning as
  `OLLAMA_BASE_URL`'s own `host.docker.internal` default). The stored
  `custom_base_url` keeps whatever the admin actually typed (so the
  field re-populates as typed on reload) — only the outbound request
  target is rewritten.
  `apis/model_settings.py`'s `_with_docker_loopback_hint` is the
  remaining fallback for the now-rare case a loopback address still
  fails post-rewrite (e.g. `host.docker.internal` itself unresolvable).
  **`update_settings` only live-revalidates a capability that's actually
  changing** — each of chat/vision/embedding is compared against its own
  *effective previous* value (same env-var-fallback logic as
  `_current_settings`) before deciding whether to re-check it against a
  live Ollama query. Without this, saving any one change (e.g. picking a
  custom chat model) while Ollama happened to be unreachable would fail
  on vision/embedding's still-default "ollama" picks purely because they
  couldn't be freshly re-verified — hit for real this session once chat
  moved off Ollama entirely while Ollama itself wasn't running. Actually
  changing a capability whose source is unreachable still correctly 400s.
- **Image generation is a fourth, independent picker** (2026-08-18,
  `AppSettings.image_provider`/`image_comfyui_url`) — shaped differently
  from the other three: it's a plain 3-way **provider** choice
  (comfyui/openai/gemini), not provider+model, since there's no
  meaningful model dimension yet (ComfyUI has one fixed workflow, each
  cloud vendor has one sensible default image model this round). "Custom"
  here specifically means "a different ComfyUI instance" — its own
  `image_comfyui_url` field, normalized via the same
  `normalize_loopback_host` helper, kept separate from `custom_base_url`
  since ComfyUI has no OpenAI-compatible-style universal API the way LLM
  backends do (unlike the chat/embedding custom endpoint, "custom" for
  image-gen isn't a stand-in for "any" self-hosted backend). `GET
  /agent/models`'s `image_providers` reports one `ModelOption` per
  provider (`model` holding a fixed label like `"dall-e-3"`, not
  something the admin picks) — comfyui's `selectable` reflects a live
  `/system_stats` reachability probe against whatever address is
  *currently configured* (`apis/model_settings.py`'s
  `_list_image_providers`, reused by `apis/agent.py`'s `get_integrations`
  so both surfaces agree). `resolve_image_provider(db)` (mirrors
  `resolve_chat_provider`) is what `generate_poster` now calls instead of
  hand-rolling ComfyUI's submit/wait/fetch-back sequence inline — see
  "Agent console capabilities" below.
  - **ComfyUI checkpoint is also owner-configurable, within one fixed
    workflow shape** (2026-08-19, `AppSettings.image_comfyui_unet`/
    `image_comfyui_clip`/`image_comfyui_vae`) — the fixed workflow
    (`comfy/image/image_z_image_turbo.json`) is a Flux/SD3-style split-file
    graph (`UNETLoader` + separate `CLIPLoader` + `VAELoader`, not a
    single-file `CheckpointLoaderSimple`), and `_build_payload_txt2img`
    (`apis/api.py`) already accepted `ckpt_name`/`clip_name`/`vae_name`
    overrides before this — `generate_poster` just never exposed the
    choice. Now it does: `apis/api.py`'s `list_comfyui_loader_options(
    base_url, node_class, param_name)` live-queries ComfyUI's own
    `GET /object_info/{node_class}` for what files it actually has (e.g.
    `UNETLoader`'s `unet_name` widget), surfaced as `GET /agent/models`'s
    `image_comfyui_assets` (`{unets, clips, vaes}`, tolerant of failure —
    empty lists, not an error, when ComfyUI's unreachable).
    `providers/comfyui.py`'s `ComfyUIImageProvider` takes optional
    `unet_name`/`clip_name`/`vae_name` — `None` means "use the workflow's
    own default file for that slot," only overridden when the owner
    actually picked something. Deliberately scoped to swapping files
    *within* this one node shape (e.g. a different Flux/SD3-family unet)
    — a fundamentally different SD architecture (single-file SDXL/SD1.5
    checkpoint) needs a different node graph this workflow doesn't have,
    out of scope for this round (confirmed with the user before
    building).
  - **An owner can also bring an entirely different ComfyUI workflow**
    (2026-08-19, `AppSettings.image_comfyui_workflow`/
    `image_comfyui_prompt_node`/`image_comfyui_prompt_field`) — pasted as
    ComfyUI's own "Save (API Format)" export via a `Textarea` in
    `ModelSettingsPanel`, any checkpoint architecture, any node layout
    (not constrained to the UNETLoader-shaped default above). When set,
    `providers/comfyui.py`'s `ComfyUIImageProvider.generate()` uses it
    **instead of** `_build_payload_txt2img` + the unet/clip/vae fields
    entirely — a pasted workflow already specifies its own
    checkpoint/sampler, so layering this app's own defaults on top would
    just be dead weight. Only the prompt text is wired in this round
    (`prompt_node`/`prompt_field` say which node/input to splice it into,
    field defaults to `"text"` when blank) — seed/width/height/etc. come
    from whatever the pasted workflow already has baked in, a deliberate
    v1 scope cut confirmed with the user. `update_settings` validates the
    pasted JSON parses, the named node exists, and it has the named input
    field — at save time, not generation time, so a typo surfaces
    immediately as a 400 instead of on the next poster click.

## Agent console capabilities (`backend/apis/agent.py`)

Every route here is admin/owner-gated. All of the following are **real**
— none of this router is a stub anymore:

- **`generate_landing_page`** — vision LLM (Ollama, model picker above)
  turns a design-image upload into a `PageSection[]` JSON schema (never
  raw HTML/CSS — see "Page schema" below), validated leniently (a
  malformed section/item is dropped, not fatal) via Pydantic.
  `_coerce_sections` also runs a recursive normalization pass first
  (`_normalize_container_type_aliases`) that rewrites a hallucinated bare
  `"type": "row"|"column"|"grid"` — at any nesting depth, including
  inside a container's own `children` — into the real `"type":
  "container", "layout": "..."` shape, since the model has been caught
  emitting this despite the prompt explicitly warning against it; see
  `HISTORY.md` for the real failure case this was found from.
- **`generate_poster`** — deterministic image-gen (owner-selectable
  provider, see "Owner-facing model picker" above — ComfyUI txt2img by
  default, or OpenAI/Gemini) + optional text overlay. `resolve_image_provider`
  returns an `ImageProvider` (`providers/base.py`) whose `generate()`
  always hands back both a stable URL and the raw bytes — OpenAI/Gemini
  persist their base64 response into `apis/media.py`'s `MEDIA_UPLOAD_DIR`
  (via the new shared `save_media_bytes` helper, also used by
  `upload_media`) rather than trusting a vendor's own often short-lived
  hosted URL; ComfyUI already has real bytes in hand after generating.
  `apis/api.py`'s ComfyUI wrapper functions (`_fetch_history_result`,
  `_wait_via_websocket`, `_wait_for_completion_impl`/`wait_for_completion`,
  `_cancel_task_internal`) all gained optional `base_url`/`public_url`/
  `ws_url` overrides (2026-08-18) so `providers/comfyui.py`'s
  `ComfyUIImageProvider` can point at a different ComfyUI instance
  without duplicating any of that logic — every override defaults to the
  original env-var constants, so the existing routes (`/generate-image`,
  `/wait/{id}`, the manual test form) are unchanged when called without
  one.
- **`generate_geo_page`** — same schema-generation pipeline as
  `generate_landing_page`, but text input (concatenated RAG document
  content, not an image) via `resolve_chat_provider` — auto-saves to the
  fixed slug `"seo"`. A GEO (Generative Engine Optimization) company-
  profile page for AI/search systems to read, not a human landing page.
- **CRM entry capture** (`POST`/`GET`/`DELETE /agent/crm/entries[/{id}]`,
  `PATCH /agent/crm/entries/{id}/status`) — stores a captured lead/inquiry in
  this project's own `CrmEntry` table (Postgres, not a third-party push —
  no CRM vendor account exists to integrate with; swapping in a real
  vendor call later doesn't change this shape). `category`
  (appointment/quote/claim/inquiry, nullable for older/manual rows) and
  `status` (new/contacted/closed, admin/owner-moved via the `PATCH`) are
  real columns as of 2026-08-08 — `CrmPanel` groups by category and lets
  admin/owner walk each entry through its status. Most rows now arrive
  from `apis/chat.py`'s automatic capture below, not the panel's manual
  form. `contact_name`/`contact_phone` (best-effort, from automatic
  attachment analysis) and `analysis_notes` (owner-triggered deep-scan
  results) round out the row — see "Chat lead capture & optional caller
  identity" below for both. `DELETE /agent/crm/entries/{id}` (2026-08-08)
  is the one destructive route in this router — no undo, removes the
  entry and (best-effort) its attached file together, since deleting a
  lead's DB row while leaving its file to rot in storage would just be a
  slower version of the orphan problem `cleanup_orphaned_uploads` (below)
  exists to catch.
- **Report generation** (`POST /agent/reports/generate`) — returns
  structured per-day data (new chat sessions, chat messages) computed
  from `ChatSession`/`ChatMessage`, not a `report_url` (no static-file
  generation infra exists) — the frontend charts it directly (`recharts`,
  `ReportPanel`). Scoped to chat volume only; "RAG query trends" isn't
  computable since whether a turn used retrieved context was never
  persisted per message.
- Document ingestion lives in `apis/documents.py`, not `agent.py` — see
  "RAG" below.

## RAG (retrieval-augmented generation)

Ingest: `backend/ingest.py` (parse pdf/docx/md/txt, paragraph-aware
800-char/100-overlap chunking) → `Document`/`DocumentChunk` tables
(`DocumentChunk.embedding` is a dimension-less pgvector column now, not
fixed to Ollama's nomic-embed-text — see the provider note above).
`DocumentManager` (frontend, `/dashboard`) is the admin-facing
upload/list/delete UI, plus (2026-08-18) a per-document "Needs re-embed"
badge and a "Re-embed all documents" banner/button
(`reembedAllDocuments`) for after an embedding provider switch.

**Merged into the main `/chat` chatbot**, not a separate `/knowledge`
page (retired). Every `/api/chat` turn retrieves the top-k closest chunks
unconditionally (when `status="ready"` documents exist) and hands **all**
of them to the model as optional context — the model itself judges
relevance via the system prompt ("use if relevant, otherwise ignore"), no
separate classifier. A cosine-similarity cutoff (`chat.py`'s
`MIN_CITATION_SCORE = 0.4`) gates only which chunks are worth showing as
citation chips — it has **no effect** on what the model sees (an earlier
version conflated these two decisions and broke cross-lingual retrieval
entirely; see `HISTORY.md` for the full bug). Citations are also deduped
**per document**, not per chunk (`chat.py`, `sources` list keeps only the
highest-scoring chunk per `document_id`) — a multi-chunk document
matching on several chunks used to render the same filename as several
identical-looking citation chips (`SourceCitationList`).

`Editable`/CTE aside — the vision LLM's own output is always plain
markdown-ish JSON per the schema below, never raw HTML.

## Chat lead capture & optional caller identity (`backend/apis/chat.py`)

Added 2026-08-08, still on the public/tool-free `/api/chat` path — see
the RBAC note above for why this doesn't reopen that boundary. Full
build/verification narrative for everything in this section lives in
`HISTORY.md`'s 2026-08-08 entries — this section states current-state
facts only.

- **Lead capture**: this MVP has no separate contact form, so a visitor
  can book an appointment / request a quote / file a claim entirely
  inside the chat. `_maybe_capture_lead` runs one fixed-shape
  classification call (is this a real lead? which category? what email?
  name? phone?) after the main reply is generated, gated so it only fires
  on a turn that's email-shaped (`_LEAD_EMAIL_RE`), from a caller with a
  known account email, or carrying an attachment (below) — not on every
  ordinary turn. A positive result is a bounded `CrmEntry` insert. Every
  failure mode (provider unreachable, malformed JSON, bad email) is
  swallowed — losing a lead is fine, breaking the chat reply isn't.
- **Optional caller identity**: `chat()` resolves `get_current_user`
  (`apis/deps.py`) — the same never-rejects dependency `require_role` is
  built on, used here purely for "who is this, if anyone." `frontend/
  src/lib/api.ts`'s `apiFetch` already attaches `Authorization: Bearer
  <token>` automatically whenever any logged-in account (including plain
  `user` role) hits `/chat`. When a real account is logged in,
  `_build_visitor_context` looks up that email's own past `CrmEntry` rows
  and, if any exist, prefixes the turn with a `(Signed-in visitor: ...)`
  block so the model recognizes a returning visitor instead of re-asking
  who they are — a first-time logged-in visitor (no prior rows) gets no
  context block. `known_email` also backstops `_maybe_capture_lead`'s
  `contact_email` when the message itself never spells it out.
  `ChatSession.user_email` (nullable) is backfilled the same way, never
  cleared back to anonymous once known.
- **File attachment**: `POST /chat/upload`, same public/no-auth tier as
  `/chat` itself — a visitor can attach one photo/PDF before sending a
  turn. Deliberately stricter validation than the admin-gated
  `apis/media.py`/`apis/documents.py` uploads it's modeled on, since this
  is the one upload path with *no* RBAC gate at all: fixed extension
  allowlist (images + PDF, no `.svg`/`.html`), an 8MB hard cap, and a
  random `uuid4` filename (never the client-supplied name). Storage and
  analysis both live in **`backend/chat_attachments.py`**, shared with
  `apis/agent.py`'s owner-triggered deep scan below. Files are stored
  **per conversation**: `CHAT_UPLOAD_DIR/<conversation_id>/<uuid4><ext>`,
  where `conversation_id` is the caller's account email if logged in,
  otherwise their client-generated `session_id`
  (`chat_attachments.safe_conversation_id` sanitizes either into a safe
  folder name). Served back out via `main.py`'s `/api/chat/uploads`
  `StaticFiles` mount — publicly readable by exact path only.
- **Automatic attachment analysis**: the chat model reads an attachment's
  actual content — `chat_attachments.extract_lead_info` runs the
  owner-selected vision model (image, same call shape as
  `generate_landing_page`) or the plain chat model over extracted text
  (PDF, via `ingest.parse_document`) to best-effort pull out
  name/phone/email/intent. Runs unconditionally on every turn with a
  fresh attachment; swallows every failure. Folds into the main reply's
  context (`SYSTEM_PROMPT` treats an `(Automatic analysis of the attached
  file found: ...)` block as already-known fact) and into
  `_maybe_capture_lead`'s `contact_name`/`contact_phone` fields,
  backstopping the extraction model's own guess the same way
  `known_email` backstops `contact_email`.
- **Owner-triggered deep scan**: `POST /agent/crm/entries/{id}/scan`
  (admin/owner-gated, `apis/agent.py`) re-runs analysis on an already-
  captured entry's attachment with the owner's own freeform instructions
  via `chat_attachments.scan_with_instructions` — unlike the automatic
  extraction above, this one *raises* on failure (a silent no-op would
  just look broken to an admin who asked for it) and appends its answer
  to `CrmEntry.analysis_notes` (timestamped, accumulating). Reachable
  from `CrmPanel`'s per-entry "Deep-scan notes" `<details>` (read-only
  there) or the owner-agent's `scan_crm_attachment` tool (see "Owner
  agent" below) — the first owner-agent tool whose backend path has a
  `{crm_id}` placeholder, which `owner-agent/tools.py`'s `execute_tool`
  substitutes out of `path` from the model's own `args`.
- Every attachment-reading code path (`resolve_local_path`) is
  deliberately paranoid about the URL it's given, since it turns a
  client-supplied string into an actual filesystem read: exact
  `BACKEND_PUBLIC_URL`-prefix match, exactly two path segments, and a
  `resolve()`-based containment check inside `CHAT_UPLOAD_DIR` before
  ever touching disk.
- **Orphaned-upload cleanup**: a visitor who uploads a file and never
  sends a turn referencing it (or sends one that never becomes a lead)
  leaves it behind with nothing else in this app ever cleaning it up —
  `chat_attachments.cleanup_orphaned_uploads` scans the whole upload
  tree, treats a file as "referenced" if either a `CrmEntry.
  attachment_url` or a persisted `ChatMessage.content`'s `[Attached
  file: ...]` marker points at it, and removes anything unreferenced
  *and* older than `older_than_hours` (default 24 — so a slow typer's
  in-flight upload is never deleted mid-conversation), also removing a
  now-empty conversation folder. Reachable via `POST
  /agent/storage/cleanup-uploads` (`dry_run: true` previews without
  touching disk), the owner-agent's `cleanup_chat_uploads` tool, or
  `CrmPanel`'s "Clean up unused uploads" button.

## Rate limiting (`backend/rate_limit.py`)

Added 2026-08-08. Every other route in this backend sits behind
`require_role` — a stolen/guessed JWT is a bigger problem than a fast
caller, so this deliberately does **not** rate-limit the whole API, only
the three fully public, no-auth routes: `POST /api/chat`, `POST
/api/chat/upload` (both `apis/chat.py` — see the RBAC note near the top
of this file), and `POST /api/auth/login` (the classic brute-force
target). `RateLimitMiddleware` matches on exact `(method, path)`, not a
prefix, so `/api/chat`'s budget can never accidentally also gate
`/api/chat/upload`.

- **In-memory, single-process, sliding-window-by-trimming** — deliberately
  not slowapi/Redis: this app runs as one uvicorn worker in one container
  (`docker-compose.yml`), so there's no multi-process state to share, and
  a real limitation worth knowing rather than silently wrong if that ever
  changes (multiple workers/replicas would each keep their own counters,
  multiplying the effective limit).
- **Trusts `request.client.host` only, never `X-Forwarded-For`** — this
  stack has no reverse proxy in front of `backend` (Compose maps its port
  straight out), so there's no trusted hop that could have set that
  header correctly; honoring it would let any caller claim to be any IP.
- **Limits**: `/api/chat` 20/5min, `/api/chat/upload` 10/5min (generous
  enough for a real conversation — a single chat turn can now trigger up
  to three model calls, see "Chat lead capture" above — while still
  blocking a scripted flood), `/api/auth/login` 10/15min (enough for a
  fat-fingered password, not enough to meaningfully guess one of the 3
  seeded demo passwords).
- **Middleware ordering matters and is counter-intuitive**: Starlette
  wraps the *most recently added* middleware as the *outermost* layer
  (`Router.build_middleware_stack` — `user_middleware` is built via
  `insert(0, ...)`, then wrapped in reversed order). `main.py` adds
  `RateLimitMiddleware` **before** `CORSMiddleware` specifically so CORS
  ends up outermost and still wraps a 429 short-circuited by the rate
  limiter — added the other way around, a rate-limited browser request
  comes back with no CORS headers at all and the frontend sees an opaque
  CORS failure instead of a readable 429 (see `HISTORY.md`'s 2026-08-08
  entry for how this was caught and verified).

## Page schema

Defined in `frontend/src/lib/theme.ts`, mirrored in `backend/apis/agent.py`'s Pydantic models — keep both in sync.

A generated/saved page is `{ sections: PageSection[], accent_color? }`.
Two families of section:

**Fixed composite sections** — `HeroSection`, `FeatureGridSection`,
`CarouselSection` (built, unused by the default template, not CTE-
editable), `TextBlockSection`, `CtaBannerSection`, `BadgeListSection`.
Each has its own hardcoded React component and rendering logic (grid
layouts, item styles, image positions, etc. — see `frontend/AGENTS.md`
for the full field-by-field catalog). Headline/heading/body-ish fields
are `string | RichText` (`RichText = { content, color?, size?, weight? }`
— a plain string means "use this section's own default styling"; only a
CTE edit promotes it to the object form). `ThemeCta` (shared by Hero/
CtaBanner/FeatureGrid) carries optional `background_color`/`text_color`/
`border_color`/`rounded`/`size`/`border_width`.

**Generic Block primitives** — `ImageBlock`, `TextContentBlock`,
`ButtonBlock`, `ContainerBlock` (`layout: "row"|"column"|"grid"`,
recursive via `children: Block[]`, also usable as a top-level
`PageSection`). Exists for layouts the fixed sections can't express (a
row of unevenly-padded columns, etc.) — deliberately a small, fixed set,
not a general block library: no input/textarea/select blocks, no
free-form CSS anywhere (every style knob is a constrained enum or a
plain hex color, same principle as `accent_color`). `BlockWidth` (`auto|
1/4|1/3|1/2|2/3|3/4|full`) sizes a block within a `layout: "row"` parent.

**Deliberately kept separate, not unified** — a real conversation this
session concluded that collapsing the fixed sections into pure Block
JSON would be a net loss: nested/recursive Block JSON is measurably
harder for the vision LLM to generate reliably than flat composite
sections (repeatedly confirmed), and `HeroSection` renders a real
semantic `<h1>` that a generic `TextContentBlock` (always `<p>`) can't
replicate. Keep both families; don't try to merge them without new
evidence.

## CTE (click-to-edit), `/editor`

Admin/owner-gated. Deliberately **not GrapesJS** (the original plan's
pick) — GrapesJS edits raw HTML/CSS, which conflicts with "the LLM/editor
never touches raw markup, only a typed `PageSection`." A lightweight,
schema-native editor instead: `components/theme/cte/` — `CteProvider`/
`useCte()` context, `Editable` wrapper (pencil-badge click targets,
rendered as DOM siblings of content — never nested inside it, so a
stacked/overlapping layout can't make one badge unreachable),
`lib/cte.ts`'s path-based immutable updaters (`setByPath`/`appendByPath`/
`insertByPath`/`removeByPath`/`moveByPath`, all dot-path addressed, e.g.
`"1.items.2.image.url"`). `/editor` only edits *existing* saved content —
generating new content is `PageGeneratorPanel`'s job.

**What it can do today** (built across many iterations — see `HISTORY.md`
for the CTE parts 1-13 blow-by-blow if you need the "why" behind a
specific design choice):
- **Content editing**: every text/image/feature-item/badge-list/CTA
  field, via a `Sheet`-based popover (`CteEditorPopover`) with live
  updates (edits apply as you change them, no separate Save click except
  the final "Save as new version").
- **Style editing**: color/size/weight for `RichText` fields (size is a
  bounded numeric px value, not an enum — a 6-stop enum proved too narrow
  for real headline sizes), full color/spacing/layout/typography editing
  for the generic Block system (`block-container`/`block-text`/
  `block-image`/`block-button` fieldTypes), button params (rounded/size/
  border width) on both `ThemeCta` and `ButtonBlock`.
- **"Current value" hints**: `RichText` fields show the field's actual
  *rendered* size/weight/color (read via `getComputedStyle` at click
  time) as the popover's starting value, not a blank "Default" — there's
  no single universal default across every section/field.
- **Structural editing** (move/delete/insert), generalized across every
  "reusable component array" in the schema: page `sections`, feature-
  item/CTA arrays, and `ContainerBlock.children` (at any nesting depth)
  all support the same move-earlier/move-later/delete
  (`ArrayItemToolbar`) plus insert-at-any-position via a type picker
  (`SectionInsertMenu`/`BlockInsertMenu`, backed by declarative
  `insertable`-flagged registries in `lib/section-registry.ts`/
  `lib/block-registry.ts`). A `ContainerBlock` (which has its own
  children) gets its "edit the whole thing" pencil folded into the same
  move/delete toolbar group, not a separate floating badge.
- **Discoverability**: insert-gap "+"s and move/delete/edit toolbars are
  **hover-revealed** (edit mode must be on first) — deliberately NOT the
  content pencil badges, which stay always-visible (the "what can I
  edit" primary discovery mechanism, and `/editor` is admin-only/desktop
  in practice, unlike the touch-first public site the always-visible
  design was originally chosen for).
- **Explicitly out of scope, confirmed with the user, not oversights**:
  fixed sections' own single optional fields (Hero's `image`/`eyebrow`)
  don't support delete-then-reinsert (only array-based content does);
  carousel slide editing; width/height editing on individual blocks
  (discussed, shelved, not rejected — see "Suggested next step").

**Verification gap, unresolved all session**: no working Chrome browser
extension connection existed for any part of the CTE work above — every
fix was verified via `tsc`/`eslint`/curl/backend-Pydantic checks plus the
user's own screenshots, never a live click-through by this session's own
tools. Treat any CTE-adjacent change as needing a real browser check
before considering it fully settled.

## Progress against the plan's phases (四、开发顺序建议)

- **Phase 1 — Skeleton**: done. Next.js + Tailwind, Postgres/Alembic,
  real self-issued-JWT auth + RBAC (deliberately not Firebase — this is
  a local-demo MVP, not a real deployment; don't push toward Firebase/
  cloud deploy unless asked). 3 seeded demo accounts, password `0000`
  for all: `owner@example.com`, `admin@example.com`, `user@example.com`.
- **Phase 2 — RAG core**: done. See "RAG" above.
- **Phase 3 — Chatbot**: mostly done. `POST /api/chat` real, provider-
  abstracted, RAG-merged, with automatic lead capture and optional
  logged-in-caller identity/personalization (see "Chat lead capture &
  optional caller identity" above). **Not done**: streaming (SSE/
  WebSocket — single non-streaming call today); real LLM-driven intent
  recognition (the frontend's category→tags→channel→free-text flow is a
  **scripted local sequence**, not LLM-driven — it demonstrates the
  `{type, options}` structured-control contract, nothing more).
- **Phase 4 — CTE editor**: done, extensively. See "CTE" above.
- **Phase 5 — Visual polish**: page generation/schema done (see "Page
  schema" above). **Not done**: GSAP/ScrollTrigger (not started); Swiper
  carousel section (built, unused, no content feeds it, not CTE-
  editable).
- **Phase 6 — Agent security layer**: **started, not complete**. The
  isolated worker now exists — `owner-agent/` (own container/port 8100,
  see "Architecture decisions" above and "Owner agent" below) — with a
  real LLM tool-calling loop over a fixed 8-tool allowlist, its own
  owner-only auth check, and action logging to stdout + a bind-mounted
  `logs/runs.jsonl` (deliberately a durable file, not a queryable DB
  table — a named MVP cut, not full Phase 6). The worker's "brain" model
  selection is now wired to the owner-facing model picker too
  (2026-08-18, see "Owner agent" below) — it was fixed via
  `OWNER_AGENT_MODEL`/Ollama-only until then. **Still not done**: no
  red-team pass, no queryable/DB-backed action-log history, no openclaw
  permission-boundary docs beyond the existing paragraph above.

### Owner agent (`owner-agent/`)

The first real agent loop in this project — everything in
`backend/apis/agent.py` is still deterministic single-purpose pipelines;
this is the one place the model itself decides which action(s) to take.

- **What it does**: owner types a natural-language command
  (`OwnerAgentPanel`, `/dashboard`, owner-role gated — stricter than the
  rest of the agent console, which is admin OR owner) → `POST /run` on the
  `owner-agent` service → a loop against whatever chat provider/model the
  owner has picked in `ModelSettingsPanel` (2026-08-18, see the
  "brain call" bullet below) asks the model, each turn, to emit one JSON
  envelope: either call one of 8 tools (`generate_poster`,
  `crm_create_entry`, `crm_list_entries`, `crm_delete_entry`,
  `generate_report`, `generate_geo_page`, `scan_crm_attachment`,
  `cleanup_chat_uploads` — each a thin HTTP call onto an already-real
  `backend/apis/agent.py` endpoint) or give a final answer. Up to 6 turns,
  a 300s overall budget. The full step trace (tool, args, result,
  ok/error) is returned to the frontend and rendered, not just the final
  answer.
- **Path-parameter tools**: `scan_crm_attachment` and `crm_delete_entry`
  are the first tools whose backend path has a placeholder
  (`{crm_id}`) — `owner-agent/tools.py`'s `execute_tool` substitutes
  `{param}` segments out of `ToolSpec.path` from the model's own `args`
  before making the request, stripping those keys from what's actually
  sent as the body (a small, generic mechanism, not a one-off special
  case). `crm_delete_entry` is also the first tool using `DELETE`, which
  needed `ToolSpec.method`'s `Literal` widened and `execute_tool` taught
  to treat a `204 No Content` response as `{"ok": true}` rather than
  failing to parse an empty body as JSON. `cleanup_chat_uploads` exposes
  `chat_attachments.cleanup_orphaned_uploads` (see "Chat lead capture"
  above) with `dry_run` in its own args schema.
- **Why a manual JSON envelope, not a model's native `tools`/`tool_calls`
  param**: native function-calling reliability varies across models, and
  this worker's "brain" can now be *any* of the 5 chat providers (see
  below) — no guarantee any particular one resolves to a model with a
  working function-calling template. The JSON-envelope-with-lenient-
  parsing approach (strip `<think>` blocks/code fences,
  `json_repair.repair_json` fallback) mirrors `backend/apis/agent.py`'s
  already-proven pattern for `generate_landing_page`/`generate_geo_page`,
  and works with any chat-capable model.
- **Brain call is proxied through backend, not direct** (2026-08-18):
  `owner-agent/agent_loop.py`'s `_backend_chat` calls
  `POST /agent/chat-completion` (`backend/apis/agent.py`) instead of
  hitting Ollama (or any provider) directly — that route is a thin proxy
  onto `resolve_chat_provider(db).chat(...)`, the exact same resolution
  `/api/chat` and `generate_geo_page` already use. This means owner-agent
  automatically follows whatever chat_provider/chat_model the owner picks
  in `ModelSettingsPanel` — including `custom` (llama.cpp/vLLM/etc.) —
  with zero owner-agent-side config. Previously this loop's brain was
  hardcoded to Ollama via `OLLAMA_BASE_URL`/`OWNER_AGENT_MODEL`
  regardless of what was configured elsewhere — changed on the owner's
  own explicit framing: "this project isn't about making choices for the
  user, it's about giving the user choices." `_backend_chat`'s own httpx
  timeout is 600s to give a slow local model room to answer even a
  single turn — see `RUN_TIMEOUT_SECONDS`'s comment for why that number
  can now itself exceed the loop's nominal 300s total-run budget (checked
  only *between* turns, not mid-call; already true, just more visibly so,
  before this change too).
- **Isolation, concretely**: `owner-agent` has no DB connection, no
  filesystem access beyond its own code/logs, no shell, no
  arbitrary-URL-fetch tool — its only I/O is `backend`'s own REST surface
  (both the 8 tools and, now, the brain call above), and it forwards the
  caller's real bearer token on every one of those calls so `backend`'s
  own `require_role` independently re-authorizes every action (defense in
  depth: a compromised worker still can't do anything `backend` wouldn't
  already allow that caller to do). Because no tool result ever contains
  attacker-influenced *external* content re-entering the model's context
  (every tool result is this app's own structured JSON), the classic
  "fetched content reinterprets itself as an instruction" prompt-injection
  vector doesn't apply to this design.
- **Known gap surfaced building this**: `generate_report`'s date range has
  no server-side span cap (only `end_date >= start_date` is checked) — the
  frontend `ReportPanel`'s date-picker UX was an implicit, soft guardrail
  that `owner-agent` bypasses by calling the endpoint directly. Not yet
  fixed; a real fix belongs in `backend/apis/agent.py` and would benefit
  every caller, not just this one.
- **Backend, independent of phases**: Dockerized services, ComfyUI
  wrapper (`apis/api.py`), RBAC framework — all done. `apis/agent.py` is
  now fully real (see "Agent console capabilities" above). Not done:
  online-AI fallback for chat (falls back to nothing today if the
  configured provider is unavailable, just a clean error).

## Known gotchas worth remembering

- **`qwen3.6:latest` as the *plain chat* model is too slow for a chat
  turn that also triggers attachment analysis and lead capture.** A
  single `/api/chat` turn can now chain up to three model calls (vision
  analysis of an attachment, the main reply, lead-capture extraction) —
  with qwen3.6 (a 36B "thinking" model) as the chat model, a real test
  turn hit `providers/ollama.py`'s 120s `httpx` timeout and returned a
  502 with an empty error message. qwen3.6 is still the right (only, in
  practice) choice for *vision* (`resolve_vision_model`), but pick a
  smaller/faster model like `gemma4:latest` for the plain chat model
  (`resolve_chat_provider`) if you're testing or demoing attachment
  analysis — the owner-facing model picker (`/dashboard`) sets this
  globally, see "Owner-facing model picker" above.
- **A corrupted/stale `.next` dev cache can make working pages
  404/500/serve-stale-content with no corresponding code change** — the
  single most-recurring issue this whole project. First try: `docker
  compose restart frontend`. If that doesn't fix it (or makes it worse —
  200→404 has happened): `docker compose up -d --renew-anon-volumes
  frontend`. **Never run `npm run build` inside the live container** via
  `docker compose exec` while `next dev` is running there — corrupts the
  shared bind-mounted `.next` directory; same fix applies. To verify a
  production build compiles without this risk: `docker compose run --rm
  frontend npm run build` in a one-off container.
- **Adding a new npm dependency needs `--build --renew-anon-volumes`
  together, not just one.** `node_modules` is an anonymous volume (so the
  container's Linux-native modules aren't shadowed by the host's
  Windows ones); Compose reuses it across a plain recreate. A `docker
  compose exec frontend npm install X` (live install) works immediately
  in the running container but is **not baked into the image** — if you
  later run `--renew-anon-volumes` alone (for an unrelated cache issue),
  it wipes that live install out. Always check "did a dependency get
  installed live since the last image build?" before reaching for
  `--renew-anon-volumes` alone.
- **Server Components need `INTERNAL_API_URL` (`http://backend:8000`,
  Docker DNS), not `NEXT_PUBLIC_API_URL` (`http://localhost:8000`).**
  `frontend/src/lib/api.ts` already branches on `typeof window` for
  this — if a Server Component's fetch to the backend hangs/fails, check
  which URL it's using before assuming the backend is down. Same class
  of bug bit the backend once too: `apis/agent.py`'s `generate_poster`
  had to swap `COMFYUI_PUBLIC_URL` for `COMFYUI_URL` on its one
  server-side fetch, for the identical reason.
- **Ollama must bind to all interfaces** (`OLLAMA_HOST=0.0.0.0`), not
  just loopback, or the backend container can't reach it (hangs until
  timeout, not a clean refusal).
- **CORS**: browser calls to the backend need `CORSMiddleware` allowing
  the frontend's origin (`backend/main.py`, `CORS_ALLOW_ORIGINS` env
  var) — `curl` won't reproduce this failure, since curl doesn't enforce
  CORS.
- Next.js here is **v16** with React 19 — meaningfully different from
  most training-data-era Next.js knowledge. Check `frontend/node_modules/
  next/dist/docs/` before assuming an older API shape.
- shadcn/ui here uses `base-nova` (`@base-ui/react`, **not Radix**) — a
  `render` prop (`<Button render={<Link href="/x" />}>`), not `asChild`.
  **Passing a component/function prop from a Server Component into a
  Client Component fails RSC serialization** — pass primitive values
  instead. Hit twice: once with a Lucide icon prop, once when
  `BlockRenderer` became a Client Component and its Server-Component
  parent (`ContainerBlock`) was still passing it a function.
- **A `ScrollArea` (base-ui) inside a `flex-col` parent needs `min-h-0`
  on the `ScrollArea` itself, or it won't scroll.** Its `Viewport` uses
  real `overflow: scroll`, but a flex item's default `min-height: auto`
  lets it grow to fit its content instead of shrinking to its allotted
  flex space — so the viewport never actually overflows, and a mouse
  wheel over it scrolls the page instead. Hit in `ChatPanel`
  (`chat-panel.tsx`) inside `ChatBubbleWidget`'s floating card; the fix
  is `<ScrollArea className="min-h-0 flex-1 ...">`. The sibling
  input/composer row should also get `shrink-0` so it never gets
  squeezed instead of the message list.
- **`frontend/src/lib/auth.ts`'s client-side `isTokenExpired()` only
  reads the token's own `exp` claim — it never verifies the signature.**
  A `localStorage` token signed under an old `JWT_SECRET` (e.g. after a
  rotation, see "Configuration" above) still looks valid to the frontend
  and keeps showing the old logged-in email/role in the header, while
  the backend's real signature check (`apis/deps.py`) silently downgrades
  every request to the anonymous `user` role — every RBAC-gated route
  then 403s. `AgentConsoleSection` (2026-08-09) guards against exactly
  this by re-verifying a privileged cached role against `GET
  /api/auth/me` before rendering any gated panel; nothing else in the
  frontend does this check yet — a stale token hitting some other
  admin/owner-gated flow first would still surface as a raw
  `ErrorMessage` until it goes through that same section.

## Suggested next step

Out of scope by explicit decision — don't suggest: real Firebase Auth or
an actual cloud/EC2 deploy (Phase 1's scope decision).

**2026-08-08, end of a long session**: built chat file attachments
(upload, per-conversation storage, automatic vision/document analysis,
owner-triggered deep scan), CRM entry deletion, orphaned-upload cleanup,
public-endpoint rate limiting, a dashboard visual pass (alternating
section backgrounds, bigger titles), and — off a user-requested security
audit — rotated `JWT_SECRET` off its public default and unbound
Postgres's port from `0.0.0.0`. Full narrative for all of it is in
`HISTORY.md`'s 2026-08-08 entries. A CTE `width`/`height` editing
proposal from 2026-08-06 is still shelved, not rejected (expose the
existing `BlockWidth` enum on all 4 block types + `ContainerBlock.
min_height`, both already-existing fields with no CTE editor UI yet).

**2026-08-18**: completed the full 4-phase "every LLM/image-gen
capability should be swappable, not just chat" initiative the user laid
out this session (guiding principle in their own words: "this project
isn't about making choices for the user, it's about giving the user
choices"). In order: (1) the `custom` OpenAI-compatible provider
(`providers/custom.py` — llama.cpp/vLLM/LM Studio/etc.) plus a "Test
connection" flow, and the embedding provider becoming owner-configurable
(`AppSettings.embedding_provider`/`embedding_model`/`embedding_dimensions`,
a dimension-less `DocumentChunk.embedding` column,
`POST /agent/documents/reembed-all`, `DocumentManager`'s stale-document
banner); (2) `owner-agent`'s "brain" call rewired off a hardcoded
`OLLAMA_BASE_URL`/`OWNER_AGENT_MODEL` onto `POST /agent/chat-completion`
(`resolve_chat_provider` under the hood) — see "Owner agent" below,
including it now honestly stating which provider/model it's actually
running on when asked, instead of a canned "Ollama" answer; (3) vision
unified across all 5 providers (`ChatProvider.chat()` gained `json_mode`,
Anthropic/Gemini gained image-content-part translation — see "AI
provider is swappable" above); (4) image generation became a 4th
picker (comfyui/openai/gemini) — see the "Owner-facing model picker"
bullet above and `generate_poster`'s entry below. Also fixed along the
way: `/api/chat`'s `SYSTEM_PROMPT` had a hardcoded "you're running via
Ollama" persona line left over from before any of this existed — visibly
wrong once chat could be answered by literally anything else, now
generic/provider-agnostic. Full narrative in `HISTORY.md` if the "why"
behind a specific step is needed.
- **A real in-browser click-through of everything in this project** —
  still the single biggest verification gap, unresolved across every
  session so far including this one (the Chrome extension never
  connected). Everything, CTE through today's dashboard/CRM/attachment
  UI, was verified via `tsc`/`eslint`/curl/backend checks and dev-server
  logs, never a live click-through by this session's own tools.
- **Two real, unfixed findings from this session's security audit**: all
  three Dockerfiles run as root (no `USER` directive — a real fix needs
  care around file-permission implications, not just adding the line);
  `requirements.txt` pins no upper bounds (not reproducible, could
  silently pull a future breaking/vulnerable version). Lower urgency than
  the two fixed items above, but real.
- A `/dashboard` viewer for the chat sessions/messages already being
  persisted (session list + per-session transcript) — deliberately
  deferred out of the original persistence work to keep that change
  small, still not built.
- Whether qwen3.6 can reliably generate the Container/Block schema's
  deeper nesting patterns from a real design image — tested a few
  rounds, still genuinely open; everything CTE supports editing at the
  nested-container level was hand-authored via curl, never generated by
  the model on its own.
- Phase 6 (agent security layer) — `owner-agent/` now has a real
  tool-calling loop over 8 tools; still open: a red-team pass, a
  queryable/DB-backed action-log (currently a JSONL file), wiring
  `generate_landing_page` in as a tool (excluded so far — needs an image
  upload, doesn't fit a text-command tool as-is).
- Smaller unstarted items: chat streaming, real LLM-driven intent
  recognition, GSAP/ScrollTrigger, Swiper carousel content.

Ask the user which, if anything, to pick back up.
