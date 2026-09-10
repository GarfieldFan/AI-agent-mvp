# AI MVP — project reference

Read this before doing anything else in this repo. It's a **current-state
reference**, not a changelog — it tells you what exists and why, not the
story of how it got built. For the full chronological development log
(every bug found, every decision debated, every verification run) see
**`HISTORY.md`** — read it only when you need the deep "why" behind a
specific decision below; don't load it by default.

An original project plan (positioning, tech choices, phased build order)
existed as a local planning document, not tracked in this repo — this
file tracks current status against real, verified behavior, not a plan.

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
├── docker-compose.yml        backend + frontend + postgres-db + owner-agent + ollama services
├── .env / .env.example       host/ports/ComfyUI config — see "Configuration" below
├── deploy/                   real-server deployment automation — see "Deploying to a real server" below
│   ├── setup-server.sh         one-command bootstrap for a fresh Ubuntu/Debian server
│   ├── update.sh                pulls latest code + restarts an already-deployed stack
│   ├── nginx.conf.template      reverse-proxy config template for the optional --domain mode
│   └── README.md                 the one-time manual AWS-console (or any VPS) steps + full walkthrough
├── backend/                  FastAPI (Python) — see backend/main.py
│   ├── db.py                  SQLAlchemy engine/session (DATABASE_URL), Base, get_db dependency
│   ├── models.py               User / Page / PageVersion / Document / DocumentChunk / AppSettings / ChatSession / ChatMessage / CrmEntry ORM models
│   ├── auth.py                 password hashing (bcrypt) + JWT sign/verify (PyJWT)
│   ├── seed.py                 creates the 3 demo accounts — run manually after migrating, LOCAL DEMO ONLY, never on a real deployment (see create_owner.py)
│   ├── create_owner.py          production-safe real-owner-account bootstrap — deploy/setup-server.sh's own first-run step, not seed.py
│   ├── ingest.py                RAG doc parsing (pdf/docx/md/txt) + chunking — pure functions, no I/O
│   ├── retrieval.py              RAG retrieval: embed -> pgvector search -> scored chunks (no router — called from apis/chat.py)
│   ├── llm_json.py                lenient JSON extraction from raw LLM output, shared by agent.py/chat.py/chat_attachments.py
│   ├── chat_attachments.py        public-chat file upload storage + vision/document analysis — see "Chat lead capture" below
│   ├── cart.py                     shared Product search/Order mutation logic (apis/chat.py + apis/products.py both use it) — see "Product catalog + ordering" below
│   ├── resource_broker.py           local LLM/ComfyUI memory coordination — see "Agent console capabilities" below
│   ├── rate_limit.py               per-IP rate limiting for the fully public routes — see "Rate limiting" below
│   ├── turnstile.py                 Cloudflare Turnstile bot verification — see "Bot verification" below
│   ├── providers/                AI provider abstraction (Ollama/OpenAI/Anthropic/Gemini) — see "AI provider is swappable" below
│   ├── alembic/                 migrations — env.py wired to DATABASE_URL + models' metadata
│   └── apis/
│       ├── api.py             ComfyUI image-gen wrapper; URLs env-driven, see "Configuration" below
│       ├── auth.py            POST /auth/login, GET /auth/me
│       ├── chat.py            user-tier chat (public): retrieval.py + ChatProvider, RAG-grounded when relevant, no tools; logs sessions (ChatSession/ChatMessage)
│       ├── agent.py           admin/owner-only "agent console" — every route real (see "Agent console capabilities" below)
│       ├── documents.py        RAG document management (admin): upload/list/delete
│       ├── media.py            CTE media library (admin): list ComfyUI-output + uploaded images, upload
│       ├── model_settings.py   owner-facing AI model picker (admin): list/get/set chat, vision, embedding, and image-gen provider+model
│       ├── pages.py            page storage: save/list/restore/delete (admin) + public read-by-slug
│       ├── intent_schemas.py    owner-configurable structured chat collection (IntentSchema/IntentField/IntentView) — see "Chat lead capture" below
│       ├── products.py          Product/Order catalog + storefront (admin CRUD + public reads/cart) — see "Product catalog + ordering" below
│       └── deps.py            RBAC: Role enum + require_role() dependency, backed by real JWTs
├── owner-agent/               isolated LLM tool-calling loop, own container/port 8100 — see "Owner agent" below
│   ├── deps.py                 owner-only JWT check (duplicated from backend, not imported — see below)
│   ├── tools.py                 fixed 21-tool allowlist + execute_tool() (HTTP calls onto backend)
│   ├── agent_loop.py             the loop itself: JSON-envelope tool selection against Ollama
│   ├── logging_.py                action log: stdout + logs/runs.jsonl (never the bearer token)
│   └── main.py                  FastAPI app: GET /health, POST /run
└── frontend/                 Next.js (TypeScript) — see frontend/AGENTS.md + frontend/HISTORY.md
    └── src/components/...    reusable component catalog lives there
