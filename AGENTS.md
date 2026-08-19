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
│   ├── cart.py                     shared Product search/Order mutation logic (apis/chat.py + apis/products.py both use it) — see "Product catalog + ordering" below
│   ├── rate_limit.py               per-IP rate limiting for the fully public routes — see "Rate limiting" below
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
  - **Real bug fixed 2026-08-20**: `_wait_via_websocket` always connected
    with a fresh, unrelated `client_id` instead of the one the job was
    actually submitted with — ComfyUI only routes `executing`/`progress`
    completion events to the websocket connection whose `clientId`
    matches the *submission's* `client_id`, so this socket could never
    receive a single event for the job it was waiting on. Every
    generation was silently degrading to the 30s per-`recv` timeout
    before falling back to the 5s polling loop below it, regardless of
    how fast ComfyUI actually finished (found from a real report: an
    image done in ~6s not showing up in the app for ~30s). Fixed by
    threading the real submission `client_id` through
    `_wait_for_completion_impl` down to `_wait_via_websocket`
    (`providers/comfyui.py`'s `_generate` now passes `payload
    ["client_id"]`) — the websocket fast path actually fires now.
  - **Local resource coordination between chat/vision and ComfyUI**
    (2026-08-19, `backend/resource_broker.py`) — opt-in
    (`AppSettings.resource_coordination_enabled`, default off), built
    after the user's own machine hit real memory pressure running both
    at once (95% system RAM, and — confirmed via ComfyUI's own
    `/system_stats` — ~84% VRAM used despite the GPU *compute* meter
    reading only 5%, i.e. "GPU isn't busy" and "GPU has free memory" are
    different things). Wires together primitives that already existed
    but nothing was calling: llama-server's router mode exposes real
    per-model load state (`GET /v1/models`, each entry's
    `status.value`) and a working explicit-unload route confirmed this
    session (`POST /models/unload {"model": "<name>"}`, NOT under
    `/v1`) — `maybe_release_llm_memory` calls it right before a ComfyUI
    generation, but *only* if ComfyUI's `/system_stats` reports free
    RAM/VRAM below `AppSettings.resource_coordination_headroom_mb`
    (default 4096) — unloading unconditionally would cost a real reload
    delay on the next chat turn for no reason when memory wasn't
    actually tight (measured up to 159s for a 27B model, see the
    `providers/custom.py` timeout comment). `release_comfyui_memory`
    always runs afterward (`ComfyUIImageProvider.generate()`'s
    `finally`), calling ComfyUI's own `POST /free {"unload_models":
    true, "free_memory": true}` — no threshold check needed there,
    freeing ComfyUI's memory has no reload-latency downside. No
    explicit "reload" call is needed on the give-back side either —
    `--models-autoload` (llama-server's default) means the router
    lazily reloads on the next request that needs it. Both functions
    swallow every failure (wrong endpoint shape, unreachable, ...) —
    this is an optimization, never allowed to break a real generation.
    Deliberately scoped to just chat/vision-vs-ComfyUI for v1: the
    standalone embedding `llama-server` (single-model, no router) has a
    much smaller footprint and isn't touched. **A real visitor's
    in-flight chat turn always wins** over an owner's poster generation
    — `resource_broker.has_active_chat_requests()` (an in-process
    counter held for the whole `/api/chat` handler, see `apis/chat.py`)
    makes `maybe_release_llm_memory` refuse outright whenever a turn is
    in flight, the owner's own explicit priority call once this first
    shipped without it: protecting the customer-facing chatbot beats the
    owner's own convenience. Verified live (a backgrounded `/api/chat`
    call held the model loaded through a concurrent `generate_poster`
    call even with the headroom forced impossibly high; the next
    `generate_poster` after that turn finished correctly unloaded it).
    Still not narrowed further: a visitor's *next* message arriving just
    after an unload-and-reload cycle already started isn't protected —
    closing that needs real request queueing, out of scope for now.
    `ModelSettingsPanel`'s Image generation section (only when
    `image_provider === "comfyui"`) has the on/off `Switch` + headroom
    `Input`.
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
  inside the chat. `_lead_extraction_call` runs one fixed-shape
  classification call (is this a real lead? which category? what email?
  name? phone?) — kicked off concurrently with order extraction
  (2026-08-20, see "Product ordering" below), its result applied via
  `_apply_lead_capture` after the main reply is generated — gated so it
  only fires on a turn that's email-shaped (`_LEAD_EMAIL_RE`), from a
  caller with a known account email, or carrying an attachment (below) —
  not on every ordinary turn (unless intent schemas are configured, see
  below). A positive result is a bounded `CrmEntry` insert. Every
  failure mode (provider unreachable, malformed JSON, bad email) is
  swallowed — losing
  a lead is fine, breaking the chat reply isn't.
- **Owner-configurable structured collection** (2026-08-19,
  `IntentSchema`/`IntentField` in `models.py`, admin/owner CRUD at
  `apis/intent_schemas.py`, UI at `IntentSchemaPanel`) — generalizes the
  fixed `appointment`/`quote`/`claim`/`inquiry` category enum above into
  something any vertical (insurance, real estate, a clinic, a restaurant,
  a law firm, ...) defines for itself: an owner describes a "kind of
  request" (a schema — key, label, description) and the structured fields
  it needs collected (field key, label, type, required, a prompt hint),
  and the public chatbot collects them conversationally across multiple
  turns of the *same chat session* without re-asking for anything already
  given. Built and verified end-to-end against one real vertical
  (insurance: an `insurance_application` schema and an `insurance_claim`
  schema) per an explicit user scoping decision — the mechanism itself is
  not insurance-specific; adding another vertical is filling in the same
  form again, not new code.
  - `CrmEntry` gained three nullable columns: `intent_schema_id` (which
    schema this entry is an instance of — null for entries captured the
    old fixed-category way), `collected_fields` (JSONB, `{field_key:
    value}`), `chat_session_id` (FK to `ChatSession.id` — the join key
    that makes same-session lookup possible; `ChatSession` already
    existed and is already resolved per turn, so this links two
    already-existing things rather than inventing a new identity
    concept).
  - `_lead_extraction_system_prompt` builds its classification options
    *from the owner's configured schemas* (each schema's key/label/
    description becomes a category, each field becomes something the
    model is told it can extract a value for) when any exist, falling
    back to the original fixed four options byte-for-byte when the owner
    hasn't configured any — confirmed via a real regression test this
    session (a plain appointment-shaped message with zero schemas
    configured produced the identical `category: "appointment"` capture
    as before this feature existed).
  - **Gate is deliberately loosened once any schema exists**: the narrow
    `_LEAD_EMAIL_RE`-based gate above exists because most ordinary turns
    aren't leads, but multi-turn structured collection (e.g. "what's your
    policy number" with no email anywhere yet) needs to run on every turn
    to work at all. Zero extra cost for an owner who hasn't touched this
    feature; a real latency/cost tradeoff worth knowing for a
    schema-heavy, chatty setup.
  - **Same-session dedup, by record id, not cross-session by identity** —
    an explicit user scoping decision. `_find_active_entry` looks up the
    most recent `CrmEntry` matching `(chat_session_id, intent_schema_id)`;
    if found, its `collected_fields` are folded into BOTH the extraction
    prompt (`_lead_extraction_system_prompt`'s `progress_clause`, so the
    model only returns newly-found field values instead of re-deriving
    everything) and the main reply's own context
    (`_in_progress_context_block`, mirroring `_build_visitor_context`'s
    existing pattern — otherwise the classification call alone updating
    `collected_fields` wouldn't stop the assistant's own reply text from
    re-asking). A hit merges (`dict` update, never overwrites a known
    value with a gap) into the SAME row; a miss inserts a new one. Verified
    with a real 3-turn conversation (same `session_id` throughout): turn 1
    gave only an email, turn 2 added a policy number, turn 3 added the
    incident date/description — `GET /agent/crm/entries` showed exactly
    **one** row throughout, its `collected_fields` accumulating each turn,
    and the assistant's own replies never re-asked for something already
    given, correctly recognizing completion on turn 3 instead of
    continuing to ask questions.
  - `CrmPanel` renders `collected_fields` as a small label→value list
    per entry (labels resolved via a fetched schema list, not raw field
    keys) when `intent_schema_id` is set; otherwise entries render exactly
    as they did before this feature.
  - Deliberately out of scope for this round (a real user scoping
    decision, not an oversight): a **recommendation** feature ("suggest
    the right policy/dish/product from embedded documents" — layers on
    top of already-working RAG retrieval + chat, doesn't block proving
    the collection mechanism); **URL-based auto-embed** (owner pastes a
    law/regulation URL, gets fetched+chunked+embedded automatically — an
    extension of `apis/documents.py`'s existing ingestion pipeline);
    cross-session dedup by visitor identity; other verticals beyond the
    insurance validation above. Schema *creation* stays dashboard-form-
    only by the user's own explicit confirmation — see the next bullet
    for what IS now owner-agent-driven (a deliberate split: defining
    what to collect is a one-time setup task suited to a form; deciding
    how to review/act on what's collected is exactly the kind of
    judgment call suited to a conversational agent).
- **Owner-agent-generated review queues** (2026-08-19, `IntentView` in
  `models.py`, CRUD in `apis/intent_schemas.py`, UI at
  `ReviewQueuePanel`) — the follow-on layer: rather than the owner
  describing a review/approval workflow to a human (me) who'd hand-build
  a rigid vertical-specific entity, the owner tells **owner-agent**
  what to track in plain language ("I want to review insurance
  applications people submit, approve or reject them") and it generates
  the queue itself. New owner-agent tools `list_intent_schemas` (so the
  model checks what actually exists before guessing a `schema_key`) and
  `manage_review_queue` (`POST /agent/intent-views`, **upserts by
  schema_key** — not a plain create — so a follow-up command adjusts
  the same queue instead of creating a duplicate, since the model has no
  reason to track a numeric view id across separate `/run` calls).
  Confirmed directly with the user before building: owner-agent can't
  pause mid-run for a real back-and-forth (one `/run` executes
  autonomously to a turn limit and returns), so when the owner doesn't
  specify what statuses to track, the tool's own description tells the
  model to default to `["pending", "approved", "rejected"]` and state
  the assumption plainly in its final answer — confirmed working exactly
  as designed in a real run (see below). `CrmStatusUpdateRequest.status`
  (`apis/agent.py`) widened from `Literal["new","contacted","closed"]`
  to plain `str` — the DB column was already an unconstrained
  `String(16)`, so this was purely an API-level constraint that would
  have rejected a queue's own custom statuses. `ReviewQueuePanel` is a
  **new top-level accordion group** ("Review queues"), deliberately
  separate from "CRM & reporting" per the user's explicit ask — for each
  `IntentView`, renders its schema's matching `CrmEntry` rows (client-
  side filtered from the same `listCrmEntries()` `CrmPanel` already
  uses, no new list-entries endpoint needed) with a `collected_fields`
  breakdown, attachment link, and a status `Select` sourced from that
  view's own `status_options` — wired to the now-loosened
  `updateCrmEntryStatus`. Deliberately NOT a dashboard form for creating/
  editing a queue's own definition (agent-driven only, per the confirmed
  workflow) and NOT wired to any notification — email/SMS on status
  change is explicitly deferred by the user ("模板晚点再做"), no
  template system or sending infra built, no stub either.
  - **A real regression was caught and fixed while verifying this**: the
    non-root Dockerfile change from earlier today broke
    `owner-agent/logging_.py`'s per-step JSONL write —
    `logs/runs.jsonl` itself (not just the directory) was still
    root-owned from before the switch to `appuser`, so appending to an
    *existing* file 500'd with `PermissionError` even though a fresh
    `touch` in the same directory had worked fine in the earlier
    verification (creating a new file only needs the *directory* to be
    writable; appending to an existing one needs write permission on
    the *file itself* too — a real gap in that earlier check). Fixed
    the same way as the `backend/storage/` case: `docker compose exec -u
    root owner-agent chown -R appuser:appuser /app/logs`. Worth
    remembering as a general rule, not just this one file: a bind-mounted
    directory being writable by the new non-root user says nothing about
    whether *pre-existing files already in it* are.
  - Verified with a real owner-agent run, not a direct API call alone:
    command "I want to review the insurance applications people submit
    through the chatbot, and approve or reject them" → the model called
    `list_intent_schemas` first (per its own tool description), correctly
    picked `insurance_application` over `insurance_claim`, called
    `manage_review_queue` with the default three statuses, and closed
    with a final answer explicitly stating the default was used. Then a
    real chat turn (name/DOB/desired policy type given all at once)
    correctly populated `collected_fields` in one shot since nothing was
    missing, and `PATCH .../status` with `"approved"` (would have 422'd
    under the old `Literal`) succeeded.
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
  context block. `known_email` also backstops `_apply_lead_capture`'s
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
  `_apply_lead_capture`'s `contact_name`/`contact_phone` fields,
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

## Product catalog + ordering (`backend/apis/products.py`, `backend/cart.py`)

Added 2026-08-19, extended into a full storefront layer the same day —
a third, fully independent pipeline alongside RAG and lead capture, for
a generic **product catalog** modeled on WooCommerce's product concept
rather than anything restaurant- or retail-specific: a coffee-shop menu
item, a physical good, a virtual/digital good, a bookable service,
whatever the owner sells. Deliberately NOT built on top of
`IntentSchema` — a product's line items (repeated item+quantity, price
looked up from a real catalog) don't fit `IntentField`'s flat key-value
shape, so `Product`/`Order`/`OrderItem` (`models.py`) are their own
parallel tables, same "we build the framework, the owner fills in the
vertical" posture applied to a genuinely different data shape. **No
real payment/checkout exists anywhere in this app** — "paid"/"refunded"
are internal status labels an owner tracks manually, never a real
transaction; this system is CRM-adjacent order/bookkeeping tracking,
not e-commerce checkout.

- **`Product` is only ever written by the owner's own explicit action**
  — either directly (`ProductPanel`'s dashboard form) or by Applying an
  owner-agent-drafted proposal (`propose_products`) — never by
  owner-agent directly. Same higher-stakes posture as `IntentSchema`
  (see "Owner agent" below): a misread price directly affects what a
  real customer is quoted. `price` uses a real `Numeric(10,2)` column
  (this app's first money field), converted to a plain `float` at the
  API boundary for simplicity. `image_url` is pure display data — never
  read server-side (never fed to a vision model, unlike chat
  attachments), expected to hold a URL the owner already got back from
  the media library upload (`apis/media.py`) — this app never fetches
  an owner-supplied external URL server-side (a real SSRF surface), a
  deliberate call made with the user before building.
- **`ProductFieldDefinition` + `Product.custom_fields`** (2026-08-19) —
  mirrors `IntentSchema`/`IntentField` → `CrmEntry.collected_fields`
  exactly: one flat, shared field-definition list (`text|number|date|
  note|link`, no per-vertical grouping needed here, every product draws
  from the same definitions) + a JSONB values dict per product. Exposed
  both admin (`/agent/product-fields`) and **publicly**
  (`/api/product-fields`, `apis/products.py`'s `public_router`) — a
  field label like "Warranty" isn't sensitive, and `/products/[id]`
  needs it to render `custom_fields` with real labels, the same
  label→value pattern `ReviewQueuePanel` already uses for
  `collected_fields`.
- **`ProductRelation`** — one generic table for both "bundle" and
  "upsell" (`relation_type`, free text, same posture as
  `CrmEntry.category`) rather than two separate tables. A bundle prices
  itself independently (its own `Product.price`) — this table only
  records what's *inside* a bundle for display, never drives price
  computation.
- **`backend/cart.py`** — a new, deliberately plain top-level module
  (not inside either router) holding `search_products`,
  `find_active_order`, `apply_order_delta` — shared by `apis/chat.py`'s
  LLM-driven order capture AND `apis/products.py`'s direct
  `POST /cart/add` mutation. Necessary specifically to avoid a circular
  import: `apis/chat.py` needs these functions, `apis/products.py`
  needs these functions AND `apis/chat.py`'s `_get_or_create_session`
  (to resolve a client `session_id` into a real `ChatSession` row) —
  putting the shared logic inside either router file would make the two
  import each other. Mirrors `chat_attachments.py`'s existing precedent
  for cross-router shared logic living in a plain module.
- **Deterministic product search (`cart.search_products`), not LLM
  guessing — a real refactor of what shipped this same day.** The
  original `_order_extraction_system_prompt` listed the WHOLE catalog
  (id/name/price) in its prompt and asked the model to pick a
  `product_id` itself — doesn't scale past a small menu, and a database
  resolving a name is strictly more reliable than an LLM doing it. Now:
  the extraction call only ever pulls out plain-language phrases
  (`item_phrase`/`search_phrase`); every phrase is resolved against the
  real catalog via `search_products` — `ILIKE`, **tokenized, not one
  whole-phrase substring match**. Found and fixed from a real
  extraction-call output during verification: the model extracted
  "coffee drinks" for "what coffee drinks do you have," but no
  product's text contains that exact phrase (only "coffee drink,"
  singular) — a single `ILIKE '%coffee drinks%'` matched nothing at all
  despite 6 real coffee products existing. Splitting the query into
  words and matching if ANY word (2+ chars) appears is far more
  forgiving of the LLM's exact phrasing not lining up with a product's
  exact text.
- **Result-count branching is pure code, never an LLM decision** — a
  design principle the user stated directly and this implementation
  holds to exactly: `apis/chat.py`'s `_resolve_order_turn` (fed
  `_order_extraction_call`'s already-parsed result — split apart
  2026-08-20, see below) resolves every phrase via `search_products` and
  decides in Python: 1 match on an `item_phrase` → applies the delta;
  0 matches → nothing (the reply's own prose handles telling the
  visitor); **2+ matches → never guesses**, surfaced as candidates for
  the visitor to pick from instead (verified: "I would like to order a
  latte" against a catalog with both "Latte" and "Iced Latte" correctly
  asked which one, created no order). A `search_phrase` (browsing
  intent) resolves the same way: 1 → single card, 2–5 → a card list
  (rendered as a Swiper on the frontend — `swiper` was already an
  installed dependency, wired to the unused `CarouselSection`, this is
  its first real use), `>5` → a `/search?q=...` link instead of inline
  cards (verified with a real 6-match "coffee drinks" query).
- **Runs BEFORE the main reply, not post-hoc like lead capture — a real,
  necessary restructuring, not just a helper rewrite.** The original
  design ran order capture strictly after the reply (best-effort, same
  as lead capture) — fine for applying a DB write, but it meant a turn's
  search/order results weren't known yet when the reply was written, so
  the model was left to compute its own running total by adding numbers
  from context (catalog price + prior total) — exactly the kind of LLM
  arithmetic this app's own principles say never to trust, an
  inconsistency that existed in the original ship and wasn't caught
  until this refactor. Now `_resolve_order_turn` runs BEFORE the reply;
  its output (`OrderTurnResult`) is folded into the reply's context via
  `_order_turn_context_block` — including the REAL new total, computed
  in Python — so the reply narrates exactly what the code already
  decided, never invents a number. The actual DB write
  (`apply_resolved_order_turn`) still happens after the reply and stays
  best-effort/swallows failures, but no longer needs its own LLM call.
  - **Order extraction and lead extraction now run concurrently, not
    serially** (2026-08-20) — a real chat turn can trigger up to 3
    sequential model calls (order extraction, the main reply, lead
    extraction), and on a slow local model this measured ~50s for one
    order-taking turn (see "Known gotchas" below). Split each of
    `_resolve_order_turn`/`_maybe_capture_lead` into an LLM-call half
    (`_order_extraction_call`/`_lead_extraction_call`, pure — no DB
    writes) and a DB-apply half (`_resolve_order_turn` sync/
    `_apply_lead_capture`), since order extraction's result is the only
    one the main reply's context actually depends on — lead extraction
    needs neither the order result nor the reply text. `chat()` now
    kicks off both LLM calls via `asyncio.create_task` up front, awaits
    only the order one before generating the reply (so the reply's
    context still has the real order/total), and awaits the lead one
    afterward (usually already finished by then — free). All DB writes
    stay strictly sequential in the main coroutine (no concurrent
    `Session` use, only the two network calls actually overlap). If the
    main reply call fails, the already-in-flight lead-extraction task is
    explicitly cancelled rather than left to finish unawaited. Verified
    with two real chat turns (order + add-on) — identical behavior/DB
    state to before, just faster (~34-42s warm vs. the prior ~50s+ for
    the same 3-call turn).
- **`ChatResponse` gained `products`/`search_link`** (2026-08-19) —
  `_order_turn_response_fields` picks one, priority: an unresolved
  ambiguity first (needs the visitor's input most), then a confirmed
  order (so the visitor sees a card for what they just added — verified:
  ordering a latte returns a `products` card for it, not just text),
  then plain browse results, then the overflow link. `frontend/src/lib/
  types.ts`'s `ChatMessage` gained matching `products`/`searchLink`
  fields; `ChatMessageBubble` renders one card inline for 1 match, a
  `Swiper` for 2–5, or a "See all results" button linking to `/search`.
- **`OrderItem.unit_price_snapshot`/`item_name_snapshot` are captured
  at add-time**, not read live off `Product` — a later menu price
  change never retroactively alters an already-placed order, and the
  line item stays human-readable even if the product is later
  deleted/renamed (`product_id` is `ON DELETE SET NULL`, not a cascade,
  same "keep the historical record readable" reasoning as
  `CrmEntry.intent_schema_id`).
- **`is_open` is a deliberate, separate boolean from `status`** — a real
  design fork resolved with the user directly: `status` is free text
  owner-agent can set to whatever labels the owner wants
  (`set_order_status_options`, see "Owner agent" below), so the code
  can't infer from it whether an order should still accept chat add-ons.
  `cart.find_active_order` only ever looks up `is_open == True` rows to
  append to; `OrderPanel`'s `Switch` is the one thing that actually
  closes an order for further accumulation. Verified end-to-end: a
  same-session order → closed via `PATCH /agent/orders/{id}` → a
  follow-up "add one more" in that SAME chat session correctly created a
  **new** `Order` instead of reopening the closed one.
- **`POST /api/cart/add`** (`apis/products.py`'s `public_router`,
  no auth, rate-limited like `/api/chat/upload`) — the deterministic,
  non-LLM add-to-cart mutation shared by the `ProductList` Block, a
  product's own detail page, and the chatbot's own product cards.
  Resolves the caller's `session_id` via `apis/chat.py`'s
  `_get_or_create_session` (same function `/api/chat` itself uses) then
  calls `cart.find_active_order`/`cart.apply_order_delta` — **the exact
  same functions the chat pipeline calls**, so there's one order-
  mutation code path, not two that could drift apart. Verified
  end-to-end: two `POST /cart/add` calls with the same `session_id`
  correctly accumulated on the same `Order`; a `POST /cart/add` followed
  by a chat turn in the SAME session correctly saw and added to that
  same order (a visitor's cart never splits between "things clicked on
  a page" and "things said in chat").
- **Public storefront routes** (`apis/products.py`'s `public_router`,
  mirrors `apis/pages.py`'s existing `admin_router`/`public_router`
  split): `GET /api/products` (catalog, optional `?category=`),
  `GET /api/products/{id}` (404 if missing/unavailable),
  `GET /api/products/search?q=` (wraps `cart.search_products`),
  `GET /api/product-fields`. **A real routing bug was caught and fixed
  during verification**: `/products/search` was registered AFTER
  `/products/{product_id}` — FastAPI matches routes in registration
  order, so a request to `/products/search` was being swallowed by the
  dynamic route as `product_id="search"` and 422ing ("search" isn't a
  valid int). Fixed by moving the fixed literal path before the dynamic
  one; a comment now flags this ordering requirement for any future
  route added to this router.
- **Frontend**: `ProductListBlock` is a new CTE-insertable Block type
  (`backend/apis/agent.py`'s `Block` union, `frontend/src/lib/
  block-registry.ts`) — deliberately excluded from `_VISION_SYSTEM_
  PROMPT` (the vision model has no business inventing which products to
  feature; owner-inserted only, matching `CarouselSection`'s existing
  "built, not vision-generated" precedent). **A real Client/Server
  Component boundary conflict was caught while building it**: the plan
  called for an async Server Component fetching via `INTERNAL_API_URL`
  (matching this project's own documented gotcha for Server Component
  fetches) — but `BlockRenderer`, the recursive dispatcher that renders
  every Block type including this one, is itself a Client Component
  (needs the CTE editing interactivity), and a Client Component cannot
  render an async Server Component as a child. Corrected to a Client
  Component with `useEffect`-based fetching instead (`NEXT_PUBLIC_
  API_URL`, resolved automatically by `apiFetch`) — a real design
  correction made during implementation, not the original plan.
  `/products/[id]` (a REAL Server Component page, no such conflict
  since it's a top-level route, not a `BlockRenderer` child) and
  `/search` are new, dedicated, stable, bookmarkable public routes —
  deliberately NOT CTE blocks (people keep detail tabs open to compare
  products, a real UX reason the user gave directly). A single shared
  `ProductCard` component (image/name/price/Add to cart) is reused
  across `ProductListBlock`, `/search` results, `/products/[id]`'s
  bundle/upsell mini-cards, and the chatbot's own cards/swiper — one
  place to get the shape right, not four.
- **CTE product-promo blocks, `/cart`, `/checkout`** (2026-08-20) — three
  owner requests off the back of real use: (1) a way to feature ONE
  product outside a full `ProductListBlock` grid (a homepage strip, a
  swiper slide), (2) `ProductListBlock` filtering to specific products,
  not just a whole category, (3) an owner-composed block (arbitrary
  Image/Text/Button children) that ends in a real add-to-cart action and
  links through to a product page — plus the two system pages every
  "Add to cart" control had quietly been building an `Order` for with
  nowhere to actually review it.
  - **`ProductCardBlock`** (`type: "product-card"`, `frontend/src/lib/
    theme.ts`, mirrored in `backend/apis/agent.py`) — `ProductListBlock`'s
    one-item counterpart: `product_id: number | null`, fetches and
    renders via the same `ProductCard` component every other product
    surface reuses. `null` (the freshly-inserted default) renders an
    empty-state placeholder, never a broken fetch, until the owner picks
    one in the CTE editor.
  - **`ProductListBlock.product_ids`** — an explicit ordered allow-list
    ("feature exactly these 3 products, in this order"), takes priority
    over `category` when both are set (the two aren't meant to be
    combined). `GET /api/products` gained a matching `ids` (comma-
    separated) query param — reorders results to match the given id
    order (SQL `IN` doesn't preserve it) and silently drops an id with no
    matching *available* product. Also gave `ProductListBlock` a real
    `Editable` wrapper for the first time — before this, an inserted
    instance had no CTE UI to set its filter at all, only the unfiltered
    `createDefault()`.
  - **`ContainerBlock.link_product_id` + `ButtonBlock.action`/
    `product_id`** — the "owner-composed product promo block" mechanism:
    an owner freely arranges Image/Text/Button children inside a
    Container (nothing new to learn — the same primitives every other
    custom layout already uses), binds the whole container to one
    product (`link_product_id`), and optionally gives one child button
    `action: "add_to_cart"` instead of `action: "link"` (the original,
    only behavior — unset renders exactly as before this field existed).
    The container renders a **stretched-link overlay** (`Link
    className="absolute inset-0 z-0"`, a positioned *sibling* of its
    children, not a wrapper around them — the same well-established card
    pattern Bootstrap calls `.stretched-link`) rather than literally
    wrapping its content in an `<a>`, specifically so a nested
    `action="add_to_cart"` `<button>` never ends up invalidly nested
    inside an anchor. Per CSS paint order, that z-index:0 overlay paints
    *above* ordinary static-positioned children (so clicking the image/
    text correctly navigates to the product) but *below* anything with an
    explicit higher z-index — every `ButtonBlock` instance (link or
    add_to_cart) now renders `relative z-10` unconditionally so it always
    stays clickable above any ancestor's product-link overlay, not just
    when it happens to be the add-to-cart button.
  - **`/cart` and `/checkout`** (`frontend/src/components/modules/
    cart-page.tsx`/`checkout-page.tsx`, both Client Components — same
    `getChatSessionId()`-reads-`localStorage` reasoning as
    `ProductListBlock`) — real system pages, finally giving every
    "Add to cart" control (`ProductCard`, `ProductDetail`, an owner's own
    add-to-cart Block, the chatbot's own product cards) somewhere to
    send a visitor. **No real payment anywhere in this app** (matches
    this section's own "CRM-adjacent order tracking, not e-commerce
    checkout" framing) — `/checkout`'s "Place order" records
    contact_email/contact_name/pickup_time/note and flips `is_open` to
    `False`, the exact same signal the owner's own `OrderPanel` toggle
    already uses for "no more chat/cart add-ons," reused here for "the
    visitor themselves is done adding to it." Three new public
    `apis/products.py` routes power both pages, all reusing
    `cart.find_active_order`/`apply_order_delta` (never a second,
    divergent mutation path): `GET /cart` (session-scoped active order,
    `null` — not a 404 — for an empty cart), `POST /cart/update`
    (`quantity_delta`, can be negative — `/cart`'s +/- stepper and
    Remove button both resolve to this one endpoint; decrementing/
    removing stays allowed even if the product has since become
    unavailable, only a positive delta is blocked for an unavailable/
    missing product, mirroring `add_to_cart`'s own check), `POST
    /cart/checkout` (400s on an empty/missing cart rather than creating
    an empty `Order`). Verified end-to-end via direct API calls (empty
    cart → add two products → decrement → remove → checkout → `GET
    /cart` correctly returns `null` post-checkout since `is_open` is now
    `False` → a second checkout attempt correctly 400s) and the new CTE
    block shapes round-tripped through a real `POST .../pages/{slug}/
    versions` save + public read (page content is stored as an
    unvalidated `dict` — see `apis/pages.py`'s `SaveVersionRequest` — so
    the backend Pydantic `Block` mirror only matters for
    `generate_landing_page`'s own validation path, never for CTE-saved
    content, but is kept in sync anyway per this file's own "keep both
    in sync" rule). A small `ShoppingCart` icon link in `SiteHeader`
    (no live item-count badge — that would cost a cart fetch on every
    page load just for a header icon) is the one discoverability
    addition; matches `/products/[id]`/`/search`'s own existing
    precedent of staying out of `primaryNav`.
- **v1 scope cuts, deliberate**: no product variant/attribute matrix
  (WooCommerce's "variable product" — a "Latte Large" vs "Latte Small"
  are two separate `Product` rows), no inventory/stock tracking, no
  strict pickup-time parsing (`pickup_time` stays free text — "9am",
  "in 5 minutes" — same posture as `IntentField`'s "date" type already
  just storing whatever string the model extracted), no product `slug`
  (`/products/[id]` stays numeric-id-based), no manual editor for
  `order_status_options` (only `set_order_status_options` sets it, same
  posture as `IntentView`'s `status_options`), `/search` re-runs its SQL
  search live on every load rather than caching a result snapshot — a
  deliberate call from the user: avoiding resource waste here means
  never re-invoking an LLM on a page load, not persisting search
  results, and a plain `ILIKE` search is cheap enough to just re-run.
  **Known gap, not yet hit for real** (flagged 2026-08-20 while
  discussing the storefront with the user): `/search` has no pagination
  — `searchPublicProducts`'s default `limit=20` is a hard cap with no
  "showing 20 of N" indicator or load-more affordance, so a query
  matching more than 20 products silently drops everything past the
  20th with no signal to the visitor that anything was cut off. Harmless
  at this project's current catalog size (a handful of products); worth
  a real "load more"/offset-based pagination pass, or at minimum a
  "showing the first 20 — refine your search" message, once/if a real
  catalog grows past that.
- Verified end-to-end with real conversations across every branch: a
  single order ("I'll come at 9am for a latte" → correct `Order` +
  `OrderItem`, real price stated, a product card returned), a
  same-session add-on ("add a croissant too" → same order, real
  recomputed total $8.50 = $5.00 + $3.50, not LLM arithmetic), an
  ambiguous order (2 matching products → disambiguation, no order
  created), a 2-match browse ("anything with espresso?" → 2 cards), and
  a 6-match browse ("what coffee drinks do you have?" → a `/search`
  link, not inline cards) — plus the cart-add/chat cross-surface test
  and the custom-fields/image/bundle round-trip described above.

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
generating new content is `PageGeneratorPanel`'s job. For a page with no
content at all yet, `PageManager`'s "New blank page" form (2026-08-19,
`/dashboard`'s Saved pages list) saves an empty `sections: []` version
to a new slug via the same `savePageVersion` `PageGeneratorPanel` already
uses — the slug then shows up in `/editor`'s own datalist, ready to
build up from nothing via its "+" insert gaps. Closes a real gap found
by the user while testing: before this, there was no "start from
scratch" path anywhere in the app at all — `/editor` only edits, and
`PageGeneratorPanel` only generates from a design image/documents.

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
  real LLM tool-calling loop over a fixed 11-tool allowlist, its own
  owner-only auth check, and action logging to stdout + a bind-mounted
  `logs/runs.jsonl` (per-step, durable). The worker's "brain" model
  selection is now wired to the owner-facing model picker too
  (2026-08-18, see "Owner agent" below) — it was fixed via
  `OWNER_AGENT_MODEL`/Ollama-only until then. **Now also has a queryable
  DB-backed action-log** (2026-08-19, `backend/models.py`'s
  `OwnerAgentRun`, alongside the JSONL file, not instead of it — see
  "Owner agent" below) and `generate_landing_page` is now wired in as a
  tool. **Still not done**: no red-team pass, no openclaw
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
  envelope: either call one of 16 tools (`generate_poster`,
  `generate_landing_page`, `crm_create_entry`, `crm_list_entries`,
  `crm_delete_entry`, `generate_report`, `generate_geo_page`,
  `scan_crm_attachment`, `cleanup_chat_uploads`, `list_intent_schemas`,
  `manage_review_queue`, `detect_business_type`, `propose_intent_schema`,
  `list_products`, `propose_products`, `set_order_status_options` — each
  a thin HTTP call onto an already-real `backend/apis/agent.py`/
  `apis/intent_schemas.py`/`apis/products.py` endpoint) or give a final
  answer. Up to 6 turns, a 300s overall budget. The full step trace
  (tool, args, result, ok/error) is returned to the frontend and
  rendered, not just the final answer.
- **`generate_landing_page`** (2026-08-19) takes an already-uploaded
  image's **URL**, not raw base64 — asking a text-generation model to
  reproduce a whole image as base64 inside its own tool-call JSON is
  neither reliable nor something it should be doing at all. The owner
  uploads a design image via the dashboard's media library or CTE's
  Upload tab first, gets a URL back, then tells owner-agent to use it.
  New backend route `POST /agent/landing-page/generate-from-url`
  (`apis/agent.py`) resolves that URL back to a local file via
  `apis/media.py`'s `resolve_media_local_path` — same paranoid posture
  as `chat_attachments.resolve_local_path` (exact prefix match, exactly
  one path segment, a `resolve()`-based containment check before ever
  touching disk) — then calls the same `_generate_landing_page_sections`
  helper the original `generate_landing_page` route was refactored to
  share, so both routes produce identical results. Deliberately doesn't
  save/publish the result — the tool's own description tells the model
  to have the owner review and save it themselves via the Page generator
  panel. `ToolSpec` gained a per-tool `timeout` override (this tool sets
  620s) since the shared `_TOOL_CALL_TIMEOUT` (200s, sized for poster
  generation) would cut off a slow vision+JSON generation mid-call —
  backend itself already budgets up to 600s for that single call (see
  `providers/custom.py`'s timeout comment).
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
  (the 9 tools, the brain call above, and now the action-log write
  below), and it forwards the caller's real bearer token on every one of
  those calls so `backend`'s own `require_role` independently
  re-authorizes every action (defense in depth: a compromised worker
  still can't do anything `backend` wouldn't already allow that caller to
  do). Because no tool result ever contains attacker-influenced
  *external* content re-entering the model's context (every tool result
  is this app's own structured JSON), the classic "fetched content
  reinterprets itself as an instruction" prompt-injection vector doesn't
  apply to this design.
- **Queryable action-log history** (2026-08-19) — `owner-agent/logging_.py`'s
  per-step `logs/runs.jsonl` write stays exactly as it was (owner-agent
  is still DB-less by design; that file is its only durable record if the
  call below ever fails), but `main.py`'s `/run` handler now also calls
  `POST /agent/chat-completion`'s sibling route, `POST
  /agent/owner-agent/runs` (`apis/agent.py`), once per completed run —
  persists `backend/models.py`'s new `OwnerAgentRun` row (command,
  final_answer, stopped_reason, the full step trace as JSONB,
  `owner_email` read off the same forwarded bearer token every tool call
  already carries). Best-effort: a logging failure never fails the run
  response the owner is actually waiting on. `GET
  /agent/owner-agent/runs` (paginated via `limit`, most-recent-first) is
  what makes this actually queryable — `OwnerAgentPanel` now renders a
  collapsed "Recent runs" list underneath the live run UI
  (`lib/owner-agent.ts`'s `listOwnerAgentRuns`), refreshed after every
  new run completes.
- **`detect_business_type`/`propose_intent_schema`** (2026-08-19) —
  owner-agent can now draft a new/updated `IntentSchema`, but
  deliberately can never write one itself, unlike `manage_review_queue`'s
  apply-a-default-then-adjust pattern: a schema defines what data gets
  collected from real future visitors, a real data-integrity concern a
  review queue's `status_options` doesn't carry, per the owner's own
  explicit framing when this was requested. `detect_business_type`
  (`POST /agent/business-profile/detect`, `apis/intent_schemas.py`)
  reuses `_gather_ready_document_text`/`resolve_chat_provider` (the
  exact `generate_geo_page` pattern) to guess an industry label from
  ingested documents, returning `detected_label: null` (not an error)
  when there are none — but the *owner's own stated business always
  wins*, a priority rule stated directly in the tool's own description
  for the model to follow, not something enforced in code (same posture
  as every other "the model decides, given the right inputs" design in
  this app, e.g. `_lead_extraction_call`'s classification).
  `propose_intent_schema` (`POST /agent/intent-schemas/propose`) runs
  the exact same `_validate_fields` check `create`/`update_intent_schema`
  already use, but never constructs or commits a row — it only echoes
  back the validated draft plus `already_exists`/`existing_id` (looked
  up the same way `create_intent_schema` already checks for a key
  collision). `OwnerAgentPanel` (frontend) scans a completed run's steps
  for a successful `propose_intent_schema` call and renders an editable
  review card — `Select` for each field's type, `Switch` for `required`
  (matching `IntentSchemaPanel`'s own choice of `Switch` over a separate
  `Checkbox` primitive, intentionally) — with **Apply** (calls the
  already-existing `createIntentSchema`/`updateIntentSchema`, sending
  whatever the owner actually edited, not necessarily the raw proposal)
  and **Discard** (clears it, no network call). Verified end-to-end with
  a real command ("our uploaded docs are about real estate, but we're
  actually a web design agency — propose a schema for project
  inquiries...") — the model correctly deferred to the stated business
  over the ingested real-estate documents, called `list_intent_schemas`
  first, and its final answer stated a draft was ready to review rather
  than claiming anything was created; `GET /agent/intent-schemas`
  confirmed no row existed until a separate, explicit Apply-equivalent
  call was made.
- **`list_products`/`propose_products`/`set_order_status_options`**
  (2026-08-19) — see "Product catalog + ordering" above for the full
  design. `propose_products` follows the exact same propose-then-owner-
  applies posture as `propose_intent_schema` (a batch of drafts, never
  writes) — a misread price affects what a real customer is quoted, the
  same class of mistake schemas already get this safety net for.
  `set_order_status_options`, by contrast, applies directly like
  `manage_review_queue` — a status-label list is cheap to adjust
  afterward. **A real bug was caught and fixed verifying this**:
  `owner-agent/tools.py`'s `execute_tool` only ever attached a JSON body
  for `method == "POST"` — `set_order_status_options` uses `PUT` (and
  `ToolSpec.method`'s `Literal` didn't even include `"PUT"` yet), so the
  first real run sent an empty body and 422'd against the backend's own
  required-field validation twice before the model correctly gave up and
  reported the failure honestly instead of claiming success. Fixed by
  widening the `Literal` to `PUT`/`PATCH` and attaching the JSON body for
  all three write methods, verified with a second real run that
  succeeded and persisted correctly (`GET /agent/order-status-options`
  matched). Worth remembering: any *new* HTTP method introduced by a
  future tool needs the same two-place check (`ToolSpec.method`'s
  `Literal` AND `execute_tool`'s body-attachment condition), not just
  one.
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
- **All three Dockerfiles run as a non-root user now (2026-08-19,
  `appuser`/`node`, uid/gid 1000) — this broke on the first attempt in
  two genuinely non-obvious ways, both real file-permission issues, not
  hypothetical ones the original security-audit note was worried
  about**:
  1. `frontend`'s `.next` is `.dockerignore`'d (Next only ever creates it
     at runtime) — `chown -R node:node /app` in the Dockerfile had
     *nothing at that path to chown* at build time, so Docker seeded the
     fresh anonymous volume for it as an empty, **root-owned** directory
     regardless. Result: `next dev` crashed immediately with `EACCES:
     permission denied, mkdir '/app/.next/dev'`. Fix: `mkdir -p
     /app/.next` *before* the `chown` line, so there's actually
     something there for both the chown and the volume-seed to act on.
  2. `backend`'s `storage/documents`/`storage/media`/`storage/chat_uploads`
     are bind-mounted from the host (`./backend:/app`) — the Dockerfile's
     own build-time `chown` is entirely moot for anything under a bind
     mount (the mount shadows the image's `/app` completely at container
     start). These specific subdirectories already existed on disk,
     created back when the container ran as root (mode `755`,
     root-owned) — the new non-root `appuser` could read them but not
     write, which `apis/documents.py`/`apis/media.py`/`chat_attachments.py`
     need to do on every upload. This is a **one-time migration issue
     for an existing checkout**, not an ongoing code problem (any
     directory `appuser` creates itself from now on is naturally
     appuser-owned) — fixed with a single `docker compose exec -u root
     backend chown -R appuser:appuser /app/storage` after rebuilding.
     `owner-agent`'s `logs/` dir didn't need this (already permissive
     enough as-is) — don't assume every bind-mounted dir needs the same
     treatment, check first (`ls -la`, or just try a real write and see).
  Both verified with real writes, not just `whoami`/`id`: a real
  `POST /agent/documents/ingest` (chunked, embedded, `status: "ready"`)
  and a real `next dev` compile-and-serve of `/dashboard`/`/chat`
  (`200`, not just process-alive) after the fixes, not before.
- **`backend/alembic/versions/` is a fourth bind-mounted path that needed
  the same one-time `chown` fix** (2026-08-19, found generating this
  session's migration) — the directory itself was still root-owned from
  before the non-root-user switch (unlike `storage/`'s issue, this was
  the *directory's* own write bit, not pre-existing files in it), so
  `alembic revision --autogenerate` failed with a `PermissionError`
  trying to create the new migration file. Fixed the same way: `docker
  compose exec -u root backend chown -R appuser:appuser
  /app/alembic/versions`. Add this to the list of bind-mounted paths to
  check first (alongside `storage/`) if a from-scratch checkout ever
  hits a permission error running a fresh migration.
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

**2026-08-19**: driven by the user actually running this against their
own real local llama.cpp/ComfyUI setup. Fixed a real `[object Object]`
error (`frontend/src/lib/api.ts` assumed FastAPI's `detail` was always a
string; a 422 validation error sends an array instead — see
`extractErrorMessage`). Gave embedding its **own** custom endpoint,
separate from chat/vision's shared one (`embedding_base_url`/
`embedding_api_key` — see "AI provider is swappable" above), after
confirming with the user that their real setup needs two independent
llama.cpp processes. Extended image generation with a ComfyUI checkpoint
picker (`image_comfyui_unet`/`_clip`/`_vae`, live-queried from ComfyUI's
own `/object_info`) and, going further, support for an owner-pasted
**entirely custom ComfyUI workflow** (`image_comfyui_workflow`/
`_prompt_node`/`_prompt_field` — any architecture, not just this app's
fixed one) — see "Agent console capabilities" below and `providers/
comfyui.py`'s docstring. Fixed a second stale-hardcoded-model-name bug
(`page-generator-panel.tsx` said "qwen3.6"/"36B model" unconditionally —
same class of bug as the `/api/chat` "running via Ollama" fix above; now
reads the actual configured vision model from `GET /agent/settings`).
Reorganized `/dashboard`'s 8 flat panels into a collapsible accordion
(`frontend/src/components/ui/accordion.tsx`, hand-written against
`@base-ui/react`'s already-installed `accordion` submodule — no new
package needed) grouped as AI & knowledge base / Content generation /
CRM & reporting / Owner agent. Verified `generate_landing_page`
end-to-end for the first time this session with a real (synthetic)
mockup — see the qwen3.6-nesting bullet below for what this did and
didn't confirm. Later the same day: built owner-configurable structured
collection (`IntentSchema`/`IntentField`, dashboard-form-only) and
owner-agent-generated review queues (`IntentView`, `manage_review_queue`
— apply-a-default-then-adjust-after, no owner confirmation needed since
adjusting a queue's statuses is cheap). Then, closing the one piece
those two arcs deliberately deferred: gave owner-agent
`detect_business_type`/`propose_intent_schema` (see "Owner agent"
below) so it can draft a *schema* change too, but — unlike review
queues — never apply one itself; the owner reviews and explicitly
Applies or Discards the draft in a new review card inside
`OwnerAgentPanel` (real `Select`/`Switch` controls, not free text),
built specifically because a schema controls what data gets collected
from real future visitors, a higher-stakes, harder-to-reverse change
than a queue's status list. Verified end-to-end with the user's own
example scenario (documents about one business, owner stating a
different one) — the model correctly deferred to the owner's stated
business over the ingested documents' content. Then, extending further
on the user's own request ("我们延伸看看"): a generic **product
catalog + ordering** system (`Product`/`Order`/`OrderItem`, `apis/
products.py`, see "Product catalog + ordering" above) — modeled on
WooCommerce's product concept rather than restaurant-specific, after
the user explicitly reframed an initial "can the chatbot take coffee
orders" question into "we build the framework, owner-agent handles the
vertical details." Two design forks the user resolved directly: order
accumulation ("加单") gated by an explicit `is_open` toggle rather than
inferring from owner-agent-generated status text, and product creation
following the same propose-then-owner-applies flow just built for
`IntentSchema` rather than `manage_review_queue`'s apply-directly
pattern, since a misread price affects a real customer's quote. Verified
end-to-end with a real multi-turn conversation ("I'll come at 9am for a
latte" → correct order + real price; "add a croissant too" → same order,
correct recomputed total $8.50) and the `is_open` gating edge case (a
closed order correctly forces a new one on the next chat turn rather
than reopening). Caught and fixed a real bug during verification:
`owner-agent/tools.py`'s `execute_tool` never attached a JSON body for
non-POST write methods, silently breaking the new `PUT`-based
`set_order_status_options` tool — see "Owner agent" above. Then,
extending further still on the user's own steer: a full **storefront
layer** over that catalog — product images (reusing the media library,
never fetching an owner-supplied URL server-side), owner-defined custom
fields (`ProductFieldDefinition`, mirrors `IntentField` exactly),
bundle/upsell relations (one generic `ProductRelation` table), a
`ProductList` CTE block, dedicated `/products/[id]`/`/search` public
pages, a deterministic non-LLM `POST /cart/add`, and product cards/
Swiper in the chatbot itself — see "Product catalog + ordering" above
for the full design, including a genuine mid-session refactor of the
order-extraction pipeline (SQL search replacing "list the whole catalog
and ask the LLM to pick an ID," result-count branching moved fully into
code) and three real bugs caught and fixed during verification: a
tokenized-vs-whole-phrase `ILIKE` search miss, a FastAPI route-ordering
bug (`/products/search` swallowed by `/products/{id}`), and a Client/
Server Component boundary conflict that forced `ProductListBlock` to
fetch client-side instead of the originally planned server-side fetch.
Verified end-to-end across every count-branch (0/1/2-5/>5 matches),
the ambiguous-order-doesn't-guess case, and cart/chat cross-surface
unification (adding via `POST /cart/add` then via a chat turn in the
same session correctly landed on the same `Order`). Full narrative (the
router-vs-dedicated-process embedding discovery, a PowerShell encoding
crash in a launcher script, a `.next` dev-cache 404 hit mid-
verification, the git commit) in `HISTORY.md`.

**2026-08-20**: a debugging + latency session, then one more storefront
extension pass. Fixed two real, previously-undetected bugs the user
reported symptoms of directly: ComfyUI generations always taking ~30s
to appear regardless of how fast the actual generation finished (the
websocket wait listened with the wrong `client_id` — see "Agent console
capabilities" above), and a single order-taking chat turn taking close
to a minute on a slow local model (three sequential LLM calls where two
were actually independent — order extraction and lead extraction now
run concurrently, see "Product ordering" above). Also closed a real gap
found while reviewing the dashboard: `ProductPanel`'s create/edit form
had no way to set a product's `image_url` at all despite the field
existing end-to-end everywhere else (type, backend, `ProductCard`,
`ProductDetail`) — added a Photo field reusing the existing
`ImageFieldEditor` (URL/upload/generate/library tabs). Then, off the
user's own follow-up ("some products need to be featured/advertised
separately, and I want the block system to support that"): a single
`ProductCardBlock` (one featured product, ProductListBlock's one-item
counterpart), `ProductListBlock.product_ids` (an explicit ordered
allow-list filter, alongside the existing `category` filter which
finally got real CTE editing UI — it existed on the schema before this
but had no way to actually set it after inserting), and the
"owner-composed product promo block" mechanism (`ContainerBlock.
link_product_id` + `ButtonBlock.action`/`product_id` — see "Product
catalog + ordering" above for the full stretched-link-overlay design).
Finally, built the two missing system pages every "Add to cart" control
had been quietly accumulating an `Order` for with nowhere to send a
visitor: `/cart` (view/adjust/remove) and `/checkout` (contact details +
"Place order," no real payment — just closes the order). Verified via
`tsc`/`eslint`/a real production build (`next build`, catching any RSC
boundary issues `tsc`/`eslint` wouldn't) and direct backend API calls
end-to-end (build a cart, decrement, remove, checkout, confirm a
second checkout attempt on the now-closed order correctly 400s) plus a
real save/read round-trip of the new block shapes through
`POST .../pages/{slug}/versions`. The Chrome extension still didn't
connect this session either — every check above was `curl`/build-tool
based, not a live click-through.
- **A real in-browser click-through of everything in this project** —
  still the single biggest verification gap, unresolved across every
  session so far including this one (the Chrome extension never
  connected). Everything, CTE through today's dashboard/CRM/attachment
  UI, was verified via `tsc`/`eslint`/curl/backend checks and dev-server
  logs, never a live click-through by this session's own tools.
- **Both real findings from an earlier session's security audit are now
  fixed** (2026-08-19): all three Dockerfiles (`backend`, `frontend`,
  `owner-agent`) run as a non-root user (`appuser`/the image's built-in
  `node` user, uid/gid 1000) instead of root; `backend/requirements.txt`
  and `owner-agent/requirements.txt` are pinned to exact versions
  (`==`, captured via `pip freeze` from a working container) instead of
  open-ended `>=`. See "Known gotchas" below for the real file-permission
  issues this surfaced and how they were fixed — non-trivial, exactly the
  care this was originally flagged as needing.
- A `/dashboard` viewer for the chat sessions/messages already being
  persisted (session list + per-session transcript) — deliberately
  deferred out of the original persistence work to keep that change
  small, still not built.
- Whether the vision model can reliably generate the Container/Block
  schema's *deeper nesting* patterns from a real design image — still
  genuinely open. A 2026-08-19 end-to-end test (synthetic mockup,
  `Qwen3.8_Uncensored`) produced a good flat result (hero/feature-grid/
  cta-banner composite sections, header/footer correctly falling back to
  one-level `container` blocks) but didn't exercise nested containers —
  everything CTE supports editing at the nested-container level was
  still hand-authored via curl, never generated by the model on its own.
- Phase 6 (agent security layer) — `owner-agent/` now has a real
  tool-calling loop over 16 tools, a queryable DB-backed action-log
  (2026-08-19, alongside the JSONL file, see "Owner agent" above),
  `generate_landing_page` is wired in as a tool, and both schema
  changes and product-catalog changes now go through an explicit
  propose-then-owner-applies flow rather than being written directly;
  still open: a red-team pass, openclaw permission-boundary docs beyond
  the existing paragraph.
- Smaller unstarted items: chat streaming, real LLM-driven intent
  recognition, GSAP/ScrollTrigger, Swiper carousel content.
- Local resource coordination (`resource_broker.py`, above) is
  deliberately v1-scoped: the standalone embedding server isn't part of
  it yet (fix would be a one-line `--sleep-idle-seconds` in
  `llama-embed.ps1`, not broker logic), and there's no live memory-usage
  dashboard. The concurrency gap flagged when this first landed — a
  public chat visitor mid-turn at the exact moment an owner triggers a
  poster generation — is now handled for the case that actually
  mattered: `resource_broker.has_active_chat_requests()` (an in-process
  counter, held for a whole `/api/chat` turn — see `apis/chat.py`)
  makes `maybe_release_llm_memory` refuse outright while a real visitor
  turn is in flight, on the owner's own explicit priority call (protect
  the customer-facing chatbot over the owner's own poster-gen
  convenience). Verified for real: a backgrounded `/api/chat` call kept
  the model loaded through a concurrent `generate_poster` call even with
  the headroom threshold forced impossibly high, then the very next
  `generate_poster` (chat turn finished, counter back to 0) correctly
  unloaded it. Still not narrowed further: a visitor's *next* message
  arriving just after an unload-and-reload cycle already started isn't
  protected — closing that needs real request queueing, judged
  out of scope for now.

Ask the user which, if anything, to pick back up.