```

All five services (`backend`, `frontend`, `postgres-db`, `owner-agent`,
`ollama`) run via `docker-compose up` — backend on :8000, frontend on
:3000, Postgres+pgvector on :5432, owner-agent on :8100, and (2026-09-09)
a bundled Ollama on :11434 (127.0.0.1-only — see "Bundled Ollama" below
for why this exists as a real compose service now instead of an
owner-installed host process). Both `backend/` and
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

**`LOCAL_MODELS_DIR`** (2026-09-09, defaults `./models`) is the one
exception to "docker-compose.yml composes these" above — it is
deliberately NOT read by any service in this stack. See "Local model
files convention" below for what it's actually for (a convention for
the owner's own self-hosted inference server command, connected via the
already-existing "Custom endpoint" model picker, not this variable).

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

## Deploying to a real server (`deploy/`)

Added 2026-09-09, closing the "automated cloud/server deployment" open
item this file previously called "genuinely unstarted." Scope confirmed
directly with the user (`AskUserQuestion`) before building: this
automates everything that happens **on the server itself** — it does
NOT provision an EC2 instance or any cloud resource, since that needs
the owner's own AWS/cloud account credentials, which this project has
no access to and shouldn't be handed. `deploy/README.md` documents the
one-time AWS-console (or any VPS provider's own) steps — launch an
instance, open its firewall/security-group ports, point a domain's DNS
at it — as a normal manual walkthrough; `deploy/setup-server.sh` is
everything from "SSH into a fresh Ubuntu/Debian box" to "the app is
running" in one command.

- **`deploy/setup-server.sh`** — installs Docker (official apt-repo
  method) if missing, clones/updates this repo, generates a real `.env`
  from `.env.example` (never overwrites an existing one), starts the
  stack, creates a real owner account, and — with `--domain <domain>
  --email <email>` — installs Nginx + Certbot and gets a real Let's
  Encrypt certificate. **Idempotent by design, verified directly, not
  just claimed**: every step was checked to either no-op or safely
  reconverge on a second run — re-running never regenerates an
  already-set `JWT_SECRET`, never re-derives an already-fixed
  `COMFYUI_HOST_OUTPUT_DIR`, never creates a second owner account, and
  reuses an already-issued TLS certificate.
- **Never seeds `backend/seed.py`'s demo accounts onto a real server —
  a real security decision, not an oversight.** Those three accounts
  (shared password `0000`, displayed openly on the frontend's own
  `/login` page) are explicitly documented, in `seed.py`'s own
  docstring, as having "nothing behind them worth protecting" in the
  local docker-compose demo — running that script against a publicly
  reachable server would leave a well-known `owner@example.com`/`0000`
  account with FULL owner privileges sitting on the open internet from
  the instant the containers come up. **`backend/create_owner.py`** is a
  new, deliberately separate, production-safe bootstrap: exactly one
  real owner account, a freshly generated random password
  (`secrets.token_urlsafe(18)`) printed once by the deploy script and
  never written anywhere else (no log file), and it refuses to run again
  once ANY owner account already exists — so re-running the deploy
  script after a partial/failed first attempt can never create a second
  owner or silently reset a password the real owner has already
  changed. Verified directly against this project's own real dev
  database (which already has real owner accounts from `seed.py`):
  correctly detected the existing owner and no-op'd, touching nothing.
- **Firewall handling is deliberately conservative** — the script only
  ever ADDS `ufw` rules (80/443, or the raw app ports when not using a
  domain) when `ufw` is ALREADY active on the box; it never force-enables
  `ufw` for the first time itself. Turning on a firewall remotely
  without first confirming SSH stays allowed is a classic way to lock
  yourself out of your own server — this script has no way to know
  whether the owner is relying on `ufw`, a different firewall, or their
  cloud provider's own security group instead, so the safe default is to
  leave that decision alone and just tell the owner what needs to be
  open (see `deploy/README.md`).
- **A real domain deployment needs every browser-facing URL in
  `docker-compose.yml` to resolve under ONE origin, which required real
  changes there, not just the deploy script** — confirmed by actually
  reading the code, not assumed: `frontend/src/lib/api.ts`'s `apiFetch`
  concatenates `API_BASE_URL` directly with an already-`/api/`-prefixed
  path (every backend router is mounted with `prefix="/api"` in
  `main.py`), so `NEXT_PUBLIC_API_URL` needs to be the bare origin, not
  `.../api`. Two new optional override env vars, both unset (today's
  exact `HOST:PORT` composition, byte-for-byte) unless the deploy script
  sets them:
  - **`PUBLIC_ORIGIN`** (e.g. `https://example.com`) — when set,
    replaces the `http://${HOST}:${PORT}` derivation for
    `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `BACKEND_PUBLIC_URL`,
    `FRONTEND_PUBLIC_URL`, and (backend + owner-agent)
    `CORS_ALLOW_ORIGINS` all at once — they're all conceptually the same
    "this deployment's public origin" value once Nginx proxies both the
    frontend and `/api/*` under one domain (see
    `deploy/nginx.conf.template`).
  - **`PUBLIC_OWNER_AGENT_URL`** (e.g.
    `https://example.com/owner-agent`) — a separate override, since
    owner-agent is reachable via Nginx's own `/owner-agent/` path prefix
    rather than sharing the bare origin the way frontend/backend do.
  - **A genuine, pre-existing gap found and fixed as a side effect**:
    `backend`'s own `docker-compose.yml` service block never threaded
    `CORS_ALLOW_ORIGINS` through AT ALL before this — only
    `owner-agent`'s had it. `main.py`'s `CORSMiddleware` was silently
    falling back to its hardcoded `"http://localhost:3000"` default
    regardless of `HOST`/`FRONTEND_PORT`, harmless for a demo that only
    ever uses those literal defaults, but would have broken every
    browser call with a real CORS rejection the instant a real
    deployment (any non-default `HOST`, exactly what this whole feature
    is for) used a different origin. Now threaded through with the same
    `PUBLIC_ORIGIN` override as everything else.
  - **`BIND_HOST`** (default `0.0.0.0`, today's exact behavior) —
    restricts `backend`/`frontend`/`owner-agent`'s Docker port
    publishing to loopback-only (`127.0.0.1`) when set, the same
    reasoning `postgres-db`/`ollama`'s own port mappings already
    document — the deploy script sets this to `127.0.0.1` specifically
    in `--domain` mode, so the raw HTTP ports are only reachable from
    Nginx on the same machine, never directly from the public internet
    bypassing TLS.
  - **`restart: unless-stopped` added to every service** (there was no
    restart policy at all before this) — a server reboot now brings the
    whole stack back up with zero manual intervention, the concrete
    "WP-style, no ops babysitting" bar the user set for this feature;
    harmless for local dev too (Docker Desktop already generally
    preserves running containers across its own restarts once this is
    set).
  - Verified live against the real running dev stack, not just
    `docker compose config`: recreated every container with the modified
    `docker-compose.yml` and NO override vars set — confirmed
    byte-identical port bindings/URLs to before, the owner's real
    `AppSettings` row (their actual `custom` chat/vision provider
    config) completely untouched, and both backend (`/openapi.json`) and
    frontend (`/`) healthy immediately after. Separately confirmed via
    `docker compose config` with `PUBLIC_ORIGIN`/`PUBLIC_OWNER_AGENT_URL`/
    `BIND_HOST` set that every derived value resolves exactly as
    designed.
- **`deploy/nginx.conf.template`** — three `location` blocks (`/api/`,
  `/owner-agent/`, `/`), each proxy-passed to the right container port
  with the right trailing-slash-or-not shape to match how that
  service's own routes actually expect to receive the path (confirmed
  by reading `main.py`'s router prefixes and `owner-agent/main.py`'s
  own bare `/run`/`/health` routes, not assumed) — see the template's
  own comments for the exact reasoning per block.
  `deploy/setup-server.sh` substitutes `__DOMAIN__`/`__BACKEND_PORT__`/
  `__FRONTEND_PORT__`/`__OWNER_AGENT_PORT__` via `sed`, then runs
  `certbot --nginx` to layer on a real HTTPS server block + auto-renewal.
  A failed `certbot` call (almost always DNS not pointed at the server
  yet) is handled as a clear, non-fatal warning — the site stays
  reachable over plain HTTP in the meantime, with the exact command to
  re-run once DNS resolves.
- **Verified for real, not just reviewed**, within what this sandboxed
  session could actually exercise (no real EC2 instance/AWS account, no
  real domain — both genuinely require the owner's own accounts, see
  above):
  - `shellcheck` (via the real `koalaman/shellcheck` image) clean on
    both `deploy/setup-server.sh` and `deploy/update.sh` — one harmless
    info-level notice (`SC1091`, can't statically follow `/etc/os-
    release`, a real runtime system file).
  - The `.env` bootstrap/upsert logic (`set_env`, the `JWT_SECRET`/
    `COMFYUI_HOST_OUTPUT_DIR`/domain-mode conditionals) extracted and run
    standalone against a real copy of `.env.example`, in isolation from
    the real project's own `.env` (never touched): confirmed correct
    output for both domain and no-domain modes, and confirmed a second
    run is a byte-identical no-op (true idempotency, not just "probably
    fine").
  - The generated Nginx config (real `sed` substitution against the real
    template) validated with a real `nginx -t` (via the official
    `nginx:stable` image) — syntactically valid, not just eyeballed.
  - `backend/create_owner.py` run for real against this project's own
    live dev database (see above).
  - **Not independently verified this round, and said so plainly rather
    than assumed**: the actual `apt-get install docker-ce`/`ufw`/
    `nginx`/`certbot` orchestration on a genuinely fresh Ubuntu/Debian
    box, and a real Let's Encrypt certificate issuance against a real
    resolving domain — both need infrastructure (a real fresh cloud VM,
    a real registered domain) this sandboxed session has no access to.
    Those specific commands are the standard, officially-documented
    invocations for each tool (Docker's own apt-repo method, Certbot's
    own `--nginx` plugin) rather than anything novel, which is why this
    is disclosed as an honest scope limitation rather than treated as a
    blocker to shipping the rest of this verified-for-real.

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
command, a local Ollama model decides which of a fixed 21-tool allowlist to
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
  not just shown for roadmap visibility.
  - **Custom-endpoint vision detection gained a second signal, 2026-09-08
    — a real false negative the user hit directly**: `providers/
    custom.py`'s `list_custom_models` only ever checked the OpenAI-shaped
    `data` array's `architecture.input_modalities` field for vision
    capability. The user's own `llama-server` build responds to `GET
    /models` with BOTH that OpenAI-shaped `data` array AND an
    Ollama-shaped `models` array in the same response — and on their
    server, `data` entries carried no `architecture` field at all (so the
    check always fell through to `False`) while `models` reported
    `"capabilities": ["completion", "multimodal"]` for the identical
    model. Fixed by also checking that second array (matched by id/name)
    — a model now counts as vision-capable if EITHER signal says so;
    `vision` only defaults to `False` when NEITHER is present. Verified
    live against the real server: `list_custom_models` and `GET
    /agent/models`'s `vision_models` both now correctly report the user's
    `Qwen3.8-27B-Uncensored` model as vision-capable.
  **Embedding model selection is a
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
  **Real gap in this "only if changing" guard, fixed 2026-09-08, hit for
  real by the user**: the guard above only ever covered the non-`custom`
  branches (`elif chat_changed`/`elif vision_changed`/
  `elif embedding_changed`) — the `if req.xxx_provider == "custom":`
  branches had NO such guard at all, so with chat/vision/embedding all
  configured as `custom` (a real local setup: one llama.cpp endpoint for
  chat+vision, a second, separate one for embedding), saving settings
  ALWAYS re-probed every configured custom endpoint on every single save,
  regardless of whether that capability was the thing actually being
  changed. Hit for real: the embedding endpoint was down, and this
  blocked saving an unrelated chat-model fix with a 400 from the
  embedding probe — the exact opposite of "every capability but chat is
  independently optional" this app's providers are supposed to embody.
  Fixed by extending the same changed-guard to the custom branches too
  (`needs_custom_chatvision`/`needs_custom_embedding` now require
  `chat_changed`/`vision_changed`/`embedding_changed` — or a new
  `custom_endpoint_changed`/`embedding_endpoint_changed`, added the same
  round to catch a URL-only change re-picking the identical model name,
  which the provider+model comparison alone would've missed) — an
  unchanged `custom` pick is now trusted as-is, same as the non-custom
  branches already did. Verified live against the real, partially-broken
  setup this was found in: re-submitting the exact current settings
  succeeded (200) while the embedding endpoint stayed genuinely
  unreachable; deliberately changing `embedding_model` to a bogus value
  under the same broken endpoint still correctly 400'd — the strictness
  is preserved for an actual change, only unrelated saves stopped being
  blocked.
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

- **`MAX_HISTORY_MESSAGES` caps what actually reaches the LLM to the last
  20 history messages** (2026-08-20, a real gap the user asked about
  directly — confirmed via a full read of the actual path from
  `frontend/src/lib/chat.ts`'s `sendChatMessage` through to the provider
  call, not assumed) — before this, the client sent its **entire**
  in-memory conversation every turn (`chat-panel.tsx`'s `messages` state
  has no cap of its own) and `chat()` forwarded all of it verbatim to up
  to three LLM calls a turn (order extraction, lead extraction, the main
  reply — see the concurrency bullet below), so a long-running
  conversation resent its whole history, every turn, with no bound —
  real unbounded latency/cost growth, not a theoretical concern.
  `chat()` now builds one truncated `history = req.history[-MAX_HISTORY_
  MESSAGES:]` local right at the top and every downstream use (order
  extraction, lead extraction, `messages` for the main reply) reads that,
  never `req.history` directly. Deliberately just a recent-window cap,
  not summarization/compaction — coarser than this app needs to build
  today, and a real, accepted tradeoff: something said further back than
  the window genuinely stops being visible to the model, not just to a
  human scrolling. Scoped to what's sent to the LLM only — `ChatMessage`
  DB persistence (used for market-research review) and the client's own
  `messages` state (so a visitor can still scroll their full
  conversation) are both completely unaffected, unbounded exactly as
  before. Verified live: a request carrying 30 history messages still
  replied correctly with no error/timeout.
- **Lead capture**: this MVP has no separate contact form, so a visitor
  can book an appointment / request a quote / file a claim entirely
  inside the chat. `_lead_extraction_call` runs one fixed-shape
  classification call (is this a real lead? which category? what email?
  name? phone?) — kicked off concurrently with order extraction
  (2026-08-20, see "Product catalog + ordering" below), its result applied via
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
  - **A configured schema is a stronger business-scope signal than RAG
    silence — `_available_request_types_block`** (2026-08-20). Real
    scenario the user hit manually: RAG documents describing a
    real-estate business, but `insurance_application`/`insurance_claim`
    schemas also configured (from earlier testing) — the main reply
    said "insurance isn't our business" even though a schema existed
    specifically to collect it, because the reply's own context had
    zero awareness of which schemas exist (only an *already-in-progress*
    entry got surfaced, via `_in_progress_context_block`, which only
    fires from turn 2+ of a request already underway). Fixed by adding
    `_available_request_types_block(schemas)` — folded into the main
    reply's context **unconditionally** whenever any schema exists, not
    just an in-progress one — listing every configured request type
    regardless of what the knowledge-base documents do or don't
    mention. `SYSTEM_PROMPT`'s scope-honesty instruction (below) treats
    a match against this block as authoritative: an owner doesn't add a
    schema by accident, so its existence outranks RAG being silent on
    the topic. Verified live, both through direct calls and the real
    `/api/chat` endpoint: the exact scenario above now replies "Yes, we
    can help with a car insurance quote..." instead of hedging, and
    still correctly captures the `CrmEntry` against
    `insurance_application`.
  - **`SYSTEM_PROMPT` scope-honesty instruction** (2026-08-20, added
    same session, revised same day after the finding above) — only
    claim the business offers something if backed by RAG excerpts OR
    the `_available_request_types_block` above; otherwise say honestly
    "not sure, a team member can confirm" instead of assuming yes to be
    agreeable. Scoped narrowly enough to leave the existing "answer
    general questions directly, don't deflect" rule (math/trivia)
    untouched — verified as a separate live regression test
    (`backend/tests/test_intent_schema_scope.py`).
  - **`wants_human` — a human-handoff stub** (`CrmEntry.wants_human`,
    2026-08-20, migration `65235cfb36c2`) — set by the same extraction
    call when a visitor explicitly asks to speak with a person rather
    than continue with the chatbot, independent of whether `is_lead`/
    `schema_key` match anything. Deliberately just a flag for now — no
    live-transfer/notification infrastructure exists, this is "build the
    interface, fill it in completely later" per the user's own framing.
    Surfaced as a small destructive-variant "Wants human" badge in both
    `CrmPanel` and `ReviewQueuePanel`.
  - **`IntentSchemaPanel` UX** (2026-08-20) — `key` is no longer a field
    the owner types: it's auto-derived from `label` via a new
    `slugifyKey()` (`lib/slug.ts`, `snake_case` — matches this schema's
    own `_key` convention, unlike page-slug `slugify()`'s hyphenated
    form) live as they type, locked (shown read-only) once the schema
    actually exists so a later label edit can never silently change a
    key something else references (e.g. owner-agent's
    `manage_review_queue` looks schemas up by key). The Label field also
    gained a hint that its wording now directly feeds the AI's
    business-scope reasoning (see `_available_request_types_block`
    above) — a real UX gap the user caught: this field carries a lot
    more weight than "just an internal label" now.
  - **Real bug caught and fixed while wiring the above**:
    `_apply_lead_capture` referenced a `message` variable that was never
    one of its own parameters — a leftover from before this function was
    split out of the combined `_maybe_capture_lead` (see the "Order
    extraction and lead extraction now run concurrently" note above).
    Latent, not yet hit in production: it only would have raised
    (uncaught — `NameError` isn't one of the exceptions this function
    swallows) on a turn where the model's JSON omitted `"summary"`.
    Fixed by making `message` a real parameter, threaded through from
    `chat()`'s own call site — now covered by a regression test
    (`test_apply_lead_capture_uses_message_fallback_for_summary`).
  - **Cross-session continuity is a known, deliberately deferred gap**
    (elaborated 2026-08-20, off a real user test) — "same-session dedup"
    above means the moment a visitor's `session_id` is gone (an
    incognito window fully closed, a different device, cleared
    `localStorage`), an in-progress multi-turn collection (e.g. a
    partially-filled insurance claim) becomes unreachable: the old
    `CrmEntry` still exists with whatever was collected, but nothing
    links a NEW session back to it, so the visitor appears brand new
    and the chatbot starts over. **True even for a visitor with a real
    logged-in account** — `_find_active_entry` keys strictly on
    `chat_session_id`, never `contact_email`, so being signed in doesn't
    currently help either. Considered and explicitly deferred, not
    forgotten:
    - **Ruled out**: forcing account registration before filing a claim
      (defeats this app's own "no separate contact form, handle it in
      chat" low-friction premise — confirmed against how ChatGPT/
      Gemini/Claude themselves handle this: all three *do* require a
      real logged-in account for any cross-session memory, explicitly
      giving up on unauthenticated continuity rather than faking it via
      cookies/IP — but that tradeoff fits a dedicated AI-product signup
      flow, not a first-touch embedded widget where forcing a signup
      wall is the friction this app is specifically designed to avoid).
      Also ruled out: IP- or device-fingerprint-based identity (IP is
      shared/rotates over days, fingerprinting is heavier and its own
      privacy liability).
    - **Planned direction, not yet built**: the visitor already gives a
      `contact_email` for any claim/application regardless (it's a
      required field) — the fix is to also look up a recent in-progress
      `CrmEntry` by `contact_email` when the current session has no
      active one, so a returning visitor who re-states their email picks
      up where they left off with zero registration. Needs a lightweight
      verification step (a one-time code emailed to that address) before
      actually resuming — matching the "progressive, passwordless
      identity" pattern increasingly standard for AI-native products —
      otherwise anyone who merely *knows* a visitor's email could read
      or continue their claim (real PII: incident details, photos,
      contact phone). **Blocked on this MVP having no real email-sending
      capability at all yet** — nothing to actually deliver a code
      through, so this can't even be tested end-to-end until that exists.
    - **A second open question surfaced alongside this**: how long
      should an abandoned in-progress `CrmEntry` (and its `ChatSession`)
      actually be kept once continuity is real? Retaining every
      never-finished, PII-carrying partial submission indefinitely is
      both an unbounded-growth problem and a real attack-surface/privacy
      concern (more stale partial records sitting around is more to
      protect, more to leak, more for a future OTP-guess/enumeration
      attempt to target) — some bounded retention/expiry policy for
      abandoned entries needs to be part of this feature's actual design,
      not an afterthought once it's built (mirrors
      `chat_attachments.cleanup_orphaned_uploads`'s existing
      "abandoned + older than N hours gets cleaned up" precedent, but
      that one only ever deletes unreferenced *files*, never a `CrmEntry`
      row itself — this would be new).
  - Deliberately out of scope for this round (a real user scoping
    decision, not an oversight): a **recommendation** feature ("suggest
    the right policy/dish/product from embedded documents" — layers on
    top of already-working RAG retrieval + chat, doesn't block proving
    the collection mechanism); other verticals beyond the insurance
    validation above. ~~URL-based auto-embed~~ — built 2026-08-21, see
    "URL-based document ingestion + scheduled tasks" below. Schema
    *creation* stays dashboard-form-
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
- **`Product.tags: list[str]` (2026-08-20) replaced the original single
  `Product.category: str | None` column** — a real architecture change
  the user proposed directly, not a rename. Two problems drove it: (1) a
  single free-text category can't hold more than one classification (a
  product that's both "Coffee" and, say, a seasonal-menu tag needed two
  values, not one), and (2) it's what actually fixes cross-lingual
  search. `search_products`'s `ILIKE` matching has zero semantic
  understanding across languages the way RAG's embeddings do — a visitor
  asking "咖啡" against a product only tagged `"Coffee"` matched nothing,
  even after the category itself was correctly set (found live, from a
  real screenshot: an English "coffee" fix alone left the actual
  Chinese-language report unfixed). Tagging a product
  `["Coffee", "咖啡"]` closes this without any translation logic — the
  word just needs to appear *somewhere* in the tag list's text form.
  `cart.search_products`/`apis/products.py`'s `list_public_products` now
  match against `cast(Product.tags, Text).ilike(...)` (JSONB cast to
  text, not a real per-element query — deliberately the simplest thing
  that works at this app's scale, same posture as `search_products`
  itself). The migration (`d9feed93def7_replace_product_category_with_
  tags.py`) is data-preserving, not a plain drop: an existing
  `category` value is carried over as a one-element `tags` array before
  the column is dropped. `GET /api/products` took a `?tags=` query param
  (comma-separated, OR-matched) in place of the old `?category=`.
  `ProductPanel`/`OwnerAgentPanel`'s `propose_products` review card, and
  `ProductListBlock`'s CTE filter (`lib/theme.ts`'s `tags?: string[] |
  null`, still mutually exclusive with the more specific `product_ids`
  allow-list) all took a comma-separated tags input in place of the old
  single category field. Verified end-to-end: after tagging the 3 real
  coffee products `["Coffee", "咖啡"]`, a live `POST /api/chat` call with
  `"你们店有没有咖啡"` correctly returned all 3 as `products` (Swiper on
  the frontend) with no misleading citations — the exact case that
  started this investigation.
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
- **`OrderItem.comment`/`served` (2026-08-20) — a dine-in kitchen-ticket
  workflow bolted onto the existing line-item table, deliberately not a
  new table**, per the user's own explicit call: two more columns on the
  row that already exists (a line item) is enough at this app's scale.
  `comment` is a free-text per-line customization ("less sugar", "extra
  spicy") — same "just store what was typed, don't parse it" posture as
  `Order.pickup_time`. `served` is a plain boolean, mirroring `is_open`'s
  own "one hard signal, not inferred from free text" reasoning — staff
  toggle it in `OrderPanel` (`PATCH /agent/order-items/{id}`); unlike
  `status`, **owner-agent has no tool to set it** — this is a live
  kitchen-floor action, not a cheap-to-adjust config value.
  - **`cart.apply_order_delta` now matches an existing line to merge
    into by `(product_id, comment)`, not `product_id` alone** — two
    lattes with different customizations are two distinct line items,
    never silently merged into `quantity=2`; a blank/`None` comment
    still merges with any other blank-comment line for the same
    product, so this is a no-op change for every pre-existing caller
    that never passes a comment. Verified: adding the same product
    twice with the same comment merges to `quantity=2`; the same
    product with two different comments stays two separate rows.
  - **`POST /api/cart/update` now targets `item_id`, not `product_id`**
    (a real, deliberate breaking change to that route) — once a product
    can have more than one cart line (different comments), `product_id`
    alone can no longer say which line a quantity +/-/Remove click
    meant. `OrderItemSummary`/`CartItem`/`OrderItem` (frontend) all
    already exposed the real line-item `id`, so this only meant
    updating the few call sites (`lib/cart.ts`'s `updateCartItem`,
    `CartPage`), not adding anything new to the wire format.
  - **`POST /api/cart/item/{item_id}/comment`** — lets a visitor
    attach/edit/clear a line's note after it's already in the cart
    (`CartPage`'s `CartLineRow`, saved on blur) — separate from
    `/cart/update` since a comment edit isn't a quantity change.
    `comment: null`/empty clears it.
  - **A `served` line is fully locked from the visitor's own cart — a
    real bug fix (2026-08-20), found by the user right after the
    feature above shipped.** Before this, a visitor could still delete
    or requantify a line the kitchen had already marked served — a
    "free food" hole (remove it from the bill after eating it) and a
    receipt/dispute problem (final total no longer matching what was
    actually served). Fixed server-side (never trust the client), in
    two places: `/cart/update` and `/cart/item/{id}/comment` both 400
    on a served `item_id` (`"This item has already been served and can
    no longer be changed."`); `cart.apply_order_delta`'s merge-matching
    now excludes served lines entirely — a positive delta against a
    served line's product opens a **new**, unserved line instead of
    bumping its quantity (a second round of the same item is a distinct
    kitchen ticket anyway), and a negative delta against only-a-served-
    line correctly no-ops via the existing "nothing to remove" branch.
    `CartLineRow` (frontend) disables quantity +/-, Remove, and the
    comment input once `item.served` — not the actual defense (the
    backend checks above are), just avoids showing a control that would
    fail. Verified live: mark an item served → `/cart/update` and
    `/cart/item/{id}/comment` both 400 → ordering the same product again
    correctly opens a second, unserved line rather than touching the
    served one.
  - **A real error-UX bug was caught the same session, right after this
    shipped**: `CartPage` used one shared `error` state for both "the
    whole cart failed to load" and "one item's action failed" — a served-
    lock 400 (still reachable even with the disabled controls above, via
    a race: staff marks served between page load and a stale click)
    replaced the **entire cart view** with a bare error card, hiding
    every other line the visitor could still act on. Fixed by splitting
    into `loadError` (only set by a genuine `getCart()` failure, still
    replaces the whole view — there's nothing to show without it) and
    `actionErrorByItem: Record<number, string>` (keyed by item id,
    rendered inline under that one `CartLineRow`, mirroring the exact
    pattern `OrderPanel`'s own `fieldErrorByOrder` already used for the
    identical class of problem). A failed action on one line no longer
    affects any other line's visibility or interactivity.
- **Cart/order recovery via `?sid=` (2026-08-20)** — closes a real gap
  the user raised: if a visitor's `localStorage` is cleared or they
  switch devices, `getChatSessionId()`'s id is gone and their
  in-progress order becomes unreachable in the UI (the `Order` row still
  exists, nothing can find it again from the browser). Deliberately a
  **lighter-weight mechanism than the email/OTP plan already on file for
  `CrmEntry` continuity** (see "Cross-session continuity" below) — a lost
  cart is an inconvenience, not the sensitive-PII case that plan was
  built for, so a plain URL param is the right amount of ceremony here,
  not a security mechanism. `lib/chat.ts`'s `restoreChatSessionId(sid)`
  overwrites the stored id outright (no validation that it's a real,
  known session — an unrecognized id just behaves like any fresh one
  `getChatSessionId()` would generate itself). `SessionIdBootstrap`
  (mounted once in the root layout, `components/modules/session-id-
  bootstrap.tsx`) reads `?sid=` from `window.location.search` in a
  `useEffect` — not Next's `useSearchParams()`, which would force every
  route under this root-layout component into dynamic rendering just to
  read a param this app only cares about once, on load (confirmed via a
  real production build: every route's static/dynamic marker was
  unchanged before/after this component was added). Strips the param
  from the URL afterward via `history.replaceState`. Two ways this id
  actually reaches a visitor: (1) `/cart`'s own "Save this cart" button
  copies a `?sid=<id>` link to the clipboard — the ordinary case, a
  visitor bookmarking/texting themselves a way back in; (2) a dine-in
  table's own printed QR code can point directly at
  `https://.../?sid=<id>` — out of this app's own scope to generate (no
  QR-per-table admin feature built), but the mechanism is ready for an
  owner to wire up externally.
- **Short polling on `OrderPanel`, not a websocket (2026-08-20)** — the
  owner's own explicit tradeoff, weighing kitchen-status staleness
  against infra cost: this app runs one uvicorn worker (`rate_limit.py`'s
  own docstring already documents why that matters for in-memory state),
  so a real push channel would need actual broadcast plumbing, not just
  an open socket. A 20s `setInterval`, gated on
  `document.visibilityState === "visible"` (a background/minimized tab
  stops polling entirely, not just this one panel — refetches
  immediately on regaining focus instead of waiting out the interval)
  was judged the better tradeoff for now: `GET /agent/orders` was a
  full, unpaginated list at this app's scale when this shipped (now
  paginated, see below — still cheap regardless), and this keeps idle
  tabs from multiplying that cost for no reason. Scoped to `OrderPanel`
  only (admin-only, typically one open tab per staff member) —
  deliberately NOT added to the public `/cart`/`/checkout` pages, where
  polling would scale with visitor count instead of staff count.
- **Real pagination across every list view that used to fetch
  everything at once (2026-08-20)** — the user's own direct call, off
  real UI pain as the demo data grew: `ProductPanel`, `OrderPanel`,
  `ReviewQueuePanel`, and `/search` all used to render one unbounded
  list. Page-number UI everywhere (Prev/Next + "Page X of Y"), not
  infinite-scroll/"load more" — a real user decision, with one carve-out
  noted for later: `/search` (the one customer-facing, "FE" list among
  these) might get an infinite-loader treatment in a future revisit, the
  three admin dashboards stay page-number either way.
  - **Backend shape**: `GET /agent/products`, `GET /agent/orders`, and
    `GET /agent/crm/entries` all gained `limit`/`offset` and now return
    `{items: [...], total: int}` instead of a bare array — a real
    breaking response-shape change, made directly per this project's own
    established precedent (e.g. `/cart/update`'s `product_id`→`item_id`
    change) rather than versioned/kept backward-compatible. `GET
    /products/search` (public) kept its existing `{products: [...]}` key
    but gained `offset`/`total` additively (no rename needed — nothing
    outside `/search` calls this HTTP endpoint; the chat pipeline calls
    `cart.search_products` in-process, untouched). `cart.search_products`
    gained `offset` and a new sibling `count_search_products` (factored
    out of a shared `_search_condition` helper so the count and the row
    query can never silently disagree on what counts as a match) —
    closes `/search`'s own long-documented "known gap" (a query matching
    more than the old hard `limit` silently dropped the rest with no
    "showing X of N" signal at all).
  - **`GET /agent/orders` also moved its search/status/`is_open`
    filtering server-side** (`q`, `status`, `is_open` query params) — was
    a plain client-side `.filter()` over the whole list added earlier
    the same session; pagination made that silently wrong (a match that
    exists on a page that isn't loaded just looks like "no such order").
    `q` matches order id (cast to text), contact_name/email, pickup_time,
    note, OR any of the order's own item names (a subquery against
    `OrderItem.item_name_snapshot`) — the identical fields the old
    client-side filter checked, just real SQL now. Still deterministic,
    never an LLM, matching this app's own "result filtering is pure
    code" principle (`cart.search_products`'s own docstring). `OrderPanel`
    debounces the search box (300ms) before firing a request, and resets
    to page 1 on any filter change.
  - **`GET /agent/crm/entries` gained an `intent_schema_id` filter** —
    what makes `ReviewQueuePanel` paginate *per queue* rather than one
    shared page: `ReviewQueueCard` (split out of `ReviewQueuePanel` this
    same change) now fetches its own page of just its own schema's
    entries directly, so one queue's page state can never affect
    another's, and a queue with many entries doesn't force-load every
    other queue's entries just to filter them out client-side like
    before.
  - **Defaults tuned for two different callers of the same endpoints,
    not just the paginated UI** — `GET /agent/products`/`GET
    /agent/crm/entries` default to `limit=100` (not the dashboard's own
    page size of 20) specifically because owner-agent's `list_products`/
    `crm_list_entries` tools call these with no arguments at all and
    their own tool descriptions promise "every product"/"every entry" —
    a small default would have silently made those tools miss anything
    past page 1 for duplicate-avoidance checks (`propose_products`)
    without any code change on the owner-agent side to notice. Both tool
    descriptions were updated to name the new `{"items": [...], "total":
    N}` shape and mention `limit` is available if `total` says there's
    more. `GET /agent/orders` has no such "list everything" LLM
    consumer, so its own default (`limit=20`) just matches `OrderPanel`'s
    page size directly.
  - **`CrmPanel` itself got real pagination too, one round later the
    same day, off the user's own explicit follow-up ask** — the
    `limit=200` stopgap above was deliberately temporary, not a final
    call. `list_crm_entries` gained a `category` filter (mirroring
    `intent_schema_id`'s existing role for `ReviewQueuePanel`) —
    `"appointment"|"quote"|"claim"|"inquiry"`, or the special value
    `"other"` (`_KNOWN_CRM_CATEGORIES`, backend/apis/agent.py: anything
    NOT in that set, including a null category, via `Column.
    is_distinct_from`-free `notin_`/`is_(None)` — mirrors the frontend's
    pre-existing "other" bucket definition exactly, not a second,
    divergent notion of what "other" means). `CrmPanel` was restructured
    into `CrmCategoryCard` (one per fixed category, including "Other")
    that each fetch and paginate their OWN page of just that category's
    entries — the exact same "split into an independently-paginated
    per-group card" shape `ReviewQueueCard` already established for
    schemas, just with a fixed 5-category vocabulary instead of
    dynamic ones. Every category card always renders (not hidden when
    empty, matching `ReviewQueueCard`'s own posture) — the one exception
    is the very first load: each card reports its own confirmed `total`
    up to the parent via `onTotalKnown`, and the top-level "No leads yet"
    `EmptyState` replaces all five cards only once every one of them has
    confirmed `total === 0` (avoids a separate counts-only endpoint just
    to decide whether to show 5 empty "nothing here yet" cards or one
    clean empty state). A manual push bumps a shared `refreshToken` that
    every card's fetch effect depends on, so all five re-check their
    current page after a push — the new entry only actually becomes
    visible on whichever category happens to be showing page 1 already,
    the same accepted tradeoff `ProductPanel`'s "new row sorts first"
    fix makes elsewhere rather than force-resetting every card's page on
    every push. Verified live: non-overlapping pages for a real category
    with >5 entries (`category=other`, `total=15`), `tsc`/`eslint` clean,
    a real production build clean.
  - **New shared `components/common/pagination.tsx`** — Prev/Next +
    "Page X of Y" `<Button>`-based control. Renders nothing when
    `total <= pageSize` (nothing to paginate). Reused by every paginated
    admin list below — see `frontend/AGENTS.md`'s own `Pagination` row
    for the full, current list of consumers rather than duplicating one
    here that would just drift out of sync again as more lists adopt it.
    `/search` does NOT reuse this component — it's a Server Component
    with no client state, so its own pagination is plain `Link`s to
    `?q=...&page=N` instead (a disabled Prev/Next boundary is a real,
    separate `<Button>` with no `render` prop, not a `disabled`-flagged
    `Link`-rendered one — base-ui doesn't reliably block navigation via a
    `disabled` prop on a non-native-button `render` target, see
    `frontend/AGENTS.md`'s base-ui gotchas).
  - **Deleting the last item on a non-first `ProductPanel` page steps
    back a page** rather than leaving the view stranded on a now-empty
    page; saving a *new* product jumps back to page 1 so the visitor
    actually sees it (products sort most-recent-first, so a new one
    always lands on page 1, invisible from wherever the create form was
    opened otherwise).
  - Verified end-to-end via direct API calls for all three paginated
    admin endpoints (non-overlapping pages, correct `total`, `q`/
    `status`/`is_open`/`intent_schema_id` filters all narrowing results
    correctly) and a live `/search?q=coffee` render (`tsc`/`eslint`/a
    real production build all clean; a stale `.next` dev-cache serving
    pre-edit text was hit and cleared via `docker compose restart
    frontend` mid-verification — see the root AGENTS.md's own
    `.next`-cache gotcha).
  - **Round 2, same day, off the user's own follow-up ask ("what else
    still needs this? I can't remember everything") — a forked research
    pass audited every other admin list view for the same "fetches
    everything, grows with real usage" pattern, then all four real
    candidates it found got the identical treatment**: `GET
    /agent/documents` (`DocumentManager`), `GET /agent/media`
    (`ImageFieldEditor`'s Library tab), `GET /agent/pages/{slug}/versions`
    (`PageManager`'s per-page `VersionHistory`), and `GET
    /agent/owner-agent/runs` (`OwnerAgentPanel`'s "Recent runs" — was a
    hard `limit=50` cap with no `offset`/`total` at all, not real
    pagination; older runs were simply unreachable past 50). Explicitly
    ruled out as NOT real candidates (small, owner-configured, doesn't
    grow with usage): `GET /agent/pages` (the list of page slugs, not a
    slug's own version history) — **reversed 2026-09-10**, see below,
    `GET /agent/intent-schemas`, `GET /agent/intent-views`, product
    bundle/upsell relations, `ProductFieldDefinition`.
    - **`GET /agent/media` has no database row to paginate at the SQL
      level** — it scans two directories (`COMFYUI_OUTPUT_DIR`,
      `MEDIA_UPLOAD_DIR`), merges, sorts by mtime, then the new
      `limit`/`offset` just slices the resulting Python list. Fine at
      this app's scale; a directory large enough for that to matter
      would need a real index, not a bigger page size.
    - **`GET /agent/documents` gained a `needs_reembed_count` field
      alongside `items`/`total`** — `DocumentManager`'s "needs re-embed"
      banner needs the TRUE count across every document, not just
      whatever's on the current page (computed server-side via
      `Column.is_distinct_from()`, NULL-safe, against the currently
      resolved embedding provider/model — same comparison
      `DocumentSummary.needs_reembed` already does per-row, just
      aggregated). Without this, the banner would silently undercount or
      wrongly hide itself once a stale document landed on a page the
      owner wasn't currently viewing — the exact class of bug already
      fixed for `OrderPanel`'s search/filter earlier the same day.
    - **`GET /agent/pages/{slug}/versions` now queries `PageVersion`
      directly** (`limit`/`offset` at the SQL level) instead of reading
      the already-loaded `Page.versions` ORM relationship, which has no
      pagination hook of its own. `GeoPagePanel`'s own unrelated caller
      (wants only the single newest version, for a "last updated"
      display) was simplified to `listPageVersions(slug, 1, 0)` rather
      than fetching a whole page just to read its first item.
    - **`PageManager`'s "Current" badge/non-restorable state is now
      `page === 1 && index === 0`, not just `index === 0`** — a real
      correctness fix forced by pagination: on page 2+, `index === 0` is
      just the newest item *on that page*, never the actual current
      version, so the old check would have wrongly labeled it "Current"
      and hidden its Restore button.
    - Verified live via direct API calls for all four (non-overlapping
      pages, correct `total`, `needs_reembed_count` correct); `tsc`/
      `eslint` clean across the whole `src/` tree, a real production
      build clean, `docker compose restart frontend` used again to clear
      a stale dev-cache render mid-verification.
  - **`GET /agent/pages`'s own "not a real candidate" call reversed,
    2026-09-10** — off a direct user ask, looking at the CTE editor's
    page-slug picker: "otherwise it'll be hard to manage as pages grow."
    `list_pages` (`apis/pages.py`) gained `q`/`limit`/`offset`, returning
    `{items, total}` like every other paginated list here — `q` matches a
    slug substring via `ILIKE`, same posture as `cart.search_products`.
    Every consumer of the old unpaginated `listPages()` was updated
    together, since the response shape itself changed: `PageManager`
    (frontend/AGENTS.md) gained a real search box + `Pagination`
    (20/page, same debounce-and-reset-page-together pattern as
    `ChatSessionViewerPanel`); `CteEditorPanel`'s slug `Input` lost its
    `<datalist>` autocomplete (a plain browser dropdown that stopped
    being usable once a site had more than a handful of pages) in favor
    of a real "Browse saved pages" list below it — searchable, paginated
    8/page, each row clickable to load that slug directly; and
    `PageGeneratorPanel`'s `SavePageForm` (which only ever wanted a
    generous batch of slugs to feed its own save-target datalist, not a
    management UI) switched to `listPages({limit: 100}).items`. Verified
    live against the real dev DB: `GET /agent/pages?limit=3` and `?q=home`
    both returned correctly paginated/filtered results; `pytest`/`tsc`/
    `eslint`/a real production build all clean.
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
  split): `GET /api/products` (catalog, optional `?tags=` — comma-
  separated, OR-matched, replaced `?category=` 2026-08-20, see below),
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
  not just a whole tag, (3) an owner-composed block (arbitrary
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
    over `tags` when both are set (the two aren't meant to be
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

### Payment gate (`backend/payments.py`, `backend/apis/payments.py`)

Added 2026-08-20, on the user's own explicit ask: "接一个pay gate接口，可以接
stripe等api key，但是现在还是用测试跳过payment process" — a real, swappable
payment provider abstraction, same "swappable, not hardcoded" pattern
already applied to every AI capability (`backend/providers/`), extended
to a genuinely new capability domain: actually taking money for an
`Order`. Deliberately a separate top-level module from `providers/` —
that package is specifically AI providers, and payment isn't one.

- **Two providers**: `TestPaymentProvider` (the default, `payment_provider`
  null/`"test"`) — no real charge, immediately reports the order paid, so
  `/checkout` works with zero configuration out of the box, same "give
  the owner choices, don't force config before anything works" default
  every AI provider already has. `StripePaymentProvider` — a real Stripe
  Checkout Session, using Stripe's own official Python SDK (not
  hand-rolled HTTP calls, unlike this project's other vendor
  integrations) specifically because webhook signature verification is
  security-critical: `stripe.Webhook.construct_event` is a vetted HMAC
  check, not something worth reimplementing by hand for a
  payment-forgery-adjacent code path. Checkout is still Stripe-*hosted*
  underneath — card data never touches this app's own server at all,
  sidestepping PCI scope entirely — but as of **2026-09-10, in EMBEDDED
  mode, not a full-page redirect**, on the user's own direct ask to
  "complete the payment steps... popup" instead of navigating the
  visitor's whole browser away to Stripe's own site: `ui_mode="embedded"`
  returns a `client_secret` (not a `url`), and the frontend mounts
  Stripe's own `<EmbeddedCheckout>` iframe inside a real modal
  (`StripeCheckoutDialog`, `components/ui/dialog.tsx` — a new, centered
  Dialog primitive, `sheet.tsx`'s side-panel shape wasn't the right fit
  for a payment popup) rather than leaving this site.
- **Payment confirmation is always asynchronous, never trusted from the
  return trip itself** — `create_checkout()` either reports `already_paid`
  synchronously (test provider only) or hands back a `client_secret`;
  either way, the actual "mark this order paid" write only ever happens
  in `checkout_cart` itself (test) or `POST /webhooks/stripe` (Stripe,
  verified event). Once the visitor finishes paying inside the embedded
  modal, Stripe itself navigates the top-level page to a single
  `return_url` (embedded mode has no separate success/cancel URLs the
  way hosted mode did) — **`/checkout/complete`** (new route,
  `CheckoutCompletePage`) is a friendly landing message only, never proof
  of payment: it calls the new public `GET /api/checkout/session-status`
  (a best-effort READ of Stripe's own record, `retrieve_checkout_session_
  status`) purely for its own display copy, and says so in its own doc
  comment — a visitor can close the tab right after paying, before this
  page even loads, and the order must still end up marked paid from the
  webhook alone.
- **`Order.payment_status`/`payment_provider`/`payment_reference` are
  deliberately separate columns from `Order.status`**, not values
  reused from that existing free-text field — `status` is a label
  owner-agent (via `set_order_status_options`) or the owner can set to
  literally anything, so it can never be a trustworthy signal for "did a
  real payment actually succeed." `payment_status` is never
  owner-agent-writable; only `checkout_cart` (test provider) and the
  verified Stripe webhook ever set it. `payment_reference` holds
  Stripe's own Checkout Session id — what the webhook matches an
  incoming event back to the right `Order` by (via
  `client_reference_id`, set at session-creation time), never anything
  the browser itself supplies.
- **`AppSettings` gained the same write-only-secret pattern
  `custom_api_key` already has** — `stripe_secret_key`/
  `stripe_webhook_secret` are never echoed back by `GET
  /agent/payment-settings`, only a `*_set` boolean says whether one is
  saved; `PUT` with the field omitted leaves the previously-saved value
  alone (there is currently no way to explicitly clear a saved key back
  to null through this endpoint, the same limitation `custom_api_key`
  already has — a deliberate, pre-existing tradeoff, not a new gap).
  `stripe_publishable_key` is the one exception, safe to echo back —
  Stripe's own publishable key is meant to be public. **2026-09-10: this
  key is now genuinely REQUIRED for checkout to work at all**, not just
  "surfaced for reference" as originally noted here — embedded Checkout
  needs it client-side (`loadStripe(publishableKey)`), fetched via a new
  public, no-auth **`GET /api/payment-config`** (`{provider,
  publishable_key}` — a public checkout page has no admin JWT to call
  the `/agent/payment-settings` endpoint with). `PaymentSettingsPanel`'s
  own copy was updated to say so plainly.
- **`FRONTEND_PUBLIC_URL`** (env var, `docker-compose.yml`, same
  `${HOST}:${FRONTEND_PORT}` composition as every other public-URL env
  var) — what `checkout_cart` builds Stripe's single `return_url` from
  (`/checkout/complete?order_id=...&session_id={CHECKOUT_SESSION_ID}` —
  that last part is a literal template Stripe itself substitutes, not an
  f-string placeholder); this backend never renders that page itself, it
  just needs to tell Stripe where to send the visitor's browser once
  they finish inside the embedded modal.
- **`PaymentSettingsPanel`** (frontend, in the "Products & orders"
  accordion group alongside `ProductPanel`/`OrderPanel`) — provider
  picker + Stripe key inputs, mirrors `ModelSettingsPanel`'s
  `CustomEndpointBlock` UX (password-type inputs, a "Saved" badge, a
  placeholder telling the owner blank means "keep the saved key"). Also
  surfaces the exact webhook URL to paste into Stripe's own dashboard.
  `OrderPanel`'s summary row gained a `payment_status` `Badge`
  (paid/unpaid/failed) next to the total, visible without expanding.
- **Verified end-to-end against the real running stack, including
  genuine live rejections from Stripe's actual production API** (no real
  Stripe account was available either session — confirmed directly with
  the user before building the embedded-Checkout redesign, who chose to
  have the code written correctly now and configure/test real keys
  themselves later): default test-mode checkout still closes the order
  as `paid`/`test` with zero configuration, `client_secret: null`;
  switching to `stripe` with no secret key set correctly 503s; the
  write-only secret-key round-trip (set → never echoed → updating an
  unrelated field leaves it intact); a forged webhook request with a bad
  signature is correctly rejected with a real HMAC verification failure
  (`stripe.error.SignatureVerificationError`), not just a header-presence
  check. **2026-09-10, against a real (fake-credentialed) Stripe API
  call**, not just this app's own side of the boundary: `POST
  /cart/checkout` with a fake `sk_test_...` key genuinely reached
  Stripe's real `checkout.Session.create` endpoint in embedded mode and
  got a real "Invalid API Key provided" rejection back (proving the
  `ui_mode="embedded"`/`return_url` request shape is well-formed — Stripe
  validated the request structurally before ever checking the key),
  correctly surfaced as a clean 503; `GET /api/checkout/session-status`
  with a bogus session id similarly reached Stripe's real
  `checkout.Session.retrieve` and got a genuine rejection, correctly
  surfaced as a 502. `backend/tests/test_payments.py` (2 new tests) locks
  in a real, new gap this redesign could have reopened: a stale
  `stripe_publishable_key` left over from a previous Stripe
  configuration must never leak out of the now-public `GET
  /api/payment-config` while `payment_provider` is back on `"test"`.
  `tsc`/`eslint`/`pytest` (21 fast tests)/a real production build (with
  the new `@stripe/stripe-js`/`@stripe/react-stripe-js` dependencies
  actually baked into a rebuilt image, not just live-installed) all
  clean. Test orders/sessions/settings cleaned up after. **Not
  independently verified this round**: an actual successful embedded-
  Checkout payment completing inside the modal and a real webhook firing
  — needs the real Stripe test-mode keys only the user can obtain.

### Email + SMS gate (`backend/notifications.py`, `backend/apis/notifications.py`)

Added 2026-08-20, same session as the payment gate above, on the user's
own direct follow-up: "现在把email接口和手机接口也做一下，这样就可以用mailgun等
第三方服务商了" — the identical "swappable, not hardcoded" pattern extended
to a third capability domain: sending a real message to a real inbox/
phone. Deliberately its own module, not folded into `payments.py` —
messaging and payment are different concerns that happen to share a
design pattern, not the same concern.

- **Two independent provider families, same "test is the default" shape
  as payment**: `EmailProvider` (`TestEmailProvider`, a pure no-op /
  `MailgunEmailProvider`, real Mailgun HTTP API) and `SMSProvider`
  (`TestSMSProvider` / `TwilioSMSProvider`, real Twilio HTTP API). Both
  real providers use plain `httpx` calls, not either vendor's official
  SDK — unlike Stripe, where the SDK's webhook-signature verification
  was worth the dependency for its security properties, there's no
  equivalent inbound-webhook-trust concern here (this module only ever
  sends, never receives and verifies anything from these vendors).
- **This module builds the send capability, it does NOT decide when to
  send anything** — no caller wires it into a business trigger (an
  order-confirmation email, a lead-notification text, ...); that's a
  separate, later decision about what to send, to whom, and with what
  copy, deliberately out of scope for this round. The only current
  callers are `apis/notifications.py`'s test-send endpoints — an owner
  configures a provider and proves the credentials actually work before
  anything real depends on it.
- **`AppSettings` gained the same write-only-secret pattern as
  `stripe_secret_key`** — `mailgun_api_key`/`twilio_auth_token` are
  never echoed back by `GET /agent/notification-settings`, only
  `mailgun_api_key_set`/`twilio_auth_token_set` booleans; `PUT` with the
  field omitted leaves the previously-saved value alone. Every other
  field (`mailgun_domain`/`mailgun_from_address`/`twilio_account_sid`/
  `twilio_from_number`) isn't a secret — a Twilio Account SID is a
  public identifier, the same way a Stripe publishable key is — so
  those echo back normally.
- **`NotificationSettingsPanel`** (frontend, same "Products & orders"
  accordion group as `PaymentSettingsPanel` — third-party service
  credentials living together for now, revisit if a dedicated
  "Integrations" group becomes warranted later) — two sections (Email,
  SMS), each a provider `Select` + that provider's config fields +
  a "Send test email"/"Send test SMS" button with its own target-address
  input. The test-send result names which provider actually handled the
  call (`"test"` vs `"mailgun"`/`"twilio"`) so a no-op is never mistaken
  for a real delivery.
- **Verified end-to-end against the real vendor APIs, not just this
  app's own side**: default test-mode send returns `{"provider": "test"}`
  with zero configuration; selecting `mailgun`/`twilio` with no
  credentials set correctly 503s with a clear message; the write-only
  secret round-trip (set → never echoed → updating an unrelated field
  leaves it intact); and — genuinely hitting Mailgun's and Twilio's real
  production endpoints with fake credentials — both correctly rejected
  the request (Mailgun: 403 Forbidden; Twilio: error 20003,
  "Authentication Error - invalid username"), and this app's own code
  correctly turned that into a clean 503 rather than crashing or
  claiming success. No real (non-fake) Mailgun/Twilio account was
  available this session, so an actual successful delivery was not
  exercised — only that a real, reachable vendor API correctly rejects
  bad credentials and this app handles that rejection gracefully.

### Map embed gate (`backend/maps.py`, `backend/apis/maps.py`)

Added 2026-08-21, on the user's own direct ask ("map component") — the
same "swappable, not hardcoded" pattern extended to a fourth capability
domain: showing a business location. The design question going in was
whether a real embedded map was worth building at all versus just a
plain "redirect to Google Maps" link (the user's own starting question);
resolved by observing that a genuinely useful Image+Link combo would
need a real static-map image anyway, which requires the same class of
API integration a live embed does — so the embed was judged worth
building, with the redirect link kept as an **unconditional** floor
regardless of configuration, not a fallback that goes away once a
provider is set.

- **`MapProvider` is narrower than payment/notification's provider
  matrix on purpose** — there's no "does nothing" action to skip the way
  `TestPaymentProvider`/`TestEmailProvider` skip a charge/send; a map
  provider only ever builds a URL string, nothing to no-op. `TestMapProvider`
  (default) returns no embed at all; `GoogleMapsProvider` is the only real
  implementation — Google's Maps Embed API needs nothing but a key and a
  place/address query string (no client-side JS SDK, no tile-styling
  config), unlike a genuine multi-vendor map matrix (Mapbox, OpenStreetMap)
  that would need real per-vendor embed mechanics. A second real provider
  can be added the same way `providers/custom.py` was added for chat, once
  there's an actual second need — not preemptively.
- **The redirect-only floor is unconditional, not provider-gated** — a
  `MapBlock` always renders a real "Open in Google Maps" link built from
  its own `query` text, regardless of whether any map provider is
  configured at all. This directly answers the user's original framing
  question (map vs. just redirect): the redirect always exists; a real
  Google Maps API key layers a live in-page iframe on top of it, never
  replaces it.
- **The Google Maps Embed API key is kept write-only server-side anyway,
  even though it doesn't strictly need to be** — Google's own Embed API
  key is *designed* to sit in a browser-loaded iframe `src` (restricted
  via Google Cloud Console's own HTTP-referrer allowlist, not treated as
  a bearer-style secret the way a Stripe secret key or Mailgun API key
  is). Still, `GET /agent/map-settings` never echoes the raw key back
  (only `google_maps_api_key_set`), and the frontend never receives it at
  all — `GET /api/map-embed?query=...` (public, no-auth, mirrors `GET
  /api/product-fields`'s public-but-not-sensitive posture) resolves the
  provider server-side and returns the already-assembled `embed_url`, so
  the key never has to round-trip through this app's own frontend code or
  React state, even though the vendor itself would tolerate it.
- **`query` lives on the `MapBlock` itself, not baked into a stored embed
  URL** — `GET /api/map-embed` is called at render time, every time, so
  switching the configured map provider/key later (or turning it on for
  the first time) makes every existing `MapBlock` on every saved page
  start showing a live embed with zero page edits needed, the same
  "settings are global and apply retroactively" posture as the AI model
  picker.
- **`MapBlock` (frontend, `components/theme/blocks/map-block.tsx`)** —
  owner-inserted only via CTE (`BlockInsertMenu`, `lib/block-registry.ts`),
  never vision-generated (matches `ProductListBlock`/`ProductCardBlock`'s
  own precedent — a vision model has no way to know a real business
  address from a design mockup; `map` is simply never mentioned in
  `_VISION_SYSTEM_PROMPT`'s section catalog, the same mechanism that
  already excludes those two). Fetches client-side (`useEffect` +
  `getMapEmbed`), same reasoning as `ProductCardBlock` — `BlockRenderer`
  (the recursive dispatcher rendering every Block type) is a Client
  Component, and `query` is owner-authored content only known once the
  block actually renders. Editable via a new `"block-map"` `EditableFieldType`
  (`lib/cte.ts`) — a single plain-text address/place field in
  `CteEditorPopover`, the simplest of the `block-*` fieldTypes so far
  (no style knobs — a map embed has nothing analogous to color/size/
  weight to expose).
- **`MapSettingsPanel`** (frontend, in the "Products & orders" accordion
  group alongside `PaymentSettingsPanel`/`NotificationSettingsPanel` —
  continuing that group's already-acknowledged provisional role as the
  home for third-party service credentials, not because a map is
  products/orders-specific) — provider `Select` (no live embed / Google
  Maps) + the same write-only-secret `Input`/`Badge` UX as the other two
  panels, no test-send equivalent (there's nothing to "send" — the panel
  copy itself explains a `MapBlock` always links out regardless of what's
  configured here).
- **Verified end-to-end**: default test-mode `GET /api/map-embed` returns
  `embed_url: null` plus a working `maps_url` for an arbitrary query
  string with zero configuration; setting `map_provider: "google"` with a
  key correctly returns a `embed_url` with that key and the query
  correctly assembled into the Maps Embed API URL shape; `GET
  /agent/map-settings` never echoes the raw key back before or after
  saving (only the `_set` boolean flips); an invalid `map_provider` value
  correctly 400s; a page version saved with a `MapBlock` section
  round-tripped byte-for-byte through save → public read. `tsc`/full-
  source `eslint`/`pytest`/a real production build all clean — one real
  lint catch during this pass: `MapBlock`'s effect originally called
  `setResult(undefined)` synchronously for the empty-query case, tripping
  `react-hooks/set-state-in-effect` (same class of bug this project has
  hit before, see "Known gotchas"'s pattern) — fixed by just returning
  early with no state reset, since the render path already checks
  `!query.trim()` before ever reading `result`, so a stale value from a
  previous non-empty query is harmless.

### GEO / business profile — structured data, robots.txt, sitemap.xml

Added 2026-08-21, immediately after the map embed gate above, on a real
user report: asking ChatGPT/Gemini something like "I need a plumber"
surfaced a *different* business's name and contact info in the answer —
this app had nothing published anywhere that would let an AI system
answer that kind of question about *this* business at all. The user's
own framing was explicit: "以后所有的AI都可以抓取这个系统的信息并且可以上列表"
(any AI should be able to crawl this system's info and get listed) — not
blog posts or comments (considered and rejected, see below), a real GEO
(Generative Engine Optimization) push. The user does not know this space
well and asked me to design and build the whole thing.

- **Why not blog posts/comments** — the user's first instinct was content
  marketing (posts) or review volume (comments), which I talked through
  and the user agreed wasn't the right lever: posts/comments help
  *traditional* SEO ranking, but the actual reported failure ("AI didn't
  know who we are at all") is a *discoverability/entity-recognition*
  problem — an AI system needs machine-readable facts (name, address,
  phone, hours) to cite accurately, not more prose to summarize. This app
  already had a prose half of this (`generate_geo_page`, see "RAG"
  above); what it never had was structured data or basic crawler
  configuration at all.
- **Three real, concrete pieces, not one**: (1) `backend/apis/
  business_profile.py` — an owner-entered structured "who/where/how to
  reach us" fact base; (2) `frontend/src/app/robots.ts` — explicit
  crawl permission for AI crawlers, not just traditional search; (3)
  `frontend/src/app/sitemap.ts` — makes sure crawlers can actually find
  every public URL. All three exist because a missing business fact base
  meant there was nothing to publish, a missing robots.txt meant crawlers
  had no explicit signal either way, and a missing sitemap meant even a
  permitted crawler had no reliable way to discover `/products/{id}`/
  `/p/{slug}` URLs beyond following on-page links.
- **`AppSettings` gained 14 business-profile columns** (`backend/
  models.py`) — name, description, a free-text schema.org type (e.g.
  "Plumber", "Restaurant" — not a closed enum; schema.org has hundreds of
  subtypes and this app has no reason to maintain its own copy), email,
  phone, a 5-part address, url, logo_url, `business_hours` (JSONB
  `list[str]`, one schema.org openingHours-format string per entry, e.g.
  `"Mo-Fr 09:00-17:00"` — a deliberate v1 scope cut: one owner-typed line
  per range, not a day-by-day time-picker UI, same "simplest thing that
  produces valid structured data" posture as `Order.pickup_time` staying
  free text elsewhere in this app), and `business_social_links` (JSONB
  `list[str]`, schema.org `sameAs` — Google Business Profile/Yelp/
  Facebook URLs that corroborate entity identity, same shape as
  `Product.tags`'s existing JSONB-list-of-strings precedent). No secrets
  here at all — every field is safe to echo back and, in fact, meant to
  be publicly crawlable; `GET /api/business-profile` (public, no-auth)
  is the whole point.
- **Deliberately owner-entered/confirmed, never LLM-written directly** —
  the same "misread real-world fact has real consequences" posture
  already established for Product pricing and IntentSchema definitions:
  a wrong phone number in a JSON-LD block an AI system then repeats to a
  real customer is a worse failure mode than a wrong price, not a
  better one. `POST /agent/business-profile/suggest` mirrors
  `detect_business_type`/`propose_intent_schema`'s existing precedent
  exactly — an LLM drafts values from ingested RAG documents (a
  deliberately conservative prompt: "extract ONLY facts explicitly
  present... do NOT invent, guess, or infer... leave a field null if the
  source text doesn't clearly state it"), returns them as a suggestion,
  and never saves anything itself; the owner reviews the pre-filled
  `BusinessProfilePanel` form and explicitly clicks Save. Verified live
  against this app's own real ingested real-estate document: correctly
  extracted `business_name`/`business_description`/`business_type`
  ("RealEstateAgent") from prose that stated them, and correctly left
  phone/email/address/hours null since the source document never stated
  those — exactly the intended "don't invent" behavior, not just a
  hopeful prompt instruction.
- **`buildLocalBusinessJsonLd` (`frontend/src/lib/business-profile.ts`)**
  — pure formatting (profile → schema.org `LocalBusiness` object), no
  network I/O, shared by `BusinessProfileJsonLd`. Returns `null` (renders
  nothing at all, not even an empty script tag) when there's no
  `business_name` set — an empty "LocalBusiness" entity with no name
  would be worse than publishing nothing. Every optional field (email,
  phone, address, logo, hours, sameAs) is individually omitted from the
  JSON-LD object when unset, rather than emitted as `null`/empty — a
  smaller, honest JSON-LD block over a padded one with empty fields.
- **`SiteJsonLd` (`components/layout/site-json-ld.tsx`, renamed from
  `BusinessProfileJsonLd` the same day it shipped, once its scope
  broadened)** — a Server Component mounted once in the root layout,
  fetches the public profile and renders one JSON-LD `<script>` tag on
  every page site-wide (a business's identity isn't page-specific).
  Fetch failures are swallowed — a business-profile outage must never
  take down page rendering.
  - **`buildSiteJsonLd` (`lib/business-profile.ts`) always includes a
    `WebSite` node, never gated on a business profile existing** — a
    `WebSite` entry (site identity + a `potentialAction: SearchAction`
    pointing at this app's real `/search?q=` route) is what Google's own
    structured-data guidelines use to decide whether to offer a
    sitelinks search box, and it has real value from day one, before any
    GEO setup is finished. Once a business profile exists,
    `buildLocalBusinessJsonLd`'s output is folded into the SAME `@graph`
    alongside the `WebSite` node (one `<script>` tag, one top-level
    `@context` — each `@graph` entry's own `@context` is stripped before
    nesting, matching Google's own JSON-LD examples, which never repeat
    `@context` per graph node), linked via `WebSite.publisher` →
    `LocalBusiness`'s `@id` — the standard schema.org pattern for saying
    "this website is published by this organization." Verified live:
    zero-config renders a `WebSite`-only graph with a working
    `SearchAction`; a configured profile renders both nodes correctly
    linked, with `@context` appearing exactly once.
- **Root layout's `metadata` became `generateMetadata()`** (was a static
  `export const metadata`) — once a business profile is configured, the
  site's own `<title>`/meta description reflect the actual configured
  business instead of this app's own generic placeholder copy ("AI
  MVP..."), a real, honest fix beyond just JSON-LD: the previous
  hardcoded copy was visibly wrong for any real deployment of this app.
  Falls back to the original static text with zero configuration.
  **Real, deliberate build-output tradeoff found during verification**:
  since `generateMetadata` now does a live per-request fetch, every route
  under the root layout changed from statically prerendered (`○`) to
  dynamic/server-rendered-on-demand (`ƒ`) in the production build output
  — including previously-static routes like `/login`/`/dashboard` that
  have no data dependency of their own. Accepted, not treated as a
  regression: this app already runs every service server-side per
  request in Docker (no static export/CDN deployment target exists), the
  fetch itself is a cheap local DB read through the backend, and the
  whole point of dynamic metadata is reflecting live-configured business
  data rather than a build-time snapshot.
- **`frontend/src/app/robots.ts`** — explicitly names common AI crawlers
  (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, anthropic-ai,
  Claude-Web, PerplexityBot, Google-Extended, Applebot-Extended, CCBot,
  Bytespider) alongside the bare `*` rule, rather than relying on the `*`
  rule alone to implicitly cover them — a bare `Allow: /` for `*` already
  permits every one of these by default, but naming them makes the
  intent unambiguous to a human reading this file and future-proofs
  against any of these vendors ever defaulting to a stricter posture for
  an unlisted-but-not-explicitly-allowed agent. Disallows `/dashboard`,
  `/editor`, `/login`, `/checkout`, `/cart` — owner-only or per-visitor
  pages with zero SEO/GEO value, so crawl budget goes toward the
  actually-public content instead.
- **`frontend/src/app/sitemap.ts`** — enumerates `/`, `/about`, every
  saved page (`GET /api/pages`, a new public no-auth endpoint added to
  `apis/pages.py` specifically for this — the existing `list_pages` is
  admin-gated), and every available product (`GET /api/products`, no
  args = every available product, already public). `/` and `/about` are
  hardcoded, always present, since those two routes always resolve to
  *something* (a saved page or the hand-authored default template).
  Best-effort per section — a `listPublicPages()`/`listPublicProducts()`
  failure omits that section rather than failing the whole sitemap.
  Verified live: correctly excludes the `"home"`/`"about"` slugs from the
  `/p/{slug}` list (they map to the two hardcoded fixed-route entries
  instead, per `app/page.tsx`/`app/about/page.tsx`'s own slug
  convention) and correctly lists real saved pages/products.
- **`NEXT_PUBLIC_SITE_URL`** (new env var, `docker-compose.yml`'s
  frontend service) — this deployment's own public origin, same
  `${HOST}:${FRONTEND_PORT}` composition as `NEXT_PUBLIC_API_URL` and the
  backend's own `FRONTEND_PUBLIC_URL`; needed for the absolute URLs
  `sitemap.ts`/`robots.ts` require and as `buildLocalBusinessJsonLd`'s
  fallback when no `business_url` is configured (the backend already
  applies the equivalent `FRONTEND_PUBLIC_URL` fallback server-side —
  this is a second, harmless belt-and-suspenders fallback for whatever
  reaches the frontend function).
- **`BusinessProfilePanel`** (frontend, new "SEO & AI discoverability"
  accordion group — a dedicated top-level group, not folded into
  "Content generation" alongside `GeoPagePanel`, given the weight the
  user placed on this being "未来的核心") — a plain form (name/type/
  description/email/phone/address/url/logo via the reused
  `ImageFieldEditor`/hours/social links, the last two as one-line-per-
  entry `Textarea`s) plus the "Suggest from documents" button described
  above. Saves via `PUT /agent/business-profile`, no write-only-secret
  UX needed (nothing here is a credential).
- **Verified end-to-end**: `GET /api/business-profile` (public) round-
  trips a full save correctly; an invalid `business_hours` type (a plain
  string instead of a list) correctly 422s; `POST /agent/business-profile/
  suggest` against a real ingested document correctly extracted only
  explicitly-stated facts and left the rest null; a live page render with
  no profile configured produced zero `<script type="application/ld+json">`
  tags; a live page render with a configured profile produced a correct,
  minimal (unset fields fully omitted, not emitted empty) schema.org
  `LocalBusiness` block AND a `<title>`/meta description reflecting the
  configured name/description; `robots.txt` and `sitemap.xml` both
  render real, correct content in production (`docker compose run --rm
  frontend npm run build` shows both as real routes). `tsc`/full-source
  `eslint`/`pytest`/a real production build all clean.
- **Deliberate v1 scope cuts**: no day-by-day opening-hours UI (one
  owner-typed schema.org-format line per range instead); no automatic
  submission to Google Search Console/Bing Webmaster Tools (an owner
  action outside this app's own scope, same "we build the interface, the
  owner does the account-level step" posture as the payment/notification
  gates' own vendor-dashboard steps); `business_hours`/
  `business_social_links` have no dedicated per-item add/remove UI (a
  plain multi-line `Textarea`, parsed at the save boundary) — matches
  this app's existing "simplest thing that produces valid structured
  data" posture rather than building a repeatable-field-row editor for
  what's realistically a handful of lines.

### GEO push part 2 — product schema, page metadata, llms.txt, `check_seo_schema` (2026-09-08)

Added 2026-09-08 off a user-supplied planning document
(`AI-agent-mvp_GEO实施方案.pdf`) auditing this app against a standard
GEO/AI-discoverability checklist. Most of the plan's Layer 1
(crawlability: SSR, robots.txt, sitemap) was already done by the
2026-08-21 work above; this closes the concrete gaps a fork-based audit
found: no per-product schema.org markup, no per-page metadata beyond the
site-wide default, no llms.txt, and no automated way to check any of it.
Review/NAP-consistency-across-pages from the plan was explicitly NOT
built the way the plan describes — see `check_seo_schema`'s own
docstring below for why that check doesn't apply to this app's
architecture.

- **`lib/products.ts`'s `buildProductJsonLd(product, siteUrl)`** — a
  schema.org `Product`+`Offer` JSON-LD block, mirrors
  `buildLocalBusinessJsonLd`'s pure-formatting/no-null-padding posture
  exactly. `/products/[id]/page.tsx` now injects it directly (a second
  `<script type="application/ld+json">` alongside the site-wide
  `WebSite`/`LocalBusiness` graph from `SiteJsonLd`, not a replacement of
  it) and gained a real `generateMetadata` (title/description/OG) — it
  used to inherit only the generic site-wide title. `priceCurrency` is
  hardcoded to `"USD"` — there's no currency column anywhere in this app
  (`Product.price` is a bare `Numeric`; the only other currency mention
  is `payments.py`'s own hardcoded Stripe `"usd"`), so this matches that
  rather than inventing a currency feature.
- **`lib/theme.ts`'s `extractPageSummary(sections)`** — best-effort
  title/description extraction from an already-saved page's *top-level*
  sections (Hero/FeatureGrid/TextBlock/CtaBanner/BadgeList's own
  heading/body-ish fields; deliberately does NOT recurse into
  `ContainerBlock.children` — a page built entirely from generic Block
  primitives falls back to the site-wide default rather than guessing).
  Used by `/p/[slug]/page.tsx`'s new `generateMetadata` (was static
  inheritance only) and `/about/page.tsx`'s `generateMetadata` (replaced
  a hardcoded `export const metadata` with this app's own portfolio
  copy, now reflecting the owner's actual saved "About" content once
  customized — falls back to the same original copy when unsaved).
- **`app/llms.txt/route.ts`** — the 2024+ llms.txt convention (a
  Markdown "what is this site, what's worth reading" doc for AI
  systems specifically, not yet universally read but essentially free
  to add). A `route.ts` Route Handler, not a Metadata Route file (no
  `llms.ts` convention exists the way there is for robots.txt/
  sitemap.xml) — built dynamically from `getPublicBusinessProfile()` +
  `listPublicPages()`, same "reflects live config, zero maintenance"
  posture as `robots.ts`/`sitemap.ts`, never a static file.
- **`backend/apis/seo_audit.py` + owner-agent's `check_seo_schema` tool**
  (owner-agent now 21 tools) — the plan's Layer 4 "productize the
  checks" idea, built as a genuinely read-only diagnostic: 6 checks
  (business-profile/NAP completeness, robots.txt AI-crawler allowlist,
  llms.txt reachability, sitemap.xml freshness + URL count, homepage
  JSON-LD presence, and a **sampled live fetch** of one real product
  page checking for its `Product` JSON-LD block — not a static
  code-path assumption), each independently try/excepted so one
  unreachable check never hides the others' results. Never writes
  anything — every real fix here (e.g. filling in a missing phone
  number) is a plain owner edit in `BusinessProfilePanel`, not something
  automatable, so there's no propose-then-apply flow needed, just a
  report. **Deliberately does NOT implement the plan's "NAP consistency
  across pages" check as originally described** — that check exists to
  catch a hand-authored multi-page site where the phone number typed on
  one page drifts from another. This app has no such risk structurally:
  `AppSettings`'s single `business_*` row is the one source of NAP data
  read by every page's JSON-LD/metadata/llms.txt alike, so cross-page
  consistency is already guaranteed by the architecture — the
  `business_profile` check reports completeness instead, and says so
  plainly in its own `detail` text so an owner (or the model reading it)
  doesn't mistake "no consistency check" for an oversight.
  - **New `FRONTEND_INTERNAL_URL` env var** (`docker-compose.yml`,
    default `http://frontend:3000`) — this is the first backend-
    initiated call INTO the frontend service (every other cross-service
    call in this app goes the other direction). The existing
    `FRONTEND_PUBLIC_URL` (used by Stripe/OAuth redirects) is the wrong
    variable for this: in local dev it resolves to `http://localhost:
    3000`, which from *inside* the backend container means the backend
    container itself, not the frontend one — the identical
    internal-vs-public split `COMFYUI_URL`/`COMFYUI_PUBLIC_URL` already
    established. Hit for real during verification (the first live run
    of `check_seo_schema` returned "connection failed" on every network
    check until this var was added and the backend container recreated).
  - Verified end-to-end against the real running stack (Docker Desktop
    was not running at session start; started it and brought the full
    `docker compose up -d` stack up specifically to verify this rather
    than relying on static checks alone): `GET /api/agent/seo/check`
    (as `owner@example.com`) correctly reported robots.txt/llms.txt/
    sitemap.xml all `ok`, homepage JSON-LD `warning` (no business
    profile configured on this dev instance — correctly detected, not a
    false pass), and — the real proof the frontend half works — the
    sampled product check `ok` against a live `/products/13`. Confirmed
    directly via `curl` against the frontend container too: `/llms.txt`
    renders real Markdown listing the actual saved pages; `/products/13`
    serves `<title>long black | AI MVP</title>`, a real meta description,
    and a real `Product`/`Offer` JSON-LD block (`price: "3.00"`,
    `availability` correctly reflecting that product's actual
    `available` flag); `/about` (which has real saved content on this
    dev instance) serves its own extracted title/description rather than
    the site default; `/p/product-list` (a page built entirely from a
    `ProductListBlock`, no extractable heading text) correctly falls back
    to the site-wide default title/description rather than guessing.
    `tsc`/`eslint` clean on every changed frontend file; `python -m
    py_compile` clean on every changed backend/owner-agent file.
  - **The owner-agent `/run` loop itself was verified live too, one
    session later, once the user started their local llama.cpp
    server** (the first attempt this same session 502'd — the
    configured local model wasn't running yet, unrelated to this
    change, same class of gap this file's "Known gotchas" already
    documents for an unreachable custom endpoint). Real command: "Run a
    GEO/SEO health check on the site and summarize the results." — the
    model correctly selected `check_seo_schema` on its own (no other
    tool tried first), got a real result back, and its final answer
    correctly grouped the two genuine warnings (missing business
    profile; homepage JSON-LD lacking a LocalBusiness entity) as one
    root cause with one fix, while accurately reporting the four
    passing checks — not just echoing the raw report back verbatim.

### Owner-configurable public-chat system prompt (`backend/apis/chat_settings.py`)

Added 2026-08-21, same day as the GEO push above, off a direct user
request: the owner should have real control over the public chatbot's
tone/persona/behavior rules, not just its underlying model — those were
already swappable (see "AI provider is swappable"), but `SYSTEM_PROMPT`
itself was still a hardcoded constant in `apis/chat.py`.

- **A confirmed, deliberate design decision: FULL replacement, not an
  append-only override.** I raised the safer alternative (owner can only
  add extra rules on top of a locked safety core) directly with the user
  before building; the user chose full replacement instead. This is
  safe enough to allow specifically because of how `apis/chat.py` is
  actually structured, confirmed by reading the real code path rather
  than assumed: every dynamic per-turn fact this app injects — RAG
  excerpts, visitor identity (`_build_visitor_context`), in-progress
  intake state (`_in_progress_context_block`), which request types are
  configured (`_available_request_types_block`), cart/order state
  (`_in_progress_order_block`/`_order_turn_context_block`) — is folded
  into the **user** message (`user_content`) on every turn, never into
  the **system** string. And the two classification calls that actually
  drive business logic — `_lead_extraction_call` (what gets captured
  into a `CrmEntry`) and `_order_extraction_call` (what gets added to an
  `Order`) — run against their own separate, fixed system prompts
  (`_lead_extraction_system_prompt`/`_order_extraction_system_prompt`)
  that this setting never touches at all. So a full replacement here
  only ever changes the main reply's tone/persona/framing — it cannot
  disable RAG grounding, break lead capture, or corrupt an order total,
  because none of those mechanics read this field.
- **`AppSettings.chat_system_prompt: str | None`** — null/empty means
  "use the built-in `SYSTEM_PROMPT` default," same fallback posture as
  every other owner-config field in this app.
  `apis/chat.py`'s new `_resolve_system_prompt(db)` is the one place
  that decides which prompt actually gets sent — `chat()`'s own
  `provider.chat(messages, system=SYSTEM_PROMPT)` call became
  `system=_resolve_system_prompt(db)`, a one-line change at the actual
  call site.
- **`GET/PUT /agent/chat-settings`** (`apis/chat_settings.py`, a new
  small dedicated file — same "one concern, one file" precedent as
  every other settings router added this session) — `GET` returns both
  the current override (`chat_system_prompt`, null if unset) AND the
  built-in constant (`default_chat_system_prompt`, always present) so
  the dashboard can show/diff against it without a second hardcoded copy
  of that text living in the frontend. `PUT` with `chat_system_prompt:
  null` (or blank) resets to the default.
- **`ChatPromptSettingsPanel`** (frontend, its own "Chat prompts"
  accordion group as of 2026-09-09 — was inside "AI & knowledge base"
  alongside `ModelSettingsPanel` until split apart per direct user
  feedback, see that group's own note below) — a large `Textarea`
  prefilled with the current effective prompt (custom or default), a
  "Customized"/"Default" `Badge` showing which is active, Save, and a
  "Reset to default" button (disabled when already on the default) —
  the recoverability path that matters given the full-replace design:
  an owner who breaks their own prompt always has one click back to the
  known-good original.
- **Verified end-to-end**: default state returns `chat_system_prompt:
  null` and the real full built-in prompt text under
  `default_chat_system_prompt`; saving a custom prompt (a deliberately
  silly pirate-persona test string) round-trips correctly; resetting to
  null correctly restores `null`. The actual `/chat` reply path change
  is a one-line substitution already covered by this app's own existing,
  already-verified `resolve_chat_provider`/`provider.chat()` call shape
  — not re-verified against a live model response this round (the
  configured local `custom` chat provider was intermittently unreachable
  this session, a known external-dependency gap, not a code issue — see
  "Known gotchas").

### Real LLM-driven intent triage — wired into `/api/chat`'s runtime (`AppSettings.chat_intent_prompt`, `_intent_triage_call`)

Added 2026-09-09, in two rounds the same day: the config layer (prompt
field, dashboard editor, AI-draft-from-documents suggestion), then a
same-day follow-up that actually wires a real classification call to
it. `/chat`'s old 3-step category/tags/channel wizard (`chat-panel.tsx`)
was a hardcoded, always-identical local script, never an LLM decision —
this replaces it entirely.

- **`AppSettings.chat_intent_prompt: str | None`** (`models.py`) — same
  null-means-default convention as `chat_system_prompt`, but a
  completely separate field/concern: `chat_system_prompt` shapes the
  main reply's tone/persona; this one drives the triage decision below.
  Neither reads the other. **`DEFAULT_INTENT_PROMPT` lives in
  `apis/chat.py`** (alongside `SYSTEM_PROMPT`, which `apis/
  chat_settings.py` already imported the same way) since the runtime
  actually reads it now — it started out in `chat_settings.py` during
  the config-only round and moved once that stopped being true.
- **`backend/apis/chat_settings.py`'s `GET`/`PUT /agent/chat-settings`**
  carries `chat_intent_prompt`/`default_chat_intent_prompt` alongside
  the existing `chat_system_prompt` fields, each independently optional
  in the `PUT` body (omit one to leave it untouched, explicit null
  resets just that one). **`POST .../suggest-intent-prompt`** mirrors
  `business_profile.py`'s `suggest_business_profile` propose-then-owner-
  applies pattern: drafts a prompt from `_gather_ready_document_text`'s
  ingested company-material documents plus a listing of any already-
  configured `IntentSchema`s, never saves anything itself. Degrades to
  an empty suggestion (not an error) when there are no ready documents.
- **`backend/apis/chat.py`'s `_intent_triage_call`/
  `_intent_triage_system_prompt`/`_build_triage_control`** — mirrors
  `_lead_extraction_call`/`_order_extraction_call`'s existing shape
  exactly: one fixed-shape classification call, never arbitrary tool
  access. Only ever attempted by `chat()` on a conversation's very first
  turn (`not history and not req.attachment_url` — a real attachment
  already shows clear intent, and a second triage question mid-
  conversation was never part of the design). Grounds its decision in
  this business's already-loaded `IntentSchema`s/`Product` catalog (the
  same data `_available_request_types_block`/`_menu_context_block`
  already use for the main reply) rather than a separate RAG call, and
  reads `AppSettings.chat_intent_prompt` via a new
  `_resolve_intent_prompt(db)` (same null-means-`DEFAULT_INTENT_PROMPT`
  fallback as `_resolve_system_prompt`). Returns `None` on any failure
  (provider unreachable, malformed JSON) — `chat()` treats that
  identically to an explicit "don't ask," never blocking the turn.
  `_build_triage_control` never trusts the model's `control_type`/
  `options` shape blindly — an unrecognized type, or missing/malformed
  options for a radio/checkbox/select type, both degrade to a plain
  `"text"` control (no special widget) rather than ever surfacing a
  broken control with nothing to click; verified directly by feeding
  malformed/missing-options JSON straight into the function.
- **`ChatResponse.control: ChatControlOut | None`** (new
  `ChatControlOut`/`ChatOptionOut` Pydantic models) — the same
  `{type, options}` structured-control contract `frontend/src/lib/
  types.ts`'s `ChatControl` type had always defined (its own doc comment
  says so explicitly — written forward-looking for exactly this, back
  when only the scripted wizard used it). When triage decides to ask,
  `chat()` returns early with `reply` set to the question text and
  `control` set — skipping RAG/order/lead-capture for that one turn —
  but still logs the question as a `ChatMessage` for
  `ChatSessionViewerPanel`/market-research review, same as any other
  reply.
- **`chat-panel.tsx` rewritten** — the old hardcoded `CATEGORY_OPTIONS`/
  `TAG_OPTIONS`/`CHANNEL_OPTIONS` arrays and the `step: 0|1|2|3|"done"`
  state machine are gone entirely. The seed greeting is now a single
  generic line with no control; every real turn (free text OR a clicked
  control option, both through one shared `sendTurn` function) calls the
  real `/api/chat` from message 1. A clicked control option is resolved
  back to its human-readable label before being sent as this turn's
  plain-language message — the LLM sees natural language, never a raw
  machine value. **The seed message is excluded from the `history` array
  sent to the backend** (filtered by its fixed `SEED_MESSAGE_ID`) — this
  is what lets `_intent_triage_call`'s `not history` gate correctly
  detect "this is really the first turn." `ChatControlRenderer`/
  `ChatMessageBubble` needed **zero changes** — the generic
  `{type, options}` rendering + `onControlSubmit` plumbing they already
  had was, per `ChatControl`'s own pre-existing doc comment, already
  built for exactly this. `ChatPromptSettingsPanel`'s intent-prompt card
  dropped the "Not yet live" badge/copy the config-only round had
  carried, since it's live now.
- **Verified end-to-end against the real running stack.** Config CRUD:
  `GET`/`PUT /agent/chat-settings` round-trip `chat_intent_prompt`
  independently of `chat_system_prompt`; `suggest-intent-prompt`
  correctly passed its `document_count == 0` short-circuit and reached a
  real (if unreachable-in-this-session) configured provider. Runtime
  wiring: direct unit-level calls confirmed `_intent_triage_call`'s JSON
  parsing and `_build_triage_control`'s degrade-to-`"text"` safety net
  both work in isolation; then against a REAL bundled-Ollama model (a
  temporarily pulled/tuned `qwen2.5:0.5b`, swapped in as `chat_provider`/
  `chat_model` only — vision/embedding untouched — via the real `PUT
  /agent/settings` API, restored to the owner's exact original
  `custom`-provider snapshot afterward via a direct DB write, the same
  "known-good snapshot restore" pattern used elsewhere in this file when
  a live-revalidation PUT can't succeed because the owner's own local
  llama-server isn't running here): a real first-turn message ("I want
  to talk about insurance" — this dev instance has `insurance_claim`/
  `insurance_application` schemas configured) correctly triggered
  `ask: true` with a real `control: {"type": "text"}` over HTTP; several
  other first-turn messages correctly returned `control: null` and fell
  through to the ordinary reply pipeline unchanged. `tsc`/`eslint`/a real
  production build all clean. Test chat sessions/models cleaned up after.
- **A genuine, honest caveat**: `qwen2.5:0.5b` is a very small model —
  its triage judgment itself was inconsistent (several genuinely
  ambiguous test messages got `ask: false` when a stronger model might
  reasonably have asked). This round verifies the *mechanism* — the
  classification call, the control-safety degrade path, the full
  request/response wiring, the frontend rendering — actually works
  end-to-end, not that any particular small model's judgment is great. A
  real production setup (this dev instance's own configured 27B
  `custom` model, unreachable from this sandboxed test environment)
  should judge noticeably better.

### Public "contact us" form + site-wide 404 page (`backend/apis/contact.py`, `frontend/src/app/not-found.tsx`)

Added 2026-09-09, same session, on a direct user ask for "a basic 404
page" and "a contact form for use during staging/building." Scoped
together deliberately (confirmed via `AskUserQuestion`): the contact
form is specifically a fallback for a visitor who lands on a page that
doesn't exist yet (a site still being staged — an unsaved `/p/[slug]`,
or any genuinely broken link), not a permanently-linked `/contact` nav
route. Next.js's `not-found.tsx` renders for both cases (an explicit
`notFound()` call and a truly unmatched route), so one page serves both
asks: a basic "page not found" message, plus a way to actually reach the
business instead of a dead end.

- **`backend/apis/contact.py`** — a new, tiny, fully public (no-auth)
  `POST /api/contact` — the one route that lets an unauthenticated
  visitor create a `CrmEntry` directly (deliberately NOT folded into
  `apis/agent.py`'s admin/owner-gated `create_crm_entry`, which the
  contact form has no JWT to call). Stores as `category="inquiry"`,
  `tags=["contact-form"]` — shows up in `CrmPanel`'s existing
  "Inquiries" group with zero new dashboard UI. Server-side validation
  only requires non-blank name/message and a `@` in the email (matches
  this app's existing "plain `str`, no `EmailStr`" convention —
  `email-validator` isn't a dependency here). Rate-limited in
  `rate_limit.py` (10/5min per IP, same tier as `/api/chat/upload`) —
  the one genuinely new public-mutation attack surface this adds.
- **`frontend/src/lib/contact.ts`** — `submitContactForm({name, email,
  message})`, a plain `apiFetch` call, no auth.
- **`frontend/src/components/modules/contact-form.tsx`** — a small,
  reusable `ContactForm` (name/email/message + submit, a "message sent"
  confirmation state), independent of the chatbot entirely — used by
  `not-found.tsx` today, generic enough to reuse anywhere else a plain
  contact form is wanted later.
- **`frontend/src/app/not-found.tsx`** — `PageHeader` + an `EmptyState`
  ("Back to homepage" button) beside the `ContactForm`. Renders inside
  the root layout (so `SiteHeader`/`SiteFooter`/the chat bubble all
  still show) and returns a real HTTP 404, confirmed live.
- **Verified end-to-end against the real running stack**: `POST
  /api/contact` — a valid submission correctly created a `CrmEntry`
  (verified via `GET /agent/crm/entries?category=inquiry`, then cleaned
  up), an invalid email and a blank message both correctly rejected (400
  and 422 respectively) with no row created; a flood of 11 requests from
  one IP correctly 429'd after the configured budget (test rows cleaned
  up after). Both trigger paths for the frontend page — an unmatched
  route (`/this-route-does-not-exist`) and a real unsaved `/p/[slug]` —
  both correctly rendered the new page's content (confirmed via a direct
  `curl` of the dev server's rendered HTML) and both returned a real 404
  status code. A real production build (`docker compose run --rm
  frontend npm run build`) shows `/_not-found` as a real compiled route,
  clean `tsc`/`eslint`. **Not verified**: an actual in-browser click-
  through of the submit button — the Chrome extension was not connected
  this session either (the standing gap noted elsewhere in this file),
  so this stops at API-level + rendered-HTML verification, same as most
  of this app's other UI work.

**Scope correction, same day, off a direct user follow-up**: the
contact-form fallback above only ever covered "the page doesn't exist"
(an unsaved slug, a broken link). The user clarified the actual intent
was broader — a fallback for "site not ready / no LLM configured / no
API key / the assistant broke down," i.e. the LIVE CHAT itself failing,
not just a missing page. Fixed in `chat-panel.tsx`: `handleSend`'s catch
block now distinguishes a genuine backend failure (`ApiError.status >=
500` — `ProviderNotConfigured`'s 503, an unreachable provider's 502, or
any other server error) from an ordinary 4xx (bad input, rate-limited).
On a 5xx, a new `chatUnavailable` state renders `<ContactForm>` inline
(title "Chat is temporarily unavailable") in place of the usual
retryable `ErrorMessage` — retrying doesn't fix "no provider
configured," so offering the alternative path is the honest response.
Reset alongside `error` at the top of every new send attempt, so a
later successful turn (chat recovers) clears it automatically. Since
`ChatPanel` is the one component behind both `/chat` and the site-wide
`ChatBubbleWidget`, this fallback applies everywhere chat appears with
no separate wiring.

### Basic error logging + email-on-severe-error (`backend/error_alerts.py`)

Added 2026-09-09, same session — a direct user ask: "系统是否有基本的log和严重
错误时的自动发邮件功能" (does the system have basic logs and automatic email
on severe errors). It had neither before this.

- **Scoped to genuinely UNHANDLED exceptions only** — a real bug, a
  crash, a dependency failing in a way this app didn't already account
  for. Every deliberate `raise HTTPException(...)` already in this
  codebase (including `ProviderNotConfigured`'s 503 for "no AI provider
  configured yet") is handled by Starlette's own dedicated exception
  handler and never reaches `error_alerts.py`'s handler — an owner mid-
  setup isn't "an error," and alerting on it would spam a fresh
  install's inbox nonstop. That case's right response is the frontend
  fallback above, not an email.
- **`app.add_exception_handler(Exception, unhandled_exception_handler)`**
  (`main.py`) — two always-attempted, best-effort effects, every time:
  (1) **log** — one JSON line appended to a bind-mounted
  `backend/logs/errors.jsonl` (mirrors `owner-agent/logging_.py`'s own
  "stdout + a durable JSONL file" pattern), readable via `GET
  /agent/error-log` (`apis/error_log.py`, admin/owner-gated,
  most-recent-first) without needing `docker compose logs`; (2) **email
  alert** — sent via whatever email provider is already configured
  (`apis/notifications.py`'s `resolve_email_provider`) to
  `AppSettings.alert_email` (new column, same "no separate enabled
  flag" posture as `is_email_configured`) if the owner has set one.
  Cooldown-gated (`ALERT_COOLDOWN_SECONDS = 900`, in-process/single-
  worker — same assumption `rate_limit.py` already documents) so a
  crash loop sends one alert, not hundreds.
- **`POST /agent/error-log/test`** (`apis/error_log.py`) — deliberately
  raises a real `RuntimeError` so a "test" exercises the ACTUAL pipeline
  (global handler → log → cooldown-gated email), not a parallel
  pretend-send like the notification panel's own test-email/test-sms
  buttons. `ErrorLogPanel` (frontend, "Products & orders" — not
  products/orders-specific, same "lives here anyway" posture as
  `ScheduledTasksPanel` next to `DocumentManager`) has a "Trigger test
  error" button plus a per-entry expandable traceback.
  `NotificationSettingsPanel` gained the `alert_email` field itself
  (reuses that panel's existing Mailgun config, no separate credential).
- **Real bug caught and fixed during live verification**: the first cut
  had `except NotificationProviderNotConfigured: pass` around the send
  call — but that exception type is raised for BOTH "no credentials
  configured" AND "the provider's real API rejected the request" (see
  `MailgunEmailProvider`/`TwilioSMSProvider`'s own `raise
  NotificationProviderNotConfigured(f"... rejected the send request:
  ...")` for a bad/expired key). Silently `pass`ing meant a bad Mailgun
  key would fail an alert with ZERO trace anywhere — worse than the
  generic-`Exception` branch beside it, which at least logs. Fixed to
  always `logger.error(...)` in that branch too — confirmed this was
  the actual, load-bearing bug (not a logging-visibility issue) by
  reproducing it against Mailgun's real API with a fake domain/key,
  which correctly returned a genuine rejection ("Forbidden") that was
  being swallowed before the fix and is now logged.
- **Verified end-to-end against the real running stack, including a
  real Mailgun rejection, not just the test-mode no-op path**: default
  test-mode trigger logs to the JSONL file with no email attempt
  (`is_email_configured` correctly gates on provider != "test"); a real
  `mailgun`-configured-but-fake-credentials setup correctly attempted a
  real HTTPS call to Mailgun's production API, got a real rejection, and
  — after the fix above — logged it visibly (confirmed via a live
  log-stream capture during the request, not just a `tail`, since the
  traceback's own line count was long enough to push a `--tail=15/60`
  snapshot past the relevant line on a couple of attempts — a real,
  if minor, lesson about using `logs -f` rather than a short `--tail`
  when hunting for one specific line among a large traceback); an
  immediate second trigger correctly hit the cooldown and did NOT
  re-attempt the send. Test credentials cleared after. `pytest`/`tsc`/
  `eslint`/a real production build all clean.

### Local model files convention (`models/`, `LOCAL_MODELS_DIR`)

Added 2026-09-09, same session — the user asked for "一个可以放模型的文件夹和env
指向" (a folder to put models in, and an env pointer) so an owner running
this app on a real machine can download and use their own model. Scoped
deliberately lightweight per a direct `AskUserQuestion` confirmation:
**no new inference service added to `docker-compose.yml`** — bundling a
managed local LLM runtime would mean this app's own compose stack takes
on GPU/driver/memory-management concerns that vary a lot machine-to-
machine, and the existing "custom endpoint" mechanism (`AppSettings.
custom_base_url`/`custom_api_key`, see "AI provider is swappable" above)
already lets an owner run ANY OpenAI-compatible inference server however
they want and just point this app at it — nothing new needed there.
- **`models/`** (repo root, sibling to `backend`/`frontend`/`owner-agent`)
  — a conventioned folder for downloaded model files (`.gguf`, etc.),
  gitignored except its own `README.md`/`.gitkeep` (model files are
  large and machine-specific, never meant to be committed). The README
  walks through the actual mechanism: download a model here, start your
  own `llama-server`/vLLM/LM Studio pointed at it, then connect it via
  the dashboard's already-existing "Custom endpoint" block in Model
  settings — no code change, no restart.
  - **`LOCAL_MODELS_DIR`** (root `.env`/`.env.example`, defaults
    `./models`) — explicitly documented as NOT consumed by
    `docker-compose.yml` or any service here, unlike every other var in
    that file — it exists purely for the owner's own convenience when
    scripting their own inference server's startup command (e.g. `-m
    "$LOCAL_MODELS_DIR/your-model.gguf"`). A deliberately honest
    distinction from every other `.env` var, called out explicitly in
    both files' own comments so this one is never mistaken for
    something this app's own services read.

### First-run setup wizard (`/setup`)

Added 2026-09-09, same session, off the user's own framing: an
onboarding flow closer to an OS's first-boot experience ("choose your
model, connect it, then the AI can help configure the rest") than the
dashboard's existing flat settings panels. Scoped to **just the wizard
UI** per a direct `AskUserQuestion` confirmation — no EC2/server
deployment automation this round (see "Suggested next step" below for
where that stands).

- **`SetupWizard`** (`frontend/src/components/modules/setup-wizard.tsx`)
  — a 3-step shell (Welcome → Connect a model → Finish). The "connect"
  step's UI went through a real revision the same session: the first cut
  just embedded `ModelSettingsPanel` directly; the user then proposed a
  concrete two-branch flow instead ("1. use an API key → pick a vendor →
  paste it → done", "2. install a local model → pick one → it
  downloads → done"), which is what actually shipped:
  - **`ApiKeyConnect`** — vendor `Select` (OpenAI/Anthropic/Gemini) + one
    password input + "Save and connect". Two sequential `PUT
    /agent/settings` calls, not one: the first saves just the API key,
    the second sets `chat_provider`/`chat_model` to that vendor's now-
    `selectable` default. Has to be two calls, not one combined save —
    `update_settings`'s own validation checks `selectable` against
    whatever's ALREADY persisted in the DB, so a single request
    submitting both the new key and the new provider in one shot would
    validate against the key's pre-save (still absent) state and 400
    incorrectly.
  - **`LocalModelConnect`** — suggested-model cards (or any typed Ollama
    tag) → `POST /agent/ollama/pull` → 2s-interval polling of `GET
    .../pull-status` with a real progress bar → "Use this model" sets
    `chat_provider: "ollama"` once done. See "Bundled Ollama" below for
    the backend half this drives.
  - Both branches call `patchModelSettings()` (fetches current
    `ModelSettings`, spreads a small patch on top, PUTs the whole
    object) rather than hand-rolling the full request shape per call
    site — `PUT /agent/settings` always takes the complete object.
  - **Advanced/everything-else configuration (vision, embedding,
    image-gen, a self-hosted non-Ollama runtime) stays reachable via a
    collapsed `ModelSettingsPanel`** below the two-branch UI, not
    duplicated into it — the quick-connect flow only ever sets the CHAT
    model; an owner who also wants a different vision/embedding
    provider still uses the full panel.
  - `lib/setup.ts`'s `checkSetupStatus()` (unchanged from the original
    cut) still determines "is chat actually connected" via `GET
    /agent/models`'s `selectable` flag — the same signal
    `ModelSettingsPanel` itself uses for "Not configured" badges.
- **`/setup`** (`app/setup/page.tsx` → `SetupPage`) — gated the same as
  the rest of the agent console (admin OR owner), display-only gating
  (same posture as most of this app besides `AgentConsoleSection`'s
  extra stale-token re-verification dance — the backend independently
  re-checks on every real request `ModelSettingsPanel` makes).
- **`SetupStatusBanner`** — rendered above the dashboard's accordion
  (`AgentConsoleSection`) whenever no chat model is actually connected
  yet, linking to `/setup`. Deliberately a dismissible-by-navigating-
  away nudge, not a forced redirect on login — a real, deliberate scope
  cut: this wizard doesn't need to own the login flow to be useful.
- **Real lint catch during this pass, same recurring class as
  elsewhere in this file**: the status-check effect originally called
  `setStatus("loading")` synchronously before an async check, tripping
  `react-hooks/set-state-in-effect`. Fixed the same way
  `AgentConsoleSection`'s own verify-session effect already does it:
  never set a "loading" state synchronously in the effect body at all —
  rely on the state's own initial value, and only call `setState` from
  inside a `.then()`/`.catch()`. The "Re-check" button (a real click
  handler, not an effect) still sets "loading" synchronously, which is
  fine there.
- **Verified end-to-end against the real running stack**: `/setup`
  correctly 404'd until a frontend restart (a known, already-documented
  Turbopack dev-mode gotcha for brand-new route files — see "Known
  gotchas" below), then correctly returned 200 and rendered the
  logged-out gated state ("Admin or owner access needed" + a Log-in
  link). A real production build (`docker compose run --rm frontend npm
  run build`) shows `/setup` as a real compiled route. `tsc`/`eslint`
  clean across the whole `src/` tree.

### Cloud provider API keys — now DB-configurable, not just env vars

Added 2026-09-09, same session, unblocking the setup wizard's
`ApiKeyConnect` branch above: OpenAI/Anthropic/Gemini keys were
previously env-var-only (`OPENAI_API_KEY`/etc., read once at module
import), meaning a wizard "paste your key here" step would have had
nowhere real to save it short of editing `.env` and restarting. Now
settable via the dashboard/wizard, same as `AppSettings.custom_api_key`
already was for self-hosted endpoints.

- **`AppSettings.openai_api_key`/`anthropic_api_key`/`gemini_api_key`**
  (new columns, write-only, never echoed back) — one key per vendor
  covers chat+vision+embedding+image-gen for that vendor, matching how
  each vendor's own API actually authenticates (one key, every
  capability). **The env var still works as a fallback** — nothing was
  removed, this only adds a no-restart alternative.
- **`providers/openai.py`/`anthropic.py`/`gemini.py`** — every class
  (`OpenAIChatProvider`, `OpenAIEmbeddingProvider`,
  `OpenAIImageProvider`, and the Anthropic/Gemini equivalents) now takes
  an optional `api_key` constructor override, falling back to the
  module-level env var when not given. Same "swappable, not hardcoded"
  pattern `providers/custom.py`'s `base_url`/`api_key` already
  established, extended to the 4 named vendors.
- **`apis/model_settings.py`'s `_cloud_api_key(db, provider)`** — the one
  place that decides which key actually gets used (DB overrides env,
  same precedence the provider classes themselves now implement).
  Every "is this cloud provider configured" check in this file (the
  model list's `configured`/`selectable`, `resolve_chat_provider`/
  `resolve_vision_provider`/`resolve_embedding_provider`/
  `resolve_image_provider`, `update_settings`'s own validation) now goes
  through this one function instead of five separately-hardcoded
  `bool(OPENAI_API_KEY)`-style checks that would have silently ignored
  a DB-saved key.
- **`ModelSettings.openai_api_key`/`_set` (+ anthropic/gemini pairs)** —
  same write-only-secret shape as every other credential field in this
  app (`stripe_secret_key`/etc.): the key itself is PUT-only, never
  echoed on GET; a `*_api_key_set` boolean (GET-only) tells the frontend
  whether a DB-saved key already exists, so `ModelSettingsPanel`'s new
  `CloudApiKeysBlock` can show a "leave blank to keep" placeholder
  without ever seeing the real value.
- **Verified end-to-end against the real running stack, including a
  genuine vendor rejection, not just the DB round-trip**: saved a fake
  OpenAI key via `PUT /agent/settings` (confirmed `openai_api_key_set`
  flips to `true`, the key itself never echoed, and the owner's actual
  pre-existing `custom`-provider settings were left completely
  untouched by the save); switched `chat_provider` to `"openai"` and
  called `/agent/chat-completion` — the request reached a REAL HTTPS
  call to `api.openai.com`, which correctly rejected the fake key with
  401, surfaced as a clean 502 rather than a crash. Settings restored to
  the owner's original real configuration afterward (a direct DB write,
  not the API — reverting away from `openai` back to `custom` would have
  needed the owner's own local llama.cpp server to be live-reachable for
  `update_settings`'s own re-validation, which it wasn't during this
  test; restoring via DB write was judged safe specifically because it
  reproduced an already-known-good prior state, not a new unvalidated
  claim). `pytest`/`tsc`/`eslint`/a real production build all clean.

### Bundled Ollama — automated local-model download (`docker-compose.yml`'s `ollama` service, `backend/apis/ollama_admin.py`)

Added 2026-09-09, same session, closing the other half of the setup
wizard's local-model branch. The user asked directly why this couldn't
be "fully automatic like LocalAI.io" — the answer, worked through with
the user: a containerized backend genuinely CANNOT install software or
manage arbitrary downloads on the HOST OS (no access, no privilege, and
building a privileged host-agent to do that would be a much bigger,
separate, security-sensitive component). But LocalAI's own trick — the
model lives inside a container's own volume, not the host filesystem —
IS fully achievable here: **Ollama itself now runs as another
docker-compose service**, reachable over the internal Docker network,
so the backend CAN trigger a real download via a plain HTTP call to a
sibling container, no host access needed at all. Deliberately scoped to
Ollama specifically, not llama.cpp/vLLM/etc. — Ollama's own API already
does exactly this job (`POST /api/pull`, streaming real progress);
those other runtimes have no equivalent built-in model manager and stay
on the existing manual `models/README.md` + "Custom endpoint" path.

- **`docker-compose.yml`'s new `ollama` service** — official
  `ollama/ollama:latest` image, no custom build. `ollama_data` named
  volume (pulled models are large, machine-specific binary blobs — same
  "named volume, not the bind-mounted source tree" reasoning `pgdata`
  already gets). Port `127.0.0.1:11434` only (same posture as
  `postgres-db`'s own port mapping — debugging access only, backend
  reaches it via `ollama:11434` over the internal network regardless).
  **CPU-only by default, confirmed scope with the user** — no GPU
  passthrough configured this round; a small/quantized suggested model
  is still usable on CPU, just slower.
- **`backend`'s `OLLAMA_BASE_URL` now points at `http://ollama:11434/v1`**,
  not `http://host.docker.internal:11434/v1` — a real, deliberate
  reversal of the previous assumption that Ollama runs on the owner's
  own host machine. `providers/ollama.py`'s own env-var default is
  unchanged (still `host.docker.internal`, for a non-compose deployment)
  — only docker-compose.yml's explicit override changed.
- **`backend/apis/ollama_admin.py`** (new router, `/agent/ollama/*`,
  admin/owner-gated):
  - `GET /status` — live reachability + currently-installed models
    (`GET {ollama}/api/tags`).
  - `GET /suggested-models` — a small hardcoded list (llama3.2,
    qwen2.5:7b, gemma3:4b, nomic-embed-text) with size/description, for
    the wizard's cards — not exhaustive, any Ollama tag can still be
    typed in directly.
  - `POST /pull` — starts a real background pull (`asyncio.create_task`,
    not a `BackgroundTasks` response-scoped one, since this response
    needs to return before the multi-minute download even starts) via
    Ollama's own streaming `POST /api/pull`, tracking progress
    (status/completed/total bytes) in an in-memory dict keyed by model
    name — same "in-memory, single-process" acceptance `rate_limit.py`
    already documents for this app's one-uvicorn-worker deployment.
    409s if that exact model is already mid-pull.
  - `GET /pull-status?model=` — polled by the wizard every 2s for a real
    progress bar.
- **Verified end-to-end against the real running stack, including an
  actual multi-hundred-megabyte download, not a mock**: brought up the
  new `ollama` service for real (Docker had to pull the `ollama/ollama`
  image itself first); `GET /status` correctly reported reachable with
  zero installed models on a fresh container; `POST /pull` for
  `nomic-embed-text` correctly started a background download, a second
  concurrent pull attempt correctly 409'd, and polling `/pull-status`
  showed REAL progress (`completed: 159510528, total: 274290656`)
  followed by `status: "success", done: true` — a genuine ~270MB
  download completed in well under a minute. Confirmed the pulled model
  then appeared as `selectable: true` in `GET /agent/models`'s
  `embedding_models` list with the exact tag Ollama itself assigned
  (`nomic-embed-text:latest`) — real Ollama tag-normalization behavior
  that mattered for a later round's design (see "Modelfile automation"
  below). `docker compose config --quiet` validated the compose file;
  `pytest`/`tsc`/`eslint`/a real production build all clean.

### Automatic database migrations on startup (`backend/migrate.py`)

Added 2026-09-09, same session, off a direct principle the user stated:
as fewer users know CLI/code, even a small amount of setup friction
loses them — "如果一开始的安装有一点点复杂，用户都不买账." Every schema change in
this project previously needed a manually-run `docker compose exec
backend alembic upgrade head`; harmless for this project's own dev
sessions (this file's history is full of exactly that command), but a
real, disqualifying blocker for a non-technical owner who has no idea
what a migration is.

- **`run_migrations_with_retry()`** (`backend/main.py`'s `lifespan`, runs
  before anything else touches the DB) — calls Alembic's own Python API
  (`alembic.command.upgrade`, same `alembic.ini`/`env.py` the manual CLI
  invocation already used) automatically on every backend startup.
  `docker compose up` is now the one command an owner ever needs to
  know — no separate migration step, ever.
- **Retries up to 10 times, 2s apart** — `docker-compose.yml`'s
  `depends_on: postgres-db` only guarantees the container has STARTED,
  not that Postgres is actually ready to accept connections yet, a real
  race this project's own multi-service startup can hit.
- **Real bug caught during live verification**: the retry loop's first
  cut never actually retried — a single `command.upgrade()` call against
  an unreachable Postgres just HUNG indefinitely (confirmed live: the
  backend sat at "Waiting for application startup" for minutes with zero
  retry log lines) rather than raising a fast `OperationalError`, because
  `alembic/env.py`'s `engine_from_config(...)` had no connection timeout
  at all. Fixed by adding `connect_args={"connect_timeout": 5}` to that
  `engine_from_config` call — this bounds ONLY the connection-attempt
  phase (not DNS resolution, which is a separate, much rarer failure
  mode only hit by literally stopping the postgres-db container
  mid-session, not by a normal `docker compose up` cold start).
- **Verified end-to-end against the real stack, including a genuine cold
  start from nothing**: `docker compose down` (network + non-persistent
  containers removed) followed by `docker compose up -d` — all 5
  services created fresh, backend became fully responsive with ZERO
  manual intervention, `alembic current` confirmed the schema landed at
  head automatically. `pytest` clean immediately after. A separate,
  synthetic "stop just postgres-db mid-session, restart backend" test
  did surface real Docker-networking weirdness (a stale DNS/connection
  state that a plain `docker compose restart` didn't clear, requiring
  `--force-recreate` to resolve) — noted here as a known rough edge for
  that specific, unusual sequence, not a flaw in the migration retry
  logic itself, which behaved correctly once the connect-timeout fix
  was in place and a genuine cold start was tested.

### Modelfile automation — tuned + verified local models, never a broken one (`backend/apis/ollama_admin.py`)

Added 2026-09-09, same session, off the user's own explicit bar: "默认生成，
但一定是能够使用，能拉起来的系统" (generate by default, but it must always be a
system that actually works, that actually starts). Two tiers, confirmed
directly with the user:

- **Tier 1 — every library model pulled via `/pull` gets an automatic
  tuning attempt, invisibly.** Ollama's own per-model default context
  window (`num_ctx`) is often smaller than this app's real usage pattern
  needs (a long system prompt + RAG excerpts + conversation history all
  in one request) — `_run_pull` now always follows a successful base
  pull with an attempt to create `<model>-tuned` (`{"from": model,
  "parameters": {"num_ctx": 8192}}`), then VERIFIES it with a real chat
  completion (not just a reachability check — catches a model that
  "created" but returns empty/garbled output). `PullStatus.final_model`
  is always the model to actually use — the tuned variant if that
  succeeded, the plain pulled model (already proven to work by the pull
  itself) if tuning or verification failed for any reason. The owner
  never sees the tuning attempt at all unless they check
  `PullStatus.tuned` — a failure there is silent-and-safe, never
  surfaced as a pull failure.
- **Tier 2 — an owner-supplied ("UD"/custom) model gets Ollama's own
  default treatment FIRST, confirmed directly with the user
  ("modelfile先有ollama提供的原型的把")**: `POST /import-custom` (for a file
  the owner dropped into `../models/`, now mounted read-only into BOTH
  the backend and the bundled `ollama` service) tries a minimal `{"from":
  "/models/<file>"}` — trusting Ollama's own GGUF metadata auto-detection
  for template/etc. Only when that fails verification does this ask
  whichever chat provider is ALREADY configured to draft a best-effort
  `{"system", "template", "parameters"}` suggestion from the filename +
  error (`_suggest_model_spec`, `json_mode=True` + `llm_json.
  parse_lenient_json`, same lenient-JSON pattern used throughout this
  app) — returned as a DRAFT for the owner to review, **never auto-
  applied**, since there's no way to actually inspect the GGUF's real
  architecture from here and a guess could easily be wrong. `POST
  /create-custom` applies an owner-reviewed (AI-drafted-then-edited, or
  hand-written) spec directly, through the identical create-then-verify
  safety net.
- **Shared `_create_and_verify(name, spec)`** — the one function both
  tiers go through: create via Ollama's native API, verify with a real
  `{"role": "user", "content": "Say OK."}` chat completion (generous
  120s timeout — a freshly-created model's first load is a real cold
  start), and **always clean up (`DELETE /api/delete`) a model that
  failed verification** — a broken half-created model never lingers as
  a selectable-looking option.
- **Real, load-bearing API-shape bug caught during live verification —
  worth remembering for any future Ollama integration work**: the
  classic `{"name": ..., "modelfile": "<raw Modelfile text>"}` request
  shape for `POST /api/create` — documented in a lot of older Ollama
  material, and what this endpoint originally sent — is REJECTED
  outright by the actual bundled version (0.33.3): `{"error": "neither
  'from' or 'files' was specified"}`. The current API wants STRUCTURED
  fields instead: `model` (not `name`), `from`, and optionally
  `system`/`template`/`parameters` — confirmed by testing directly
  against the real running Ollama instance, not assumed from
  documentation. `/api/delete`, by contrast, still accepts `{"name":
  ...}` — confirmed separately; the two endpoints were NOT assumed to
  share the same field-naming convention just because they're siblings.
  Every "Modelfile" reference in this app's own UI copy is a user-facing
  concept name — the actual wire format is always the structured JSON
  shape now, and the AI-suggestion prompt was written to draft that
  structured JSON directly rather than raw Modelfile text.
- **`GET /local-files`** — lists `.gguf`/`.bin` files in the shared
  `/models` mount, filtered by real directory listing (never trusting a
  caller-supplied filename as a path on its own — same paranoid
  containment posture `chat_attachments.py`'s `resolve_local_path`
  already established for this app's other client-supplied-path
  surfaces).
- **`docker-compose.yml`** — `./models:/models:ro` mounted into BOTH
  `backend` (so it can list files) and `ollama` (so it can actually read
  one to import it), read-only on both sides — neither service needs
  write access to an owner's own source model files.
- **Frontend**: `LocalModelConnect` (`setup-wizard.tsx`) now uses
  `PullStatus.final_model` directly (already proven to work by the
  backend) instead of re-deriving it from `GET /agent/models` — simpler
  and more accurate than the original tag-matching heuristic. A new
  `CustomModelImport` sub-component lists `models/` files, offers to
  import one, and — only on a failed default attempt — shows the
  AI-drafted suggestion as read-only JSON with an "Apply this
  suggestion" button (`lib/ollama.ts`'s `importCustomModel`/
  `createCustomModel`).
- **Verified end-to-end against the real running stack, including both
  the success and fallback paths, not just the happy path**:
  - Tier 1 success: pulled `llama3.2` for real (~2GB), the tuned variant
    `llama3.2-tuned` was created and passed a REAL verification call
    ("What is 2+2? Answer in one word." → "Four.", confirmed via a
    direct `curl` against Ollama's own OpenAI-compatible endpoint, not
    just this app's own reporting) — `PullStatus` correctly reported
    `final_model: "llama3.2-tuned"`, `tuned: true`, and `GET
    /agent/models` correctly listed it as `selectable: true`.
  - Tier 1 fallback: re-pulled `nomic-embed-text` (an embedding-only
    model with no chat capability) specifically to force the tuning
    verification to fail — confirmed `final_model: "nomic-embed-text"`
    (the plain model), `tuned: false`, and confirmed via `ollama list`
    that the failed tuned variant was NOT left lingering (cleaned up
    correctly).
  - Tier 2 failure path: dropped a fake (non-GGUF) file into `models/`,
    confirmed `POST /import-custom` correctly surfaced Ollama's own real
    400 rejection, and confirmed the AI-suggestion fallback correctly
    degraded to `suggestion: null` (not a crash) when the currently-
    configured chat provider was unreachable — the exact "best-effort,
    never a second confusing failure" behavior this was designed for.
  - Test models (`llama3.2`, `llama3.2-tuned`, the fake GGUF) cleaned up
    after; `nomic-embed-text` left in place (small, genuinely useful).
    `pytest`/`tsc`/`eslint`/a real production build all clean.
- **Deliberately not verified this round**: an actual custom/"UD" GGUF
  import succeeding via Ollama's own default auto-detection — no real
  GGUF file was available inside the sandboxed test environment to
  import (the user's own real model lives on their host filesystem, not
  inside `../models/`). The failure path (above) and the shared
  create-then-verify machinery (proven by Tier 1) are both real and
  verified; the specific "a real GGUF imports cleanly on the first try"
  case is inferred from Ollama's own documented capability, not
  independently confirmed live.

### Server-side model download from a URL + dashboard integration

Added 2026-09-09, same session, off two direct follow-up questions: (1)
"是否已经连同dashboard的一起改好了" (has this been wired into the dashboard too) —
no, it hadn't; the Ollama pull/import UI only existed inside `/setup`.
(2) "有没有给owner下载模型的入口或方法？一般是上传，ftp或网站点对点下载" (is there a way
for the owner to actually get a model file in — upload, FTP, direct
download) — no, `models/` could ONLY be filled by an owner with direct
filesystem access to wherever this app runs, which silently breaks the
entire "bring your own model" story on a remote/EC2-style deployment
with no shell access.

- **Confirmed design, directly with the user**: server-side URL download
  (the owner pastes a link, the BACKEND fetches it), not a browser
  upload. Reasoning: model files are typically many GB (a browser
  upload would cost the OWNER's own upload bandwidth — often far slower
  than a server-to-server fetch — and a dropped connection loses the
  whole transfer), and an owner sourcing a custom model almost always
  already has a URL (HuggingFace, a direct link) rather than the file
  already sitting on their own machine. This mirrors `apis/documents.py`'s
  already-established RAG-document URL-ingestion pattern exactly, just
  for a model file. The user's own explicit bar: "下载progress需要做好"
  (the download progress must be done well) — see the real accuracy fix
  below.
- **`docker-compose.yml`'s backend mount widened to read-write**
  (`./models:/models`, was `:ro`) — the backend now needs to WRITE a
  freshly-downloaded file into this folder, not just read what an owner
  already placed there. `ollama`'s own mount stays read-only — it only
  ever needs to read a file to import it.
- **`POST /agent/ollama/download-from-url`** (`{url, filename?}`) — same
  background-task + in-memory-progress-dict shape as `/pull` above.
  Downloads to a `<filename>.part` sibling, renamed to the real name
  only on success, so a still-downloading (or failed, half-written) file
  never shows up in `GET /local-files`'s listing as something ready to
  import. `GET /download-status?filename=` polls real byte-level
  progress (`downloaded`/`total`).
- **Real accuracy bug caught during live verification, directly serving
  the "progress must be done well" bar**: a first real test (downloading
  a small file from a real, public GitHub URL) reported `downloaded:
  19225` against `total: 6832` — a nonsensical >100%. Root cause: the
  source's `Content-Length` header describes the COMPRESSED
  (gzip-encoded) size, but httpx transparently decompresses the stream,
  so the actual bytes received exceed that header's value. Fixed by
  sending `Accept-Encoding: identity` on the download request — this
  costs nothing for the real target use case (GGUF binary model weights
  don't meaningfully compress anyway) but guarantees an accurate
  percentage for any source, not just ones that happen to skip
  compression on their own. Re-verified after the fix: `downloaded ==
  total` exactly on the same real URL.
- **Frontend**: the "Or bring your own model file" section now leads
  with a URL input + progress bar (byte counter when the source doesn't
  report a total, never a fake/guessed percentage), and the existing
  "pick a file from `models/`" button row refreshes automatically once a
  download completes — no separate "import" step to remember, the newly
  downloaded file just appears as another clickable option.
- **Dashboard integration**: `OllamaModelManager` — the pull-a-suggested-
  model UI, the URL-download section, and the custom-file-import section
  — was extracted out of `setup-wizard.tsx` into its own file
  (`ollama-model-manager.tsx`) specifically so it could be rendered in
  BOTH places: `SetupWizard`'s "install a local model" branch (unchanged
  behavior) AND a new "Local models (bundled Ollama)" section in
  `ModelSettingsPanel` itself, directly in the dashboard's "AI &
  knowledge base" accordion. Model management is an ongoing operational
  task (an owner will want to try a different or additional model long
  after their first setup), not a one-time onboarding step — burying it
  inside `/setup` only made sense before this fix. `patchModelSettings`
  (the "fetch current settings, spread a patch on top, PUT the whole
  object" helper both consumers need) moved to `lib/models.ts` as a
  shared export rather than staying duplicated/wizard-only.
- **Verified end-to-end against the real running stack**: a real
  download from a live public URL completed with byte-exact progress
  (after the encoding fix above) and the file correctly appeared in
  `local-files`; a deliberately unreachable domain correctly surfaced a
  real DNS-resolution error with NO `.part`/partial file left behind;
  confirmed `/models` is genuinely writable from inside the backend
  container (`touch`/`ls`/`rm` round-trip) after the mount change.
  `docker compose ps`/`/setup`/`/dashboard` all confirmed reachable
  after the frontend restart. `pytest`/`tsc`/`eslint`/a real production
  build all clean.

**"Already available" models — a same-session follow-up, off a real
misunderstanding worth recording.** The user's next message ("我的意思不是
去掉原来ollama的模型下载...") clarified they weren't asking to replace the
suggested-models/URL-download flows — they wanted an ADDITIONAL way to
pick from whatever's already sitting in the bundled Ollama instance,
regardless of how it got there (pulled via this app, imported from a
custom file, or installed some other way entirely — e.g. an owner who
mounted in a pre-existing `~/.ollama` directory or ran `ollama pull`
directly against the container). A follow-up framing ("...ollama除了自己的
目录，还可以有补充目录") asked about a second Ollama model directory —
clarified directly rather than assumed: **Ollama itself has no concept
of multiple model directories** (one internal blob store,
`OLLAMA_MODELS`-configurable but still a single path, not a search
list) — `../models/` was never a second Ollama directory, just a staging
area `import-custom` copies FROM into Ollama's own store via `ollama
create`. The actual fix for what the user wanted was surfacing what's
already inside that one store, not adding a second one:
- **`POST /agent/ollama/verify-installed`** (`{model}`) — for a model
  already in `OllamaStatus.installed_models` (from `/api/tags`), runs
  the same real chat-completion verification every other path in this
  module uses before letting the frontend commit it as the active chat
  model. Deliberately NOT a rubber-stamp — "already downloaded" isn't
  the same guarantee as "behaves like a working chat model" (an
  embedding-only model, or a corrupted download, would both still
  appear in `/api/tags`).
- **`OllamaModelManager` gained an "Already available" section** above
  the suggested-models grid — one button per installed model, no
  download/pull step, just verify-then-select. Refreshed after a new
  pull or import completes (`refreshStatus()`, called before
  `onConnected()`) so a freshly-added model shows up here without
  needing a page reload.
- **Verified end-to-end against the real running stack, both the
  failure and success cases**: `verify-installed` against the already-
  installed `nomic-embed-text:latest` (embedding-only) correctly
  surfaced Ollama's own real 400 rejection; against a freshly re-pulled
  `llama3.2:latest` correctly returned `{"ok": true}`. `GET /status`
  correctly listed all 3 real installed models
  (`llama3.2:latest`/`llama3.2-tuned:latest`/`nomic-embed-text:latest`)
  before cleanup. Test models removed after; owner's real `custom`
  settings confirmed untouched throughout. `pytest`/`tsc`/`eslint`/a
  real production build all clean.

### Model settings panel polish — status, testing, density, cleanup (`frontend/src/components/modules/model-settings-panel.tsx`)

Added 2026-09-09, same session, off the user's own direct review request
("你觉得模型这个section做好了吗？") — five real gaps identified in a self-
critique and then fixed one by one, per the user's own follow-up ask:

1. **At-a-glance status summary** — a new block at the top of the panel
   (`StatusLine` × 4: Chat/Vision/Embedding/Image generation) shows each
   capability's current provider/model plus whether it's actually
   `selectable` right now, derived from data the panel already fetches
   (`capabilityStatus(options, value)`) — no new request. Before this,
   an owner had to mentally parse four separate dropdowns to answer "is
   my chat model actually working."
2. **"Send test chat message" button** — the one gap that mattered most:
   every OTHER provider-config surface in this app (Payment,
   Notification, Map, the custom-endpoint blocks here) already has a
   "test it now" action; the chat/vision/embedding pickers themselves
   never did, so a bad cloud API key was only ever discovered when a
   real visitor's turn failed. `lib/models.ts`'s `testChatCompletion(
   message)` reuses the already-real `POST /agent/chat-completion`
   proxy (the same one owner-agent's own brain calls go through) — no
   backend change needed. Deliberately tests the SAVED configuration,
   not an in-progress unsaved edit (same "edit then save, no live
   preview" posture the rest of this panel already has) — the button's
   own caption says so plainly. **Immediately proved its worth in live
   verification**: calling it against the real dev instance's actual
   saved `custom` provider (the owner's own local llama.cpp endpoint,
   not currently running) correctly surfaced "All connection attempts
   failed" — exactly the kind of silent failure this button exists to
   catch before a real visitor hits it.
3. **"Already available" models can be deleted, not just selected**
   (item 4) — `POST /agent/ollama/delete-model` (real DELETE against
   Ollama's own `/api/delete`, reporting a genuine failure back rather
   than `_delete_model`'s existing best-effort-swallow variant used
   elsewhere in that module for internal cleanup) + a trash-icon button
   next to each installed-model button in `OllamaModelManager`, behind
   `window.confirm` (same no-undo-delete posture `CrmPanel`/`PageManager`
   already established). Closes a real disk-space gap: before this, an
   owner who tried several models over a session's lifetime had no way
   to remove old ones short of a shell into the container.
4. **Local models (Ollama) and both custom-endpoint blocks are now
   collapsible, closed by default unless already in use** — a new
   `CollapsibleSection` (collapsed unless `defaultOpen` says the
   relevant capability is already set to `"ollama"`/`"custom"`,
   `useState`'s initial value only — doesn't fight a user who
   explicitly toggled it afterward) wraps: the whole Ollama manager
   section, the chat/vision custom-endpoint block, and the embedding
   custom-endpoint block. A cloud-only owner no longer sees three
   permanently-expanded sections of config they never touch.
5. **(Density, general)** — items 3+4 together are the concrete fix for
   the 5th, more diffuse critique ("this panel shows every provider's
   config at once regardless of what's actually in use") — the
   ComfyUI-specific fields were ALREADY conditionally shown only when
   `image_provider === "comfyui"` (confirmed by re-reading that code
   before assuming a fix was needed there too), so the two custom-
   endpoint blocks and the Ollama manager were the actual remaining
   offenders, both now addressed by the same `CollapsibleSection`.
- **Verified end-to-end against the real running stack**: the test-chat
  button's real failure case above; `delete-model` — deleted the real
  installed `nomic-embed-text:latest`, confirmed it vanished from
  `GET /status`, confirmed a second delete attempt correctly 404'd
  rather than silently no-op'ing, then re-pulled it to restore the
  dev instance's own useful default. Owner's real `custom` chat/vision/
  embedding settings confirmed untouched throughout every step.
  `pytest`/`tsc`/`eslint`/a real production build all clean.

### URL-based document ingestion + scheduled tasks (`backend/scheduler.py`, `backend/apis/scheduled_tasks.py`)

Added 2026-08-21, same day as the chat-prompt feature above, off a real
scenario the user posed directly: a lawyer wants the system to know
every local law/regulation, too many to upload one file at a time — give
it a government URL (or a batch of them) and let it fetch and embed
automatically, ideally re-checked daily since regulations change. Two
genuinely separate pieces, deliberately built as two separate pieces:
fetching-and-embedding a URL, and running something on a recurring
schedule. The second one generalizes far beyond documents — the user's
own framing, unprompted: "需要cron的可能不单单是embed，还有可能是email，crm等
其他事项" (things that need a schedule aren't just embedding — could be
email, CRM, other things too) — so `ScheduledTask` was built as a
generic mechanism from the start, not a document-specific timer bolted
onto `apis/documents.py`.

- **Scope, confirmed directly with the user before building**: one URL =
  one document (`str | list[str]`, auto-detected server-side — the exact
  shape the user asked for, "code自己分析是str还是array"), never a full
  site crawler. A generic web crawler (follow links, handle pagination/
  search UIs, respect robots.txt, rate-limit itself) is a fundamentally
  different, much larger feature with real legal/ToS risk when aimed at
  a government site at scale — explicitly ruled out; the owner (or
  owner-agent, on their behalf) adds each specific regulation URL
  individually, the same granularity as adding a file. Repealed/
  proposed-but-not-passed law status was raised by the user as a real
  concern but explicitly left unresolved ("我还在构想这部分应该怎么做") — no
  schema decision was forced; `Document.tags` (mirroring `Product.tags`)
  is the natural extension point whenever that design lands.
- **`_fetch_url_content` (`apis/documents.py`)** — a PDF/DOCX response is
  passed through as raw bytes into the exact same `ingest.parse_document`
  an upload uses; anything else is treated as HTML and run through
  `trafilatura.extract(favor_recall=True, include_tables=True)` first,
  since `parse_document` has no HTML support of its own (a new
  dependency — `trafilatura`, which pulls in a real transitive tree:
  `courlan`/`dateparser`/`htmldate`/`justext`; accepted as the right
  tradeoff over hand-rolling HTML content extraction). **Real, load-
  bearing finding from live testing, not a hypothetical**: the default
  httpx User-Agent (`python-httpx/x.x.x`) got a flat 403 from Wikipedia
  — a real site, not an edge case — while a plain browser-shaped
  `User-Agent` string worked immediately; government/legal-database
  sites commonly run similar WAF-level bot filtering, so
  `_FETCH_USER_AGENT` is set explicitly rather than left at httpx's
  default. The extracted text (not the raw HTML) is what gets saved to
  `STORAGE_DIR` as the document's own "raw file" (content_type
  `text/plain`) — a deliberate choice: it lets `reembed_all_documents`'s
  already-existing generic re-parse-from-disk logic work completely
  unchanged for a URL-sourced document too, with zero special-casing.
- **Runs as a background task, not synchronously like `ingest_document`**
  — `ingest_document`'s own docstring already flagged synchronous
  ingestion as a scaling limit ("a real background job queue would be
  the next step for anything large enough to time out a request");
  large/many legal documents is exactly that case. `POST .../ingest-from-
  url` creates each `Document` row immediately (`status: pending`) and
  returns right away; `_run_url_ingest` (fetch → parse → chunk → embed →
  `status: ready`/`error`) runs via FastAPI's `BackgroundTasks`, with its
  own `SessionLocal()` session (the request's own `db` is already closed
  by the time a background task runs). This matters specifically because
  this app runs a single uvicorn worker (`rate_limit.py`'s own
  docstring) — a long synchronous request here would have blocked that
  worker, including the public `/api/chat` path, the same class of
  concern `resource_broker.py` already protects against elsewhere.
  Progress is watched via the exact same `pending → processing →
  ready/error` status `DocumentManager` already renders — no new
  progress UI needed. Embedding itself is already batched per document
  (`EmbeddingProvider.embed(texts: list[str])` takes the whole chunk
  list in one call, confirmed by reading the interface, not assumed) —
  speed for a large corpus is bounded by the embedding provider's own
  throughput, not per-chunk round-trips.
- **`POST /agent/documents/{id}/resync`** — manual on-demand re-fetch for
  an existing URL-sourced document (400s on a plain upload, which has no
  `source_url`); same background-task mechanism, and what
  `resync_url_document`'s scheduled-task type calls under the hood.
- **`ScheduledTask` (`models.py`) — a generic recurring-task table, not
  embed-specific**, the direct response to the user's own generalization.
  `task_type` is a dispatch key into `scheduler.TASK_REGISTRY`; the four
  registered this round (`resync_url_document`, `reembed_all_documents`,
  `cleanup_chat_uploads`, `cleanup_stale_crm_entries`) are all thin
  adapters over functions that already existed — adding a future
  schedulable action (an eventual scheduled email, say) is a small
  registry entry, not new logic. `cron_expression` is standard 5-field
  cron syntax, validated via APScheduler's own `CronTrigger.from_crontab`
  — no custom scheduling DSL invented.
- **The first background-job infrastructure this project has needed** —
  every prior "maintenance action" in this app (`cleanup_orphaned_
  uploads`, `crm_retention.cleanup_stale_crm_entries`, `reembed_all_
  documents`) was manually-triggered-only specifically because no
  scheduler existed (see those features' own AGENTS.md entries). An
  in-process `AsyncIOScheduler` (`backend/scheduler.py`) now runs inside
  the backend container itself — no separate worker process/container —
  started via `main.py`'s `lifespan` context manager (replacing the
  bare `FastAPI()` this project had used until now), loaded from every
  `enabled=True` `ScheduledTask` row at startup. The CRUD API calls
  `scheduler.sync_job`/`remove_job` after every create/update/delete so
  a change takes effect immediately, without an app restart. Dev-mode
  `--reload` restarts the whole worker (and therefore the scheduler) on
  every code change — harmless, jobs reload fresh from the DB on the
  next startup, worth knowing if `last_run_at` looks like it skipped a
  beat during active development.
- **Two independent, equally-authoritative interfaces onto the same
  table** — directly satisfies what the user actually asked for
  ("可以给owner让agent去安排和写code，有或者做一个cron的api可以修改和显示的" — these
  read as two competing options but resolve to one mechanism with two
  front doors): `POST /agent/scheduled-tasks` (the CRUD API,
  `ScheduledTasksPanel` in the dashboard) and owner-agent's new
  `manage_scheduled_task` tool (owner-agent's tool count now 20, up from
  17 — also gained `ingest_documents_from_url` and `list_scheduled_
  tasks`, the latter so the model checks what already exists before
  guessing, same `list_intent_schemas` precedent). **`POST
  /agent/scheduled-tasks` is create-or-update BY NAME, not a plain
  create** — the exact same `upsert_intent_view` precedent
  `apis/intent_schemas.py`'s `POST /agent/intent-views` already
  established: owner-agent has no memory of a numeric id across separate
  `/run` calls, so "actually run that every Monday instead" needs to
  find and update the SAME row by the name the owner already gave it,
  never create a duplicate. The dashboard's own `PUT .../{id}` stays
  id-based, for editing a row it already has in hand.
- **`POST /agent/scheduled-tasks/{id}/run-now`** — bypasses the cron
  schedule entirely for an immediate, awaited (not backgrounded) run, so
  the response reflects the real `last_run_status`/`last_run_error`
  rather than an unverifiable "started" — lets an owner confirm a
  newly-created task actually works without waiting for its next
  scheduled fire. Same "budget minutes, not seconds" tradeoff this app
  already accepts for `generate_landing_page`/ComfyUI generation when the
  underlying task type is slow.
- **`ScheduledTasksPanel`** (frontend, "Knowledge base" accordion
  group — renamed from "AI & knowledge base" 2026-09-09 once
  `ModelSettingsPanel`/`ChatPromptSettingsPanel` split into their own
  groups — alongside `DocumentManager`, its motivating use case, though
  the mechanism itself is generic) — `task_args` is a plain JSON
  `Textarea`, not a dynamic per-task_type form; the simplest thing that
  works at this app's current task-type count, same posture as
  `business_hours`'s own plain-`Textarea` editor elsewhere in this app.
- **`DocumentManager` gained an "Add from URL" `Textarea`** (one URL per
  line, `ingestFromUrl` accepts either shape directly) and, per document,
  a source-URL link + a "Re-sync" icon button shown only when
  `source_url` is set.
- **Verified end-to-end against real external sites, not mocked** — a
  real Wikipedia article (22KB extracted, 32 chunks) and `example.com`
  both correctly fetched, extracted, chunked, and embedded to `status:
  ready` via a real local embedding provider; manual re-sync and the
  `resync_url_document` scheduled-task path (create → run-now → verify
  `last_run_status: "success"`) both confirmed live; the 403-then-fixed
  User-Agent finding above was caught this way, not assumed. Scheduled-
  task CRUD verified end-to-end: invalid cron and unknown task_type both
  400 with a clear message, `run-now` against a real `cleanup_chat_
  uploads` task correctly executed and recorded `last_run_status:
  "success"`, delete correctly removes both the DB row and its
  APScheduler job. `tsc`/full-source `eslint`/`pytest`/a real production
  build all clean.

### Document classification: company material vs. reference (`Document.is_company_material`)

Added 2026-08-21, same day and same conversation as the URL ingestion
work above — a direct follow-up question from the user ("我在想要不要给embed
分类") that turned into a concrete, motivating example: for a lawyer's
practice, a jurisdiction's own constitution/statutes are documents the
chatbot genuinely needs to know about, but they are NOT facts about the
lawyer's own business — very different from a service-description
document, which is. The user's own framing was explicit about the
intended chatbot behavior too: the public chatbot should "知法" (know the
law, at a general level) but not give the kind of precise detail a real
consultation would ("llm没有律师证，律师也需要赚钱" — the LLM doesn't hold a law
license, and the lawyer needs to earn a living too) — "断章" (excerpted/
general, novel-style), never a substitute for a real consultation. But
this restraint is specifically for the PUBLIC chatbot; the user was
explicit that owner-agent should keep trying to fully answer whatever
the owner (the lawyer themselves) actually asks it.

- **`Document.is_company_material: bool`** (default `True` — every
  existing and future document behaves exactly as before unless
  explicitly marked otherwise) — a boolean flag, not free-text tags,
  same "one hard signal, not inferred from free text" posture already
  used for `Order.is_open`/`OrderItem.served` elsewhere in this app.
  `True` means "this document states facts about the business itself";
  `False` means "background reference material the business operates
  within but doesn't own" (a law, a regulation — the motivating case).
- **Two real, different consumers of the same flag — a genuine split,
  not one behavior applied twice**:
  1. **`_gather_ready_document_text` (`apis/agent.py`) now only includes
     `is_company_material=True` documents.** This function feeds
     `generate_geo_page`, `detect_business_type`, `propose_intent_schema`,
     and `business_profile.py`'s suggest endpoint — all four synthesize
     "who is this company" content, and a reference document like a
     statute isn't a company fact; feeding it in would have let the GEO
     page or the business-type detector represent the law's own content
     as if it were something about the business. Verified directly (not
     assumed): with one real company-material document and one
     reference-only document both `ready`, `_gather_ready_document_text`
     correctly returned only the company-material one, and its text
     correctly excluded the reference document's own content.
  2. **Ordinary RAG retrieval (`retrieval.py`'s `retrieve()`, feeding
     `/api/chat`) is completely unaffected — still searches every ready
     document regardless of this flag.** A visitor can still legitimately
     ask about the referenced law; the flag doesn't hide it from
     retrieval, it changes how the excerpt is *framed* to the model:
     `apis/chat.py`'s context-block formatting appends "— background
     reference material, not a fact about this business" to a
     non-company-material excerpt's own citation line, and `SYSTEM_PROMPT`
     gained an explicit clause telling the model what that marker means
     — usable for a general, accurate answer, never presented as the
     business's own claim, and for anything needing precise/professional-
     level detail, say plainly that a qualified professional should
     confirm the specifics rather than answering with full certainty.
     Deliberately generic wording (not "consult a lawyer" hardcoded into
     the built-in default) — this default prompt serves any business
     type, not just legal practices; a lawyer-owner who wants stricter or
     domain-specific wording has the already-built
     `chat_system_prompt` override (see "Owner-configurable public-chat
     system prompt" above) to say exactly that.
  3. **Owner-agent needs no changes at all for "should still answer the
     owner fully"** — its own "brain" prompt (`owner-agent/agent_loop.py`)
     has never shared anything with `apis/chat.py`'s `SYSTEM_PROMPT`/
     `_resolve_system_prompt` to begin with, so the public-chat-specific
     restraint above was never something owner-agent inherited in the
     first place. Worth stating plainly since it wasn't obvious without
     tracing the actual code path — confirmed by reading both prompt
     paths, not assumed from the architecture alone.
- **Settable at ingest time** (`IngestDocumentRequest.is_company_material`/
  `IngestFromUrlRequest.is_company_material`, both default `True`) **and
  toggleable after the fact** (`PATCH /agent/documents/{id}`, mirrors
  `OrderItem`'s own `served` PATCH-toggle pattern) — a document doesn't
  have to be re-ingested just because its classification was wrong the
  first time.
- **`DocumentManager` gained a `Switch` in both the upload form and the
  "Add from URL" form** ("This states facts about the business itself"),
  plus a clickable per-document `Badge` ("Company info"/"Reference
  material") that toggles the flag via the new PATCH endpoint — no
  separate edit form needed for a single boolean.
- **Verified end-to-end**: `_gather_ready_document_text`'s filtering
  confirmed directly via a real Python call inside the container (not
  just code review) against real ingested documents; `retrieve()`
  confirmed to still return a reference-only document's chunks with
  `is_company_material: False` correctly attached; the PATCH toggle
  round-trips correctly. `tsc`/full-source `eslint`/`pytest`/a real
  production build all clean.

### Document status notes — an industry-agnostic framework (`Document.status_note`)

Added 2026-08-21, same conversation, one more turn past
`is_company_material` above. The user explicitly generalized the
motivating legal example first ("法律只是一个例子，但是世上行业太多") and asked
to design the framework together rather than have me guess at a legal-
specific taxonomy — a real, deliberate design discussion, not a rubber-
stamped feature.

- **The framework decision**: free text, not a fixed enum, and NOT
  scoped to legal status specifically. This mirrors a pattern this app
  already leans on repeatedly for exactly this "every owner's vocabulary
  is different" problem — `CrmEntry.status`/`Order.status`/
  `IntentView.status_options` are all owner-defined free text, never a
  hardcoded per-industry enum. A rigid `"repealed"|"in-force"|"proposed"`
  enum would only fit law; a different owner might need
  `"discontinued"`/`"superseded form"`/`"experimental"` for an entirely
  different industry, and a fixed enum would need re-litigating every
  time a new vertical showed up. `Document.status_note: str | None` —
  the owner (or an LLM draft, see below) writes whatever sentence
  actually matters ("Repealed 2024-01-01, replaced by SB-123",
  "Discontinued policy form, still applies to policies issued before
  2020"), and the model reads it directly rather than this app trying to
  encode what any particular status word means.
- **Two ways to set it, same posture as everywhere else propose-vs-
  direct-write matters in this app**: owner-typed directly (upload form,
  URL-ingest form, or edited after the fact via the same `PATCH
  /agent/documents/{id}` `is_company_material` already uses, both now
  optional-independent fields — omit a field to leave it untouched,
  an explicitly empty string clears `status_note`, same "blank clears"
  convention as `chat_system_prompt`), or an opt-in LLM-suggested draft
  (`suggest_status_note` on `IngestDocumentRequest`/`IngestFromUrlRequest`/
  `resync_document`, and `resync_url_document`'s own `task_args`) via
  `_suggest_status_note` (`apis/documents.py`) — **deliberately
  conservative**, mirroring `business_profile.py`'s `suggest_business_
  profile`'s "don't invent facts" discipline exactly: the prompt tells
  the model to respond with the literal word `NONE` unless the source
  text explicitly states its own status, never to guess one. Per-URL,
  not per-batch, for the URL-ingest case — a batch of statutes
  plausibly has a genuine mix of current/repealed/proposed sources, so
  each gets classified independently against its own text.
- **Where it surfaces**: `apis/chat.py`'s new `_chunk_source_note`
  composes `is_company_material`'s marker and `status_note` into one
  citation-line qualifier (both can apply to the same chunk
  independently); `SYSTEM_PROMPT` gained a clause telling the model to
  factor a status note directly into its answer — don't state a
  repealed/superseded/withdrawn rule as still in effect, mention the
  status when it's relevant — rather than treating every excerpt as
  unconditionally current. `_gather_ready_document_text` (feeding
  `generate_geo_page`/etc.) also includes the note in each document's
  block header, for consistency.
- **Real, live end-to-end test — not just a code-review check, per the
  user's own explicit ask to verify the actual hypothesis**: ingested a
  synthetic municipal ordinance whose own text explicitly states "This
  ordinance was REPEALED effective January 1, 2024, and replaced by
  Ordinance 55-C" with `suggest_status_note: true` — the model correctly
  extracted "Repealed effective January 1, 2024, and replaced by
  Ordinance 55-C." A second ordinance with NO status statement in its
  text correctly came back with `status_note: null` (confirming the
  "never guess" discipline holds, not just the "correctly detects a
  real one" half). Then a REAL `/api/chat` call asking specifically
  about the repealed ordinance's own fee got the correct number
  ($2.00/hour) **and proactively surfaced the repealed status and
  replacement ordinance's new fee ($3.50/hour)**, unprompted — direct
  confirmation that the status note changes actual model behavior, not
  just stored metadata. A control call asking about the still-current
  ordinance got a clean, direct answer with no unnecessary hedging —
  confirming the mechanism doesn't over-apply caution when there's
  nothing to flag. `tsc`/full-source `eslint`/`pytest`/a real production
  build all clean; test documents cleaned up after.

### Social login (Google/Facebook/X OAuth) + self-service account view + user management (`backend/apis/oauth.py`, `backend/apis/my_account.py`, `backend/apis/users.py`)

Added 2026-08-22, off a direct user ask: real user management, admin
permissions, and a way for ordinary visitors to sign in via a big-tech
OAuth provider (Google/Facebook/X) instead of a password. The user
raised one real open question themselves — should admin/owner also use
OAuth — which I raised back with a recommendation before building
anything, and the user confirmed it: **admin/owner stay on the existing
password+JWT system, forever; OAuth is for the public `user` tier
only.**

- **Why admin/owner never use OAuth, confirmed directly with the user**:
  admin/owner accounts hold real privilege (the whole agent console +
  owner-agent) — tying them to a third-party identity provider means
  their account security AND recovery now depends on that provider (a
  locked/compromised/deleted Google account could mean losing access to
  this app's own admin panel with no independent recovery path). This
  app's own password+JWT system is already fully self-controlled
  (`JWT_SECRET` rotation, `backend/auth.py`'s own signing) — realistically
  there are only 1-2 admin/owner operators, so password management isn't
  the friction problem OAuth actually solves. OAuth's real value is for
  potentially many one-time public visitors who don't want to create yet
  another password — exactly the `user` role's own scope, which is
  where it was built.
- **Google first, as the reference implementation, then Facebook and X
  the same day** (2026-08-22, on a direct follow-up ask: "把FB和X也准备
  好接口"). Facebook turned out to be almost exactly the predicted "same
  shape once Google's proven" — same authorization-code grant, only real
  difference is Facebook's token exchange is a GET with query params
  where Google's is a POST body. **X was NOT a drop-in**, confirmed
  correct in advance: X requires OAuth 2.0 with PKCE (an extra
  `code_verifier` generated per attempt and stashed in its own
  short-lived cookie alongside the CSRF `state` one, `S256`-challenged),
  and — the real, load-bearing constraint — **X's standard API does not
  reliably return an email address at all**. Getting one needs an
  elevated permission from X's own Developer Portal that X does not
  guarantee approving, entirely outside this app's control. Built and
  wired up anyway, since the user explicitly asked for the interface to
  exist and be ready, but disclosed honestly in three places rather than
  silently assumed to work: `apis/oauth.py`'s own module docstring,
  `OAuthSettingsPanel`'s X block (a warning paragraph, not just a form),
  and `_x_fetch_email`'s own error message when the userinfo response
  really does come back with no `confirmed_email`.
- **Shared `_finish_oauth_login(db, email, provider)` helper** — factored
  out once a second provider existed, so the `email_verified`
  reclaim-vs-merge logic (see below) lives in exactly one place instead
  of being copy-pasted three times with a real risk of the copies
  drifting apart. Every provider's callback ends by calling this one
  function with whatever email it resolved and its own provider name
  string (`"google"`/`"facebook"`/`"x"`) — the only thing that varies
  across providers is how that email gets resolved in the first place.
- **`backend/apis/oauth.py` — the actual flow** (standard OAuth2
  authorization-code grant, no new pip dependency, plain `httpx` calls
  to Google's own token/userinfo endpoints):
  1. `GET /api/auth/oauth/google/start` — 503s with a clear message if
     unconfigured; otherwise builds Google's own authorize URL (with
     `prompt=select_account` so a returning visitor gets a real account
     picker rather than being silently re-logged-in as whoever they used
     last) and redirects the browser there, stashing a random CSRF
     `state` nonce in a short-lived httponly cookie (a plain unguessable
     value is sufficient — its only job is proving the callback belongs
     to a redirect this backend itself just issued, no need to sign it).
  2. `GET /api/auth/oauth/google/callback` — verifies the returned
     `state` matches the cookie, exchanges the code for an access token,
     fetches the verified email from Google's userinfo endpoint (refuses
     an explicitly `email_verified: false` response), finds-or-creates a
     `User` row **by email**, **always with `role: "user"` for a new
     account** — this path can never create or promote an admin/owner,
     a hard rule enforced in code, not just an unset default — then
     issues this app's own JWT via the exact same `create_access_token`
     the password login already uses. OAuth is genuinely just an
     alternate way to prove identity before this app takes over session
     management with its own token, never a replacement of the JWT
     system itself.
  3. Redirects back to `/login?oauth_token=...` (or `?oauth_error=1`) —
     mirrors the `?sid=` cart-recovery query-param-handoff pattern
     already established in this app (`SessionIdBootstrap`); `LoginForm`
     picks up the token, calls `GET /auth/me` with it to resolve
     email/role (deliberately NOT stuffed into the same URL — a
     bookmarked/shared login link shouldn't leak a readable profile
     summary alongside the token), then `setAuth` + redirect to
     `/dashboard`.
  - **Every failure in the callback redirects to a clean
    `?oauth_error=1`, never a raw 500** — the visitor is mid-browser-
    redirect at this point, not making a fetch call a frontend error
    handler could catch.
- **`AppSettings.google_oauth_client_id`/`google_oauth_client_secret`**
  — same owner-configured-credentials pattern as Stripe/Mailgun/Twilio/
  Maps: `client_secret` write-only (never echoed by `GET
  /agent/oauth-settings`), `client_id` safe to echo (it's embedded in
  the browser-visible authorize-URL redirect anyway, same posture as
  Stripe's own publishable key). No separate "enabled" flag — derived
  from both being set, same posture as `is_email_configured`.
  `OAuthSettingsPanel` (frontend, new "Users & access" accordion group —
  didn't fit any existing group, and this is the first real
  user-management-adjacent admin feature, likely to grow) shows the
  exact callback URL to paste into Google Cloud Console, mirroring
  `PaymentSettingsPanel`'s own webhook-URL display.
- **`User.hashed_password` widened to nullable, `User.oauth_provider`
  added** — an OAuth-only account has no local password at all;
  `apis/auth.py`'s password login now explicitly guards against a null
  `hashed_password` (always fails that path for an OAuth-only account,
  correctly — its only real login path is OAuth). Identity matching
  across a re-login is by **email alone**, not a stored per-provider
  subject id — a deliberate v1 scope decision for this app's
  single-tenant scale, not a rejected-then-reconsidered design.
- **A genuinely new gate: `apis/deps.py`'s `require_authenticated_user`**
  — distinct from both `get_current_user` (never rejects, so the
  tool-free public chat keeps working anonymously) and `require_role`
  (admin/owner only). 401s unless a real JWT was presented, for **any**
  role — the exact shape "user isolation" needed: not "admin sees
  everything," not "fully public," but "any logged-in account sees only
  ITS OWN data."
- **`backend/apis/my_account.py` — "user isolation," the self-service
  half, directly motivated by the OAuth work** ("a social login only
  really matters if there's somewhere to see your own history
  afterward"): `GET /my/orders` (paginated, `Order.contact_email ==
  current.email`), `GET /my/crm-entries` (unpaginated — one visitor's own
  lead/claim history is realistically a handful of rows, unlike the
  admin-facing equivalent), `GET /my/chat-sessions` +
  `GET /my/chat-sessions/{id}/messages` — the last one 404s (not 403) on
  a session that exists but isn't the caller's own, same "don't confirm
  existence of something that isn't yours" posture as
  `apis/crm_resume.py`'s generic response. Every query filters by the
  caller's own email server-side — never a caller-supplied id trusted on
  its own. Reuses `apis/products.py`'s `OrderSummary`/`_to_order_summary`
  and `apis/agent.py`'s `CrmEntryResponse`/`_crm_entry_response` directly
  (the underscore-prefixed-import-across-modules pattern this codebase
  already established for `_gather_ready_document_text`) rather than
  duplicating those shapes.
- **`AccountPage` (`/account`, frontend)** — orders, requests (CRM
  entries), and chat history (expandable transcript, reusing
  `ChatMessageBubble` so a saved conversation reads exactly like it did
  live). Prompts to log in if not authenticated — not role-gated at all,
  since "see your own data" is meaningful for a `user`, `admin`, or
  `owner` account alike. `AuthStatus` (header widget) now links the
  visible email to this page when logged in.
- **Real, live end-to-end verification against the actual `/my/*`
  endpoints and real historical data**, not synthetic: unauthenticated
  calls to all three `/my/*` list endpoints correctly 401; logged in as
  the real `user@example.com` seeded account, `GET /my/chat-sessions`
  correctly surfaced its two genuinely pre-existing sessions from
  2026-08-08 testing (real historical data, not fixtures) with zero
  orders/CRM entries (accurate — none exist for that email); the
  transcript endpoint correctly served the caller's own session and
  correctly 404'd on both someone else's real session id and a
  nonexistent one, identically (no leak). OAuth settings CRUD, write-
  only-secret round-trip, and the unconfigured-503/configured-redirect
  transition all verified live; the `/start` redirect was confirmed to
  build a syntactically correct real Google authorize URL with the
  state cookie properly set (`HttpOnly`, `SameSite=lax`); the
  `/callback` route was confirmed to redirect cleanly to
  `?oauth_error=1` (never a raw 500) both for a CSRF state mismatch and
  for a fake authorization code that Google's own real token endpoint
  correctly rejected — the genuine-rejection-path verification pattern
  already established for Stripe/Mailgun/Twilio. **The one thing this
  session could not verify**: an actual successful "click through
  Google's real consent screen and land back logged in" round trip —
  that needs a real registered Google Cloud Console app, which only the
  user can set up; test credentials were used only to prove the
  mechanism reaches Google's real servers and handles both success-path
  construction and failure paths correctly, then cleared afterward.
  `tsc`/full-source `eslint`/`pytest`/a real production build all clean.
- **A real lint catch during this pass, same recurring class as before**:
  `LoginForm`'s OAuth-callback-handling effect originally called
  `setStatus`/`setError` directly in the effect body (both for the
  immediate-error branch and as an unconditional call before the async
  work started) — `react-hooks/set-state-in-effect` flagged both,
  even though the async branch's own `.then()`/`.catch()` callbacks were
  already fine. Fixed by moving every state update (including the
  "loading" one at the very top) inside a locally-defined async function
  that the effect merely calls — confirms the linter's actual heuristic
  is about lexical placement (is a setState call written directly in the
  effect's own body vs. inside a separately-defined function it invokes),
  not real runtime synchronicity, useful to know for the next time this
  class of warning shows up.

**`User.email_verified` — closed pre-emptively, same session, off the
user's own direct follow-up question**: "如果有人自己用邮件创建了账号，然后后来
又使用了google oauth，怎么办" (what happens if someone creates a password
account with an email, then later uses Google OAuth with the same
email). Traced the actual merge code and confirmed the real risk: this
app has no public password self-signup today (`apis/auth.py`'s own
docstring says so plainly), so the specific attack — an attacker
pre-registers a victim's email with a password *before* the real owner
ever tries Google, then silently retains access once OAuth's
find-by-email merge attaches to that same row — isn't exploitable yet.
The user's own call, explicit and direct: close it now anyway rather
than risk forgetting once self-signup eventually gets built. Added
`User.email_verified: bool` (default `False`, the cautious state for
any *future* account-creation path that doesn't explicitly reason about
this) — `True` only for a path with real proof of email ownership:
`seed.py`'s admin-provisioned demo accounts, and `apis/oauth.py`'s
Google callback for a brand-new row (Google itself verifies the email).
The callback's existing-user branch now checks it: an already-verified
row merges exactly as before (`oauth_provider` updated, password left
alone); an **un**verified row gets reclaimed — `hashed_password` wiped
entirely and `email_verified` flipped to `True` — Google's real
verification outranks whatever unverified password was sitting there,
and whoever set that old password loses access outright, not just
gains a second way in. The migration backfills `email_verified = true`
for every pre-existing row (all three seeded demo accounts, the only
users that exist as of this migration), so the fix doesn't accidentally
wipe a real seeded account's own password the first time its email is
used with Google. **Verified directly at the DB/logic level** (no real
Google credentials needed to prove this): seeded a simulated "landmine"
account (`email_verified=False`, a real password set) and replicated
the callback's exact merge branch — confirmed the password was wiped
and the account correctly reclaimed; then ran the identical logic
against the real, already-verified `owner@example.com` account and
confirmed its password was left completely untouched, plus a live
regression check that password login still works afterward. Test data
cleaned up; `pytest`/`tsc`/`eslint` all clean, no frontend changes
needed for this fix — pure backend logic.

**Facebook and X OAuth (2026-08-22, same session as the fix above)** —
`AppSettings` gained `facebook_oauth_client_id`/`_client_secret` and
`x_oauth_client_id`/`_client_secret`, same write-only-secret pattern as
Google's own fields. `OAuthProvidersResponse`/`OAuthSettings` widened to
report all three; `OAuthSettingsPanel` now renders three stacked blocks
(Google/Facebook/X) sharing one Save button, mirroring
`NotificationSettingsPanel`'s existing Email/SMS shape exactly rather
than inventing a new multi-provider layout. `LoginForm` now shows a
button per configured provider (was a single Google-only conditional) —
its OAuth-callback-handling effect and error message are both now
provider-agnostic ("Social sign-in failed" rather than "Google sign-in
failed"), since the same `/login?oauth_token=...`/`?oauth_error=1`
redirect now lands here from any of the three. Verified live end-to-end:
`GET /agent/oauth-settings` and `GET /auth/oauth-providers` both
correctly report all three providers; a PUT with test Facebook/X
credentials round-tripped correctly (client_id echoed, secret never
echoed, only a `*_client_secret_set` boolean); test credentials cleared
afterward. `tsc`/full-source `eslint`/`pytest`/a real production build
all clean.

### User management (`backend/apis/users.py`)

Added 2026-08-22, same session, the second half of "把FB和X也准备好接口，
然后做user的用户管理版面" — the admin/owner-facing counterpart to
`apis/my_account.py`'s self-service `/my/*` routes: instead of "my own
data," this is "every account in the system."

- **Listing is admin+owner** (`GET /agent/users`, paginated — matches
  this app's usual read-access bar; most of `agent-console-section.tsx`'s
  panels are already admin+owner-viewable), **every write (create, role
  change, delete) is owner-only** — a role change or account deletion is
  a genuinely higher-stakes action than anything an admin panel
  elsewhere in this app lets an admin do alone, the same trust split
  `owner-agent`'s schema-proposal flow already established for "this
  changes what data/access looks like going forward." `UserManagementPanel`
  (frontend) reflects this directly: an admin sees a read-only list
  (role shown as a plain `RoleBadge`, no create button, no delete), an
  owner sees the full create form + a per-row role `Select` + delete.
- **Creating a user here is a real, trusted account-provisioning path**
  (`POST /agent/users`) — mirrors `seed.py`'s own reasoning exactly: an
  owner personally setting a password for a new account is proof enough
  of intent/ownership to mark `email_verified=True` immediately, skipping
  the "first login reclaims an unverified password" dance `apis/oauth.py`
  has to handle for a self-service signup this app doesn't even have.
  This is NOT a public signup endpoint — no route in this module is
  reachable without an owner's own JWT.
- **Two safety guards, both enforced server-side, never just hidden in
  the UI (though the UI also disables the matching controls as a
  nicety)**: an owner can never change their own role or delete their
  own account (`PATCH .../role`/`DELETE` both 400 on `user.email ==
  current.email` — closes the "the only owner locks themselves out"
  failure mode), and the system can never be left with zero
  `role == "owner"` accounts (`_remaining_owner_count`, a fresh `COUNT`
  query on every single role-change/delete call, never cached — checked
  against the DB as it stands right now, not against any JWT's own role
  claim). Either guard alone would still leave a real footgun the other
  one catches (self-modification alone doesn't stop a *different* owner
  from demoting the last remaining one; the last-owner count alone
  doesn't stop the sole owner from demoting themselves).
- **A real bug caught and fixed during verification, worth remembering
  for the next owner-only write route that also needs the caller's own
  identity**: the three write routes were originally typed as `current:
  CurrentUser = Depends(require_role(Role.owner))` — but
  `apis/deps.py`'s `require_role(...)` dependency resolves to just the
  matched `Role` enum (see its own return type), not a `CurrentUser`.
  Calling `current.email` on a bare `Role` raised `AttributeError`,
  turning every write into a 500 — caught immediately via live testing
  (the very first role-change call), not left for later. Fixed with a
  new `_require_owner(current: CurrentUser = Depends(get_current_user))`
  dependency that checks `current.role != Role.owner` itself and returns
  the real `CurrentUser`, giving the route both the role gate AND the
  caller's own identity it actually needs for the self-modification
  checks above.
- **Verified live with a full, real permission/safety-guard chain, not
  just individual calls in isolation**: admin token 200s on list, 403s on
  create; owner token creates a real test user, promotes it to owner,
  logs in AS that new owner and successfully demotes the original owner
  (2 owners existed, allowed); the now-demoted original owner (still
  holding its OLD, stale JWT claiming `role: owner` — a real, expected
  consequence of this app's stateless-JWT design, not a bug: a role
  change only takes effect on the affected account's *next* login/token
  issuance, same as `JWT_SECRET` rotation invalidating old tokens)
  correctly gets blocked from demoting the new owner by the **live DB
  count**, not by its own stale token claim, confirming the last-owner
  guard reads real current state rather than trusting anything JWT-
  encoded; self-role-change and self-delete both correctly 400 on their
  own account; the test owner is restored to the original role
  afterward, the temporary account deleted, and the final `GET
  /agent/users` list confirmed to exactly match the original 3 seeded
  accounts. `tsc`/full-source `eslint`/`pytest`/a real production build
  all clean; `UserManagementPanel` wired into `agent-console-section.tsx`'s
  existing "Users & access" accordion group, above `OAuthSettingsPanel`.

### Cross-session CRM resume via emailed code (`backend/apis/crm_resume.py`)

Added 2026-08-20, immediately after the email gate above, closing a real
gap flagged much earlier this session (see "Chat lead capture"'s
"Cross-session continuity is a known, deliberately deferred gap" bullet)
and explicitly unblocked by the user once email existed: "现在可以接起来的，
但是需要有识别，是否有效smtp或具备发邮件功能，才能够启动这个功能" — build it, but
gate it on real, working email actually being configured.

- **The gap this closes**: `apis/chat.py`'s `_find_active_entry` is
  deliberately scoped to one `chat_session_id` only (see that function's
  own docstring) — a visitor who abandons a multi-turn structured intake
  (an insurance claim mid-fill, say) in one browser session and returns
  in a new one (incognito closed, different device, cleared
  `localStorage`) previously had no way back to their own in-progress
  entry at all, even though it still existed in the DB. Trusting a
  re-typed email alone to reconnect them was explicitly ruled out back
  then — real PII sits behind this (incident details, phone, an
  attached photo) — hence the OTP requirement.
- **`apis/notifications.py`'s `is_email_configured(db)`** is the gate —
  `True` only when a real provider (not `"test"`) is selected AND has
  every credential it needs. Deliberately a cheap DB-only check, not a
  live connectivity probe on every call: the owner's own "Send test
  email" button is the real verification step for whether credentials
  actually work; this just checks the same config that button already
  validates. `POST /api/crm/resume/request` 503s immediately if this is
  `False` — there is no way to deliver a code otherwise, so the whole
  feature is correctly inert on a fresh install until an owner sets up
  a real email provider.
- **`CrmEntry.resume_code_hash`/`resume_code_expires_at`/
  `resume_code_attempts`** — added directly to the existing row, not a
  new table, matching the user's own explicit "改现有的，别开新表"
  preference from the dine-in kitchen-ticket feature earlier this
  session. The code itself is SHA-256 hashed at rest, never stored
  plaintext — held in memory only long enough to email it. A 6-digit
  code has just a million possibilities regardless of hash strength, so
  the real defense is the 10-minute expiry plus a hard 5-attempt cap
  (`MAX_RESUME_ATTEMPTS`), not the hash algorithm.
- **Two public, no-auth endpoints** (a visitor filing a claim was never
  asked to create an account, so this can't require one either):
  - `POST /api/crm/resume/request` — looks up the visitor's own most
    recent schema-linked `CrmEntry` by `contact_email` alone (see below
    — no `schema_key` needed), generates and emails a code if found.
    Returns the **identical, generic response whether or not a match was
    found** — a response that differed would let anyone probe "does this
    email have a request on file," a real enumeration/privacy leak.
    Verified live: a matching email and a made-up one produced
    byte-identical responses.
  - `POST /api/crm/resume/verify` — checks the submitted code against
    the stored hash, expiry, and attempt cap; on success, **rebinds
    `CrmEntry.chat_session_id` to the visitor's new session** — the one
    piece of real integration work, and it needed no changes to
    `apis/chat.py` at all: `_find_active_entry` already looks up by
    `chat_session_id`, so the very next chat turn in that new session
    picks the entry back up automatically, `_in_progress_context_block`
    and all. The code is single-use, cleared immediately on success.
    Verified live end-to-end: a wrong code correctly fails without
    consuming the real one; the correct code succeeds and returns the
    entry's real `collected_fields`; re-submitting that same
    (now-cleared) code afterward correctly fails; 5 wrong guesses lock
    the entry out even from the *correct* code on the 6th attempt
    (confirmed by directly inspecting the DB row); and the rebind itself
    was confirmed by querying the row afterward — `chat_session_id`
    pointed at the new session, matching the `session_id` the request
    carried.
- **Rate-limited at both steps** (`rate_limit.py`) — `/request` (5/hour)
  bounds how badly this could be used to spam a stranger's inbox with
  codes (the per-entry attempt cap doesn't help against this route,
  which needs no correct code, just an email address); `/verify`
  (15/15min) is the first line of defense against brute-forcing a code
  from one IP, with the per-entry attempt cap as the second line — one
  that survives even if a caller spreads guesses across many source IPs.
- **No `schema_key` needed — simplified 2026-08-20, same day as the
  original build.** The original cut required the caller to pass which
  schema (`insurance_claim` vs. `insurance_application`, say) alongside
  the email — but a real visitor-facing UI has no reasonable way to ask
  someone "which kind of request was it, by its internal key" (that key
  isn't even shown anywhere on the public site). `_find_resumable_entry`
  now just looks up the visitor's own most recent schema-linked
  `CrmEntry` by `contact_email` alone, across every schema — a visitor
  only ever has one thing in flight in practice, and the entry's own
  `collected_fields` make it obvious what it was once resumed. Both
  `ResumeRequestBody`/`ResumeVerifyBody` dropped the field entirely, a
  breaking (but pre-frontend-integration, so harmless) change to the
  request shape.
- **Deliberately NOT wired into the chat pipeline's own LLM-driven flow**
  — `apis/chat.py`'s lead-extraction logic still has no idea this
  exists, and that's by design, not a gap: the user's own original
  framing was explicit that the LLM doesn't need to know about this
  mechanism at all ("我觉得这一步没有必要让llm知道"). The frontend UI below
  calls both endpoints as plain REST, never through `sendChatMessage`.
- **Frontend UI, `frontend/src/lib/crm-resume.ts` +
  `chat/chat-panel.tsx`** — a collapsed "Continuing a previous request?
  Enter your code" link sits above the message composer; expanding it
  reveals a two-step inline form (email → code, each with its own
  Cancel). On successful verify, the entry's `collected_fields` are
  formatted into a short summary and pushed into the visible transcript
  as an assistant message (`pushMessage`) before the form collapses —
  this is the "compact summary, not full transcript copy" the user
  asked for; no RAG/embedding/retrieval infrastructure was needed for
  it, since `collected_fields` (the structured intent-schema data) was
  already exactly that compact summary — the resumed session never sees
  the old session's raw `ChatMessage` history.
- **Why a typed code, not a magic link** — considered and rejected: a
  clickable link mailed to the visitor is vulnerable to corporate email
  security scanners (Microsoft Defender and similar) that pre-fetch/
  pre-click links in incoming mail before a human ever opens it, which
  would silently burn a single-use resume link before the real visitor
  gets to it. A typed code sidesteps this entirely — nothing but the
  visitor themselves ever "clicks" it. This was the deciding factor in
  keeping the already-built typed-code flow instead of switching to a
  URL-based one (a `?sid=`-style link, matching cart recovery's own
  pattern, was considered and explicitly passed over for this reason).
- **Retention cleanup, `backend/crm_retention.py`** (2026-08-20, closes
  the retention question raised when this feature was first discussed —
  "这个离开的session留多长时间也是个问题，太多session怕造成攻击、负荷，不安全")
  — `cleanup_stale_crm_entries(db, dry_run)` purges abandoned,
  never-engaged (`status == "new"`) schema-linked `CrmEntry` rows past
  their own retention window. The user's own explicit split, confirmed
  directly: an entry with real `collected_fields` gets a 7-day grace
  period; one with essentially nothing collected yet gets only 24 hours
  (mirrors `chat_attachments.cleanup_orphaned_uploads`'s existing 24h
  precedent for the same "abandoned, nothing real lost" case). Both
  windows are **rolling from last activity** (`ChatSession.last_seen_at`,
  falling back to `CrmEntry.created_at` if the session row is gone), not
  a fixed deadline from creation — a visitor spread out over several
  days isn't cut off arbitrarily.
  - **Deliberately scoped to ONLY the `CrmEntry` row — never
    `ChatSession`/`ChatMessage`.** Those persist for `ReportPanel`'s own
    chat-volume reporting (session/message counts over time); deleting
    session rows here would silently corrupt that report. A real,
    considered scope boundary, resolved the same way the "should this
    also touch sessions" tension was explicitly reasoned through, not
    just narrowed silently.
  - Only ever touches an entry the owner has never engaged with
    (`status` still the default `"new"`) — anything already contacted/
    closed is a real business record `CrmPanel`/`ReviewQueuePanel`
    depend on, untouched by this.
  - No automatic scheduling (this project has no background job queue,
    same constraint `chat_attachments.py` already documents) — manually
    triggered only, via `POST /agent/crm/cleanup-stale-entries`
    (`dry_run` supported) or owner-agent's new `cleanup_stale_crm_entries`
    tool, same posture as `cleanup_chat_uploads`.
  - Verified live by seeding 4 synthetic `CrmEntry`/`ChatSession` pairs
    covering all 4 combinations of (empty/has-data) × (just-under/
    just-over threshold) directly into the DB, then running the cleanup
    endpoint in `dry_run` and for real: exactly the two past-threshold
    entries were deleted, the two under-threshold ones survived, and —
    confirming the scope boundary above — all 4 `ChatSession` rows
    remained fully intact afterward. Test data cleaned up after.

### Chat session/transcript viewer (`backend/apis/chat_sessions.py`)

Added 2026-08-21, off a direct user ask to close a long-standing,
explicitly-flagged gap: `ChatSession`/`ChatMessage` have persisted every
`/api/chat` turn since the very first session-logging work, but nothing
in the dashboard ever let an owner actually read one — only
`ReportPanel`'s own aggregate day-by-day counts existed. Purely a reader,
same "market research" posture `ChatSession`'s own docstring already
describes — nothing in the live chat path depends on this router, and
nothing in it writes anything.

- **`GET /agent/chat-sessions`** — paginated (`{items, total}`,
  most-recently-active-first), each row carrying a `message_count`
  computed via one grouped `COUNT` query across the current page's
  session ids (not N+1 per-session queries). `q` (optional) matches
  `session_key`/`user_email` — a real full-text search over message
  *content* would need its own index at any real scale and was
  deliberately left for later; this covers "find the session for a known
  visitor" today, the case that actually matters for reviewing a
  specific lead's conversation.
- **`GET /agent/chat-sessions/{id}/messages`** — paginated
  **oldest-first**, the opposite direction from every other paginated
  list in this app (which page backward from "most recent") — "page 1"
  of a transcript means "the beginning of the conversation," not "the
  latest activity," so pagination has to move forward through it instead.
  404s on an unknown session id.
- **`ChatSessionViewerPanel`** (frontend, "CRM & reporting" accordion
  group, alongside `ReportPanel`) — a paginated, searchable session list;
  "View transcript" opens a `Sheet` reusing `ChatMessageBubble` (the same
  component the real `/chat` page renders with) for each message, so a
  transcript reads exactly like the real conversation looked to the
  visitor, not a stripped-down log view. The transcript `Sheet` has its
  own independent pagination from the session list.
- **Real lint catch during this pass**: the search-box debounce
  originally used two separate effects — one to debounce `searchInput`
  into `searchText`, a second watching `searchText` purely to reset
  `page` back to 1 — mirroring `OrderPanel`'s own existing two-effect
  pattern. The second effect tripped `react-hooks/set-state-in-effect`
  here even though the identical-looking pattern in `order-panel.tsx`
  doesn't (a real, unexplained inconsistency in the lint rule's own
  heuristic, not a difference in the two files' logic — confirmed by
  running eslint on both files with an unrelated fresh flag to rule out
  a stale cache). Rather than chase the rule's exact trigger condition,
  fixed by removing the two-effect pattern entirely: `setPage(1)` now
  fires inside the SAME debounce `setTimeout` callback that updates
  `searchText`, so there's no longer a second effect watching derived
  state at all — the fix that's actually more correct anyway (page reset
  happens exactly when the debounced search value would change, not from
  a separately-reactive watcher).
- **Verified end-to-end**: session list pagination/search all correct
  against real logged sessions from earlier in this project's history;
  a real transcript (`quick-test` session) rendered its exact 2 messages
  in order via a direct API call; an unknown session id 404s.

## Testing (`backend/tests/`)

Added 2026-08-20 — the first automated test suite in this project.
Everything before this was live curl/manual verification (still the
primary way most features here get checked — see `HISTORY.md`'s
"verified end-to-end" pattern throughout); `backend/tests/` exists
specifically to lock in behavior that's easy to silently break on a
future prompt/model/schema change and expensive to keep re-verifying by
hand every time. Deliberately follows the same "hit the real thing,
don't mock" culture as the rest of this project's verification —
`conftest.py`'s `db_session` fixture runs against the real dev Postgres
(same `DATABASE_URL` the app itself uses), and the LLM-dependent tests
call whatever chat provider is actually configured in `AppSettings`, not
a mock.

- `pytest.ini` registers a `slow` marker and defaults to `-m "not slow"`
  — run from inside the backend container (needs the same DB/Ollama
  network access the app itself has):
  `docker compose exec backend pytest` (fast only) /
  `docker compose exec backend pytest -m slow` (the live-LLM ones too).
- **`conftest.py`'s `db_session` fixture uses SQLAlchemy's documented
  "join an external transaction, with savepoints" pattern**
  (`Session(bind=connection, join_transaction_mode="create_savepoint")`),
  not a plain `SessionLocal()` + rollback — needed because some tested
  functions (`_apply_lead_capture`) call `db.commit()` internally, same
  as they do for real in the running app. With this binding, each
  internal `commit()` only ends/restarts a SAVEPOINT; the fixture's own
  outer `trans.rollback()` always discards everything regardless of how
  many times the code under test committed. A plain flush-then-rollback
  fixture (this file's first cut) silently leaked real rows into the
  shared dev DB the first time a test exercised commit-calling code —
  caught before it shipped, not after.
- `test_intent_schema_lifecycle.py` — fast, deterministic, no LLM calls.
  Verifies the real Postgres FK behavior a user asked about directly:
  deleting an `IntentSchema` cascades its `IntentField` rows and its
  `IntentView` (review queue) away (`ON DELETE CASCADE`,
  `alembic/versions/a7d3e9f1c5b2`/`c2e8b4d6f9a1`), but a `CrmEntry` that
  already captured real data survives with `intent_schema_id` set to
  `NULL` and `collected_fields` untouched (`ON DELETE SET NULL`) — a
  captured lead is never silently deleted just because the owner later
  removed the schema it came from. **Real gotcha hit writing these**:
  `Session.get()` checks the identity map before the DB — after a
  DB-level cascade delete you didn't issue through the ORM yourself
  (this one happened via the FK constraint, not an ORM-tracked delete),
  a stale in-memory object still looks "there" until you
  `db_session.expire_all()` first.
- `test_lead_capture.py` — fast, deterministic, no LLM calls (feeds
  `_apply_lead_capture` an already-parsed dict directly). Covers
  `wants_human` persistence both directions, and the real `message`
  `NameError` bug caught and fixed the same session (see "Chat lead
  capture" above).
- `test_intent_schema_scope.py` — slow, hits the real configured LLM
  (marked `slow`). Covers two rounds of the same underlying question
  ("what does 'in scope' even mean, and who decides?"): (1) the
  structured-capture side already correctly declines a car-insurance
  request against a home-insurance-only schema — no bug there; (2) the
  *conversational reply* originally had no schema-awareness at all — a
  live run confirmed the assistant replying "We do!" (later "not sure
  we offer that," after a first-pass fix) to a car-insurance question a
  narrow test schema didn't cover, and separately (the real scenario
  that mattered, from a real manual test) hedging on an insurance
  request against real-estate RAG documents even though a matching
  `insurance_application` schema existed. Final fix:
  `_available_request_types_block` (see "Chat lead capture" above) —
  verified with a live test asserting the reply now confidently
  confirms ("Yes — we can quote auto insurance here") when a schema
  matches, with zero RAG support. Also verifies `wants_human` extraction
  both directions, and that the general-knowledge/genuinely-in-scope
  regression checks still hold after all of the above.

- `test_turnstile.py` (2026-09-10) — fast, hits Cloudflare's REAL
  siteverify API using Cloudflare's own officially-documented dummy test
  secrets (no real account needed), plus one monkeypatched network-
  failure case for the fail-open path. See "Bot verification" below.
- `test_injection_defense.py` (2026-09-10) — fast, deterministic, no LLM
  calls (same `_apply_lead_capture`-fed-a-parsed-dict technique as
  `test_lead_capture.py`). Locks in the code-level guardrails that hold
  even against a successful prompt injection's fabricated output — see
  "Prompt-injection defense" below.
- `test_intent_triage.py` (2026-09-10) — fast, deterministic. Locks in
  `_build_triage_control`'s degrade-to-`"text"` safety net for malformed/
  missing model output.
- `test_payments.py` (2026-09-10) — fast, deterministic. Locks in a real
  gap the embedded-Checkout redesign could have reopened: a stale
  `stripe_publishable_key` from a previous Stripe config must never leak
  out of the now-public `GET /api/payment-config` while
  `payment_provider` is back on `"test"`. See "Payment gate" above.

Not yet covered: frontend tests (none exist), the product/order pipeline,
owner-agent's tool loop, CTE. Add to this suite as new behavior is worth
locking in, rather than only ever re-verifying by hand.

## Rate limiting (`backend/rate_limit.py`)

Added 2026-08-08, extended several times since as new public-no-auth
mutations shipped. Every other route in this backend sits behind
`require_role` — a stolen/guessed JWT is a bigger problem than a fast
caller, so this deliberately does **not** rate-limit the whole API, only
the fully public, no-auth routes: `POST /api/chat`/`POST /api/chat/upload`
(`apis/chat.py`), `POST /api/auth/login` (the classic brute-force
target), `POST /api/cart/add` (`apis/products.py`), `POST
/api/crm/resume/request`/`POST /api/crm/resume/verify`
(`apis/crm_resume.py`), and `POST /api/contact` (`apis/contact.py`,
2026-09-09). `RateLimitMiddleware` matches on exact `(method, path)`, not
a prefix, so `/api/chat`'s budget can never accidentally also gate
`/api/chat/upload`. See `rate_limit.py`'s own `RULES` dict for the
current, authoritative list and each route's exact window/limit — this
paragraph names them, not their numbers, so it doesn't drift out of sync
every time a new one is added.

### Red-team + stress test (2026-09-10) — one real, serious finding, fixed and re-verified

A full red-team pass (RBAC bypass, JWT tampering, IDOR, file-upload
abuse, path traversal, SQL injection surface, prompt injection, CORS,
brute-force on login/CRM-resume) found nothing — every one of those held
up, verified live against the real running stack, not just reviewed.

**The stress test found a real, serious gap**: every public, *read-only*
GET route (`GET /api/pages/{slug}`, `/api/products`, `/api/products/{id}`,
`/api/products/search`, `/api/product-fields`, `/api/business-profile`,
`/api/map-embed`, `/api/payment-config`, `/api/checkout/session-status`,
`/api/turnstile-config`, `/api/cart`, `/api/auth/oauth-providers`) had
**no rate limit or concurrency ceiling of any kind** — this file's own
prior reasoning explicitly judged them "plain SELECTs, no rule needed."
A burst of concurrent requests to just ONE of them (`GET
/api/pages/{slug}`, from a single machine, no auth, no botnet) proved
that wrong: 150 concurrent was fine, but 220-300 concurrent exhausted
`backend/db.py`'s DB connection pool (silently defaulting to
SQLAlchemy's own `pool_size=5`/`max_overflow=10` — 15 connections total,
no explicit `pool_timeout`) and left the **entire backend unresponsive
to ALL traffic** — not just the flooded route — for 90+ seconds with
**no self-recovery** (confirmed via `pg_stat_activity`: exactly 15
connections stuck `idle in transaction`, and CPU dropped to near-idle
rather than being busy, ruling out "just slow"). Recovering required a
manual `docker compose restart backend`, twice, during testing. A
genuine, free, single-machine DoS against this app's current shape.

**Fixed in three places, all re-verified against the real running
stack**, not just reviewed:
1. **`backend/db.py`** — `create_engine` now passes explicit
   `pool_size=10, max_overflow=20, pool_timeout=10, pool_pre_ping=True`
   (was zero overrides). `pool_timeout=10` is the actual fix for the
   "hangs forever" failure mode: a request that can't get a connection
   within 10s now raises, caught by `main.py`'s already-existing global
   exception handler (`error_alerts.py`) — logged, a clean 500,
   optionally alerts the owner — instead of hanging indefinitely.
2. **`backend/rate_limit.py`** — gained `PREFIX_RULES`, a second
   rules table alongside the existing exact-match `RULES`, for route
   *families* with a dynamic segment (a slug, a product id, a search
   query) — `_prefix_rule_for` matches `path == prefix or
   path.startswith(prefix + "/")` (boundary-aware, never a bare
   substring, so `/api/products` can never swallow the real, different
   `/api/product-fields`) and every request under one prefix shares ONE
   per-IP budget, closing the obvious bypass of just hitting a different
   slug/id/query each time. All ten routes above got `60 requests/10s`
   per IP — deliberately closer to a concurrency cap than a rate limit
   (real browsing never approaches it; 150 concurrent was already fine
   in testing, so 60 leaves a wide margin under that while making the
   actual failing case impossible to reproduce).
3. **`deploy/nginx.conf.template`** — gained `limit_req_zone`/
   `limit_conn_zone` (`rate=20r/s`, `burst=40 nodelay`, 20 concurrent
   connections per IP, applied to the `/api/` location block). **This is
   the layer that actually matters once a real domain deployment exists**
   — `rate_limit.py`'s own per-IP tracking only sees whatever IP directly
   connects to it, and once Nginx sits in front (exactly the `--domain`
   deployment mode this file is for), every request arrives from Nginx's
   own local connection, not the real visitor's — the same reasoning
   `X-Forwarded-For` isn't trusted, in reverse. Nginx itself sees the real
   client IP directly, so it's the correct enforcement point once it's in
   the request path at all. Documented as a known, not-yet-solved caveat
   in `rate_limit.py`'s own module docstring, rather than silently
   assumed away.
- **Verified live, not just reviewed**: re-ran the exact attack that
  broke it — 300, then a clean 1000-concurrent burst against `GET
  /api/pages/home` — both now resolve in ~2.3s total with exactly the
  configured budget (60) returning 200 and the rest instant 429s (not
  slow, queued failures), zero errors, zero hangs; `pg_stat_activity`
  stayed clean (no `idle in transaction` pileup) and `GET
  /openapi.json` stayed responsive (0.2-0.7s) throughout. A plain
  40-concurrent burst (normal-sized traffic) still sails through
  unaffected. The substituted `nginx.conf.template` (placeholders
  replaced, mounted into a real `nginx:stable` container) passed a real
  `nginx -t`. `pytest` (21 fast tests) still clean after the `db.py`/
  `rate_limit.py` changes.

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

## Bot verification (`backend/turnstile.py`, `backend/apis/turnstile_settings.py`)

Added 2026-09-10, on the user's own direct ask: real bot verification,
with an owner-facing on/off switch, that must NOT affect SEO/GEO.
Scope confirmed via `AskUserQuestion`: Cloudflare Turnstile (free,
mostly-invisible to a real visitor, no CAPTCHA-image interaction),
gating exactly three fully-public WRITE endpoints — `/api/chat` (first
turn only), `/api/contact`, `/api/auth/login` — never a page view.

- **Why this structurally can't affect SEO/GEO — not just a hopeful
  claim, the actual mechanism**: every crawler this app cares about
  (`robots.ts`'s named AI crawlers, `llms.txt`, `sitemap.ts`) only ever
  issues GET requests against page/asset routes. There is no code path
  anywhere that runs a Turnstile check against a GET — `is_turnstile_enabled`
  is only ever consulted inside `chat()`/`submit_contact_form`/`login`,
  three POST handlers a crawler never calls. This is the whole reason the
  scope was deliberately narrowed to those three endpoints rather than a
  site-wide interstitial or middleware — a broader gate would have
  created exactly the SEO/GEO risk the user explicitly ruled out.
- **No `TestTurnstileProvider`, unlike every other gate in this app**
  (Payment/Notification/Map) — disabled (`AppSettings.turnstile_enabled`,
  default `False`) already IS the zero-friction no-op state those other
  gates' own "test" mode exists to provide, so a separate always-passing
  provider class would just be a second name for the same thing.
  `verify_turnstile_token(secret, token, remote_ip)` is the one function
  every gated endpoint calls — a no-op nothing-to-check case is instead
  handled by each caller checking `is_turnstile_enabled(row)` first
  (requires the enabled flag AND both keys actually saved — flipping the
  switch on with no keys yet would otherwise silently reject every real
  visitor with no way to ever pass).
- **Fails CLOSED on a missing/invalid token, fails OPEN on a genuine
  network error talking to Cloudflare** — a real, deliberate asymmetry:
  an attacker skipping the widget entirely must not be waved through
  just because "the check didn't run," but a Cloudflare outage blocking
  every real visitor's chat/contact/login attempt would be a worse
  outcome than briefly losing this one layer of defense, the same
  "never let an optional safety net become a hard dependency" posture
  `resource_broker.py`'s own functions already hold themselves to.
- **`/api/chat`'s gate fires only on a conversation's genuinely first
  turn** (`not req.history`, the identical gate `_intent_triage_call`
  already uses) — checked FIRST, before any other work in `chat()`, so a
  rejected request never reaches session logging/RAG/the provider call
  at all. The frontend mirrors this with a plain "has one turn
  succeeded yet" flag (`chat-panel.tsx`'s `firstMessageSent`), not
  per-turn state — once solved, a visitor is never asked again for the
  rest of that conversation.
- **Owner-facing settings** (`GET`/`PUT /agent/turnstile-settings`,
  `TurnstileSettingsPanel`, new "Security" accordion group) mirror
  `apis/maps.py`'s shape exactly: `turnstile_secret_key` is write-only
  (never echoed back); `turnstile_site_key` is safe to echo and is NOT a
  secret — Cloudflare's own site key is designed to be embedded directly
  in browser-side JS, the same posture as Stripe's own publishable key.
  **`GET /api/turnstile-config`** is the public, no-auth, page-view-time
  lookup every gated form/panel calls once on mount to decide whether to
  even render the widget — itself never gated (see the SEO/GEO reasoning
  above), and reuses the exact same `is_turnstile_enabled` check the real
  enforcement paths use, so the two can never disagree about whether the
  feature is actually live.
- **`TurnstileWidget`** (frontend, `components/common/turnstile-widget.tsx`)
  — a thin wrapper loading Cloudflare's own script via `next/script`
  (`strategy="lazyOnload"`) and calling `window.turnstile.render(...)`
  once it's available (checked synchronously on mount for the "already
  loaded by another widget on this page" case, falling back to the
  script's own `onLoad` for the first widget). Never loaded at all when
  the feature is off — a site with it disabled pays zero cost, no script
  tag, no widget div, nothing.
- **Verified live end-to-end against Cloudflare's REAL production
  siteverify API**, not mocked — using Cloudflare's own officially
  documented dummy test credentials meant for exactly this
  (`1x0000000000000000000000000000000AA` always passes,
  `2x0000000000000000000000000000000AA` always fails, no real
  Cloudflare account needed): enabling the feature with the always-pass
  secret correctly let `/api/chat` (first turn)/`/api/contact`/
  `/api/auth/login` all through with a token and correctly 428'd all
  three with no token; the always-fail secret correctly 428'd even WITH
  a token; a chat conversation's SECOND turn (non-empty history)
  correctly required no token at all; disabling the feature afterward
  restored the exact original zero-friction behavior. `pytest`
  (`backend/tests/test_turnstile.py`, 4 tests including a genuine live
  Cloudflare call and a monkeypatched network-failure case for the
  fail-open path)/`tsc`/`eslint`/a real production build all clean. Test
  settings/sessions/CRM entries cleaned up after.

### Prompt-injection defense

Added the same session, off the user's own direct ask ("防AI攻击" —
defend against AI-driven attacks) alongside bot verification above. Real
attack surface, given `/api/chat`'s own structural limits (no tools, no
filesystem — see the root AGENTS.md's RBAC architecture note): a
visitor's message, a retrieved RAG excerpt, or an uploaded attachment's
extracted text all reach the model as plain text it could mistake for
new instructions. Since there's no tool access to escalate to, the worst
realistic outcome was always a manipulated reply or a bogus
CrmEntry/Order via the classification calls — this closes both halves.

- **`apis/chat.py`'s `_INJECTION_DEFENSE_SUFFIX`** — appended to the main
  reply's system prompt UNCONDITIONALLY, even when the owner has fully
  replaced `SYSTEM_PROMPT` with their own `chat_system_prompt`
  (`_resolve_system_prompt`'s own long-standing "full replacement, never
  append-only" design — see that function's docstring). A deliberate,
  narrow exception to that rule: this isn't tone/persona content an
  owner would ever author themselves, it's a fixed safety floor that
  shouldn't be removable by an incomplete custom prompt — the same
  reasoning that already keeps RAG excerpts/visitor identity/order state
  OUT of the customizable system string entirely. Tells the model these
  instructions can't be changed/revealed by anything in a user message,
  a knowledge-base excerpt, or a file's extracted content, and to
  decline (not comply, not explain why) if asked to reveal/quote/
  paraphrase its own instructions or told it's in a "special/developer/
  debug mode." Verified directly: fed a fake `AppSettings.chat_system_prompt`
  through `_resolve_system_prompt` and confirmed the suffix is appended
  after the custom text every time, not just the default branch.
- **`_CLASSIFICATION_INJECTION_DEFENSE_CLAUSE`** — the matching, shorter
  clause appended to all four classification-call system prompts
  (`_lead_extraction_system_prompt`'s both branches,
  `_order_extraction_system_prompt`, `_intent_triage_system_prompt`) —
  these have no persona to protect but DO have a real DB-write side
  effect an injected instruction could steer. Tells the model to base its
  answer only on the visitor's genuine words and ignore anything
  anywhere in the conversation/attachment/RAG excerpt that claims to be a
  new instruction or a request to change the output format/values.
- **The deterministic, code-level guardrails are the half that actually
  GUARANTEES a worst-case injection can't do real damage** — the prompt
  wording above only reduces how often a model falls for one.
  `backend/tests/test_injection_defense.py` (4 tests, new) locks in what
  was already true of `_apply_lead_capture`'s existing code, verified
  directly rather than assumed: a fabricated `schema_key` that matches no
  configured schema never resolves to a real one; `fields` entries not
  defined on the matched schema are silently dropped, never stored; an
  invented `category` value outside the fixed vocabulary falls back to
  `"inquiry"`, never stored verbatim; a non-email `contact_email` string
  with no other real email source correctly creates no `CrmEntry` at all
  rather than half-completing with garbage contact info.
- **Verified end-to-end**: `pytest` (all 8 new tests across
  `test_turnstile.py`/`test_injection_defense.py`/`test_intent_triage.py`
  — the last locks in `_build_triage_control`'s degrade-to-`"text"`
  safety net, verified by hand earlier this session but never captured
  as a permanent regression test until now) plus the full existing suite
  all pass (19 fast tests total, up from 6 before this round).

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

### Vision-model reliability for Container nesting — tested 2026-09-09, real findings

Closes (with real data, not more speculation) the long-standing "Known
gap"/"Suggested next step" item asking whether the vision model can
reliably generate the Container/Block schema's nested-row-of-columns
pattern from a real design image — every example of it in this app had
until now been hand-authored, never generated by the model on its own.

- **Method**: three synthetic PNG mockups (built with PIL directly inside
  the backend container, no external design tool) fed through the real
  `POST /agent/landing-page/generate` pipeline against a real, live
  vision-capable model — `gemma3:4b`, temporarily pulled via the bundled
  Ollama and tuned the same way `ollama_admin.py`'s pull flow always
  does, swapped in as `vision_provider`/`vision_model` only (chat/
  embedding untouched), restored to the owner's exact original `custom`
  27B-model snapshot afterward via a direct DB write (same known-good-
  snapshot-restore pattern used elsewhere in this file when the owner's
  own local llama-server isn't reachable to live-revalidate a PUT).
  1. A plain stacked hero (headline above subheadline, photo beside the
     whole column — a real, valid `hero` case, no container involved) —
     included as a sanity baseline, not a nesting test.
  2. **The canonical 2-level-nesting case named directly in
     `_VISION_SYSTEM_PROMPT` itself**: a row of two UNEVEN-width columns,
     different background tints, each holding its own photo placeholder
     + caption underneath, no card border — exactly the "50/50-photo-
     columns... canonical case" the prompt's own width-heuristic section
     describes.
  3. Three EQUAL-width columns, same treatment — per the prompt's own
     rule this should collapse to one flat `"grid"` container with 3
     children and needs NO nesting at all, a simpler sibling case.
- **Result 1 (baseline hero)**: correctly identified as a hero — but the
  model ALSO hallucinated a second, spurious `container` section with a
  fabricated `background_image` ("Blue background," not in the source
  image at all) and a duplicated copy of the real caption text. Not a
  nesting failure, but a real reliability problem: even the simplest,
  unambiguous case produced an extra, invented section.
- **Result 2 (the actual 2-level-nesting target case)**: the model
  **hallucinated an entirely fictional headline/eyebrow/subheadline**
  ("Trusted Advisors," "About Us," "We're committed to helping our
  clients succeed...") for a bogus `hero` section — none of that text
  exists anywhere in the source image, which had zero headline text at
  all. It then emitted a `container` with `layout: "row"` (the correct
  top-level type!) but with only ONE child — a lone, uncaptioned image
  block. **No nesting was attempted at all**: neither column became its
  own nested container, one column's photo+caption pair was dropped
  entirely, and the other lost its caption. The specific pattern this
  test targeted — a row containing two nested column-containers — was
  never produced, not even incorrectly; the model quietly gave up on
  representing the second column at all.
- **Result 3 (equal columns, should need zero nesting)**: even the
  *simpler* flat case failed independently of nesting — the model
  invented a full paragraph of fictional marketing copy for a hero
  section from an image containing no real text at all beyond three
  short captions, then split the three real columns into two separate,
  nonsensical `feature-grid` sections (`"columns": 2` for 2 and 1 items
  respectively) with one item's title/description duplicated near-
  verbatim across both.
- **Conclusion — real, verified, not assumed**: with a small (4B
  parameter) vision model, structural nesting reliability is downstream
  of a more basic problem — the model hallucinates fabricated marketing
  copy and duplicate/incomplete sections even on the simplest synthetic
  mockups, well before nesting depth becomes the limiting factor. The
  2-level "row containing column-containers" pattern this app's prompt
  explicitly documents as its own canonical case was not successfully
  produced in this test — the model chose to drop content and flatten
  rather than nest.
- **Honest scope limitation, stated plainly**: this dev/test environment
  has no way to reach the project's actual configured production vision
  model (`custom` provider, a real 27B `Qwen3.8-27B-Uncensored` running
  on the owner's own host machine, unreachable from this sandboxed
  session) — only a small locally-pulled `gemma3:4b` was available to
  test against. These findings characterize that specific small model's
  behavior, not a verified ceiling on what the owner's own real,
  substantially larger production model can do — a real 27B model
  should reasonably be expected to hallucinate less and follow structural
  instructions more reliably, though this was NOT independently
  confirmed this round. Test images/generations were not persisted
  anywhere in this app (no page/document was saved) and the pulled
  model was deleted after testing — this was a pure diagnostic run
  against the live `generate_landing_page` pipeline, not a feature
  change.

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
  border width) on both `ThemeCta` and `ButtonBlock`. **`width`
  (`BlockWidth`) editing, 2026-08-21** — every `block-*` fieldType (7 of
  them by now: container/text/image/button/product-list/product-card/map)
  shares one `blockWidth` draft/control (`BLOCK_WIDTH_OPTIONS`,
  `CteEditorPopover`) rather than seven near-identical copies, since the
  field is identical in shape and meaning across all of them — only
  meaningful when the block being edited is a direct child of a
  `layout: "row"` container, shown unconditionally regardless of the
  block's actual current parent (same posture as every other style field
  in this popover, e.g. `justify`/`align` showing even for a `grid`
  layout where they don't currently apply). `ContainerBlock.min_height`
  was already editable before this round (`MIN_HEIGHT_OPTIONS`) — the
  "Suggested next step" note below calling it still-shelved was stale.
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
  carousel slide editing. Width/height editing on individual blocks
  (previously listed here as shelved) shipped 2026-08-21 — see "Style
  editing" above.

**AI content assistant — "AI fill content"** (2026-09-08,
`components/theme/cte/ai-content-assistant.tsx`,
`backend/apis/agent.py`'s `POST /agent/pages/ai-fill-content`,
`frontend/src/lib/page-ai-fill.ts`). Closes the gap between
`generate_landing_page` (AI decides structure AND content, from a design
image) and plain CTE (a human decides both, field by field): the owner
arranges a page's sections/blocks by hand first, then hands that
**already-decided layout** to the AI with a plain-language description
of what the content should be about, and gets copy — and, separately,
images — written into it. Confirmed design (`AskUserQuestion`):
- **AI never touches structure, only content** — `lib/page-ai-fill.ts`'s
  `collectFillableFields(sections)` walks the current `sections` tree for
  every text/text-list/image slot (recursing into
  `ContainerBlock.children`), skipping anything structural/functional/
  factual-and-owner-entered (a `MapBlock`'s address, `href`s, product
  bindings) — the same "code guarantees structure, the LLM only supplies
  content" split `_coerce_sections` already relies on elsewhere. The
  backend never sees the page schema at all, only this flat manifest, and
  re-validates every path the model echoes back against the exact
  requested set before returning anything.
- **One whole-page prompt** (`resolve_chat_provider`, optionally grounded
  in ingested company-material documents) fills every text field in one
  pass, applied directly into the live unsaved CTE editing state — same
  "apply immediately, still hand-editable, Save is separate" posture as
  every other CTE edit. A `RichText`-object field keeps its existing
  color/size/weight; only `content` is replaced.
- **Images are never auto-generated** — the text pass also returns a
  short image-generation-prompt *suggestion* per slot (never an actual
  image); each slot gets its own row, appearing only once the text pass
  has run, with its own "Generate" button that enqueues (never generates
  inline) into a real one-at-a-time client-side queue
  (`AiContentAssistant`'s `queue`/`processingPath`) reusing the existing
  `POST /agent/poster/generate`. A queued (not-yet-running) row can be
  bumped to the front ("Generate next") or cancelled. A finished job's
  URL applies straight into that image field, preserving its existing
  `alt` text (`lib/cte.ts`'s exported `getByPath`).
- Deliberately text + images only this round, not per-field color/style
  generation — a confirmed scope cut (existing CTE style editors still
  cover that by hand), not a gap.
- Always mounted regardless of `editModeOn` — an `active` prop gates only
  the trigger button and the Sheet's `open={open && active}` (a derived
  value, no effect needed). Fixes a real state-loss bug found this
  session (toggling edit mode off to preview a result used to unmount the
  whole component, wiping its image queue/reasoning) — full story in
  `HISTORY.md`'s 2026-09-08 entry.

**"Ask AI to adjust this container's layout"** (`backend/apis/agent.py`'s
`POST /agent/pages/ai-adjust-layout`, `frontend/src/lib/layout-adjust.ts`,
a new section inside `CteEditorPopover`'s `block-container` form) — the
local-area counterpart, built after a blanket CSS fix for a row's uneven
child heights (`ContainerBlock` gaining unconditional `h-full`) regressed
a *different* container's own intentional design elsewhere on the same
page (a full-bleed `background_image` + `min_height` banner whose short
colored panels are meant to leave most of the photo visible — see
`HISTORY.md` for the full story of that regression and the reverted
fix). Two scope decisions confirmed with the user (`AskUserQuestion`),
both the more conservative option offered:
- **Local area only** — an optional-instruction block inside the SAME
  popover that already edits a container's style fields by hand (no new
  top-level UI). Sends this ONE container's current style fields
  (including whether it has a background image/color) plus a one-level,
  non-recursive summary of each direct child (`lib/layout-adjust.ts`'s
  `summarizeChild` — kind + a short content snippet, never the child's
  full object). The response applies straight into the popover's
  existing draft state (`setCLayout`/etc., which already live-applies) —
  zero new apply-plumbing. A `reasoning` string always renders, including
  an honest "these fields alone can't fix this" when the real ask needs
  restructuring instead of a misleading partial fix.
- **Style knobs only, no restructuring** — `layout`/`gap`/`padding`/
  `margin`/`align`/`justify`/`min_height`; never add/remove/reorder/nest
  a child, never `columns` (not exposed by the manual form either).
  Known, confirmed limitation: this can't fix a case that genuinely needs
  an extra nested container (the banner-panel-height case above) — the
  model says so via `reasoning` rather than faking a fix. Its system
  prompt explicitly teaches it the `align: "stretch"` + tall `min_height`
  + a background image → children cover the photo entirely failure mode
  found above, so it doesn't recommend the same mistake back.

Two more real, unrelated bugs the user caught by screenshot during this
same pass, both fixed — full root-cause story in `HISTORY.md`'s
2026-09-08 entry: a `width`-sized row child overflowing past its own row
in edit mode only (`block-renderer.tsx`'s `WIDTH_CLASS` — a `shrink-0`
conflicting with edit mode's own extra `InsertGap` flex items in the same
row; fixed by dropping `shrink-0`, keeping `grow-0`), and a z-index
ordering mistake where the CTE sticky toolbar's "Edit mode" `Switch` (and
separately, `SiteHeader`) could get painted over by a section's own
hover-revealed toolbar. Current z-index order for `/editor`: `Sheet` (50)
≈ `SiteHeader` (50, loses the DOM-order tie to Sheet) >
`CteEditorPanel`'s sticky toolbar (`z-[45]`) > section-level hover
toolbar (40) > `ArrayItemToolbar` (20).

**Verification gap, unresolved all session**: no working Chrome browser
extension connection existed for any part of the CTE work above — every
fix was verified via `tsc`/`eslint`/curl/backend checks and the user's
own screenshots, never a live click-through by this session's own tools.
Treat any CTE-adjacent change as needing a real browser check before
considering it fully settled.

## Progress against the plan's phases (四、开发顺序建议)

- **Phase 1 — Skeleton**: done. Next.js + Tailwind, Postgres/Alembic,
  real self-issued-JWT auth + RBAC (deliberately not Firebase — still
  standing, not reconsidered). 3 seeded demo accounts, password `0000`
  for all: `owner@example.com`, `admin@example.com`, `user@example.com`
  — **local-demo-only credentials, never used on a real deployment**,
  see "Deploying to a real server" above for the real `create_owner.py`
  bootstrap that replaces them there.
  **2026-08-22**: real Google OAuth added for the public `user` tier
  (`backend/apis/oauth.py`) — still self-issued JWTs underneath, not
  Firebase; OAuth is just a second way to prove identity before this
  app's own token takes over, confirmed with the user as in-scope and
  distinct from the standing "no Firebase" call. admin/owner stay
  password-only, a deliberate, confirmed design boundary — see "Social
  login" below. **2026-09-09: the original "not a real deployment, don't
  push toward cloud deploy" framing is reversed** — real deployment
  automation now exists, see "Deploying to a real server" above.
- **Phase 2 — RAG core**: done. See "RAG" above.
- **Phase 3 — Chatbot**: mostly done. `POST /api/chat` real, provider-
  abstracted, RAG-merged, with automatic lead capture and optional
  logged-in-caller identity/personalization (see "Chat lead capture &
  optional caller identity" above). **Not done**: streaming (SSE/
  WebSocket — single non-streaming call today, and deliberately staying
  that way for the public path, see "Suggested next step" below for
  why). **Real LLM-driven intent recognition is now done, 2026-09-09** —
  see "Real LLM-driven intent triage" above: `chat-panel.tsx`'s old
  hardcoded category→tags→channel wizard is gone; a real classification
  call (`_intent_triage_call`, `backend/apis/chat.py`) decides, on a
  conversation's first turn, whether to ask a structured clarifying
  question via the same `{type, options}` control contract, grounded in
  `AppSettings.chat_intent_prompt` and this business's own configured
  schemas/products. Verified live end-to-end against a real (small)
  bundled-Ollama model.
- **Phase 4 — CTE editor**: done, extensively. See "CTE" above.
- **Phase 5 — Visual polish**: page generation/schema done (see "Page
  schema" above). **Not done**: GSAP/ScrollTrigger (not started); Swiper
  carousel section (built, unused, no content feeds it, not CTE-
  editable).
- **Phase 6 — Agent security layer**: **started, not complete**. The
  isolated worker now exists — `owner-agent/` (own container/port 8100,
  see "Architecture decisions" above and "Owner agent" below) — with a
  real LLM tool-calling loop over a fixed 21-tool allowlist, its own
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
  envelope: either call one of 21 tools (`generate_poster`,
  `generate_landing_page`, `crm_create_entry`, `crm_list_entries`,
  `crm_delete_entry`, `generate_report`, `generate_geo_page`,
  `scan_crm_attachment`, `cleanup_chat_uploads`, `cleanup_stale_crm_entries`,
  `list_intent_schemas`,
  `manage_review_queue`, `detect_business_type`, `propose_intent_schema`,
  `list_products`, `propose_products`, `set_order_status_options`,
  `ingest_documents_from_url`, `list_scheduled_tasks`,
  `manage_scheduled_task`, `check_seo_schema` (2026-09-08, see "GEO push
  part 2" above) — each
  a thin HTTP call onto an already-real `backend/apis/agent.py`/
  `apis/intent_schemas.py`/`apis/products.py`/`apis/documents.py`/
  `apis/scheduled_tasks.py`/`apis/seo_audit.py` endpoint) or give a final
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
  (the 21 tools, the brain call above, and now the action-log write
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
- **An outbound `httpx` fetch to a real external site can 403 on
  httpx's own default User-Agent alone** (2026-08-21, found building
  URL-based document ingestion, `apis/documents.py`'s
  `_fetch_url_content`) — confirmed live against Wikipedia: the default
  `python-httpx/x.x.x` UA got a flat 403, a plain browser-shaped
  `User-Agent` string worked immediately with no other change. Not a
  hypothetical edge case — government/legal sites (this feature's own
  target use case) commonly run similar WAF-level bot filtering. Any
  future feature that fetches an arbitrary external URL should set a
  real `User-Agent` from the start rather than rediscovering this.
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

Out of scope by explicit decision — don't suggest: real Firebase Auth, or
chat streaming on the public `/api/chat` path. **The reasoning, stated directly by the
user (2026-09-09), is a genuine product stance, not just a scope
cut**: as AI reasoning/output gets harder for a human to follow over
time, and most users care about the result rather than the process
anyway, streaming a token-by-token "thinking" trace to a visitor adds
little value here — a single, complete, non-streaming reply is the
right default for this app's public-facing chatbot. If/when streaming
is ever built at all, it's scoped to `owner-agent`'s own run output only
(an owner watching their own agent work, a different audience/use case)
— see "Progress against the plan's phases," Phase 3.

**Known gaps, still open** (beyond the per-phase "Not done" bullets in
"Progress against the plan's phases" above):
- **A real in-browser click-through of everything in this project** —
  the single biggest, longest-standing verification gap. The Chrome
  extension has never connected in any session; everything has been
  verified via `tsc`/`eslint`/curl/backend checks, dev-server logs, and
  (more recently) the user's own screenshots — never a live click-through
  by this session's own tools.
- **Vision-model reliability for deep Container/Block nesting** —
  tested for real, 2026-09-09, see "Vision-model reliability for
  Container nesting" above. Real answer, not a proven ceiling on every
  configuration: a small (4B) vision model hallucinated fabricated
  content and produced incomplete/un-nested output even on simple
  mockups built to trigger the documented 2-level "row containing
  columns" case; not independently verified against this project's own
  actual, larger (27B) production vision model, unreachable from the
  sandboxed session that ran the test.
- **Real deployment automation (`deploy/setup-server.sh`) exists but its
  OS-level install/certbot orchestration was never exercised against a
  genuinely fresh cloud VM/resolving domain** — no access to either from
  this sandboxed session. See "Deploying to a real server" above for
  exactly what WAS verified for real (idempotency, the `.env` upsert
  logic, a real `nginx -t`, `shellcheck`) versus this specific gap.
- Local resource coordination (`resource_broker.py`) is deliberately
  v1-scoped: the standalone embedding server isn't part of it (a
  one-line `--sleep-idle-seconds` fix would cover it, not broker logic),
  there's no live memory-usage dashboard, and a visitor's *next* message
  arriving right after an unload/reload cycle already started isn't
  protected — closing that needs real request queueing.

For the full chronological story behind any of the above, or any other
past decision — exact user quotes, every bug's root cause, every
verification run — see `HISTORY.md`. This file only tracks current state
and standing open items going forward; a session that finishes real work
should update the *relevant current-state section above*, not add a new
dated paragraph down here.

Ask the user which, if anything, to pick back up.

<!-- The chronological "what happened each session" log that used to
live here (2026-08-08 through 2026-09-08) was removed 2026-09-08 — it had
grown into a second changelog duplicating both the current-state sections
above and HISTORY.md, working against this file's own stated "current-
state reference, not a changelog" identity. Nothing was lost: every
fact/decision it restated already lives in this file's own relevant
section, and HISTORY.md still holds the detailed narrative for sessions
through 2026-08-19 plus 2026-09-08. See HISTORY.md if you need the exact
removed text (or `git log -- AGENTS.md` before this commit). -->

