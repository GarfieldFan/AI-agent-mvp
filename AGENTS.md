# AI MVP — project log

Read this before doing anything else in this repo. It exists so any AI
agent session (Claude Code or otherwise) can pick up work without
re-deriving context from scratch. Keep it current: update the relevant
section whenever you finish a chunk of work, not just at the end of a
session.

The full project plan (positioning, tech choices, module list, phased
build order, interview talking points) is `ai-mvp-project-plan.pdf` in this
directory — this file tracks *status against that plan*, not the plan
itself. Read the PDF for the "why", read this file for the "where things
stand".

## Architecture snapshot

```
ai-employee/
├── ai-mvp-project-plan.pdf   the plan (source of truth for scope/rationale)
├── docker-compose.yml        backend + frontend + postgres-db services
├── .env / .env.example       host/ports/ComfyUI config — see "Configuration" below
├── backend/                  FastAPI (Python) — see backend/main.py
│   ├── db.py                  SQLAlchemy engine/session (DATABASE_URL), Base, get_db dependency
│   ├── models.py               User / Page / PageVersion / Document / DocumentChunk / AppSettings / ChatSession / ChatMessage ORM models
│   ├── auth.py                 password hashing (bcrypt) + JWT sign/verify (PyJWT)
│   ├── seed.py                 creates the 3 demo accounts — run manually after migrating
│   ├── ingest.py                RAG doc parsing (pdf/docx/md/txt) + chunking — pure functions, no I/O
│   ├── retrieval.py              RAG retrieval: embed -> pgvector search -> scored chunks (no router — called from apis/chat.py)
│   ├── providers/                AI provider abstraction — see its own AGENTS.md section below
│   ├── alembic/                 migrations — env.py wired to DATABASE_URL + models' metadata
│   └── apis/
│       ├── api.py             ComfyUI image-gen wrapper (predates this plan); URLs env-driven, see "Configuration" below
│       ├── auth.py            POST /auth/login, GET /auth/me
│       ├── chat.py            user-tier chat (public): retrieval.py + ChatProvider, RAG-grounded when relevant, no tools; logs sessions (ChatSession/ChatMessage) for market-research review
│       ├── agent.py           admin/owner-only "agent console" (generate_landing_page + generate_poster are real; CRM/report are stubs, 501)
│       ├── documents.py        RAG document management (admin): upload/list/delete
│       ├── media.py            CTE media library (admin): list ComfyUI-output + uploaded images, upload — see the CTE section below
│       ├── model_settings.py   owner-facing AI model picker (admin): list models, get/set global chat+vision model
│       ├── pages.py            page storage: save/list/restore (admin) + public read-by-slug
│       └── deps.py            RBAC: Role enum + require_role() dependency, backed by real JWTs
└── frontend/                 Next.js (TypeScript) — see frontend/AGENTS.md
    └── src/components/...    reusable component catalog lives there
```

All three services (`backend`, `frontend`, `postgres-db`) run via
`docker-compose up` — backend on :8000, frontend on :3000, Postgres+pgvector
on :5432. Both `backend/` and `frontend/` are bind-mounted with hot
reload; `frontend/node_modules` and `frontend/.next` are anonymous volumes
so the container's Linux-native `node_modules` isn't shadowed by the
host's Windows one (see `frontend/Dockerfile`).

## Configuration: root `.env`, added 2026-08-04

`HOST`, `BACKEND_PORT`, `FRONTEND_PORT`, `COMFYUI_HOST`, `COMFYUI_PORT`,
`COMFYUI_HOST_OUTPUT_DIR` — copy `.env.example` to `.env` and adjust for
your machine; `docker-compose.yml` composes these into the actual URLs/
port-mappings/bind-mounts via `${VAR}` substitution (e.g.
`COMFYUI_PUBLIC_URL=http://${HOST}:${COMFYUI_PORT}`), which
`backend/apis/api.py` then reads via `os.environ.get(...)` with defaults
matching what used to be hardcoded, so nothing breaks if `.env` is ever
missing. Added specifically because none of these are actually fixed:
ComfyUI could be swapped for a different SD backend, a portable ComfyUI
install can move to a different path, and host/ports differ per machine
— the same "swappable, not hardcoded" principle already applied to the
chat/embedding AI providers (see below), extended here to image
generation. Full rationale and the exact variable list: `.env.example`'s
comments, and the CTE section further down (this is the config half of
that feature, not a standalone change).

## Architecture decision: RBAC gates agent/tool access, not just data

The public-facing chatbot (`/chat`) and the admin-only "agent console"
(reserved capabilities visible on `/dashboard`) are **deliberately
separate backend routers with different privilege levels**:

- **`user` role** (the default — anonymous chatbot visitors) can only
  reach `POST /api/chat` (`backend/apis/chat.py`), which does plain LLM
  inference against a local Ollama model. No tools, no filesystem access,
  no agent framework in this path.
- **`admin`/`owner` roles** (authenticated, via the dashboard) can reach
  `backend/apis/agent.py`'s routes — document ingestion, design-to-landing-
  page generation, poster generation, CRM push, report generation. Every
  route is gated by `Depends(require_role(Role.admin, Role.owner))`
  (`backend/apis/deps.py`); a `user`-role request gets a 403 before the
  handler body even runs.

**Why the split exists, and why it's *not* wired to the personal openclaw
instance**: `~/.openclaw/workspace` runs the user's personal assistant
agent — it has email, calendar, SSH, and broad filesystem/skill access.
Routing anonymous public chatbot traffic into that agent would mean a
random site visitor's input could (via prompt injection or otherwise)
reach an agent with real personal-account access — exactly the
"agent失控" risk the project plan's Phase 6 differentiator is about
*solving*, not reproducing. When the admin/owner-only agent-console
capabilities actually get implemented, they should proxy into a
**purpose-built, narrowly-scoped agent/skill** (tight tool allowlist, no
personal-account access, action logging) — not the personal openclaw
instance. That scoped-agent build-out is Phase 6 work and hasn't started.

For reference, the user's personal openclaw agent is reachable at
`ws://127.0.0.1:18789` — noted here in case a *deliberately scoped* Phase 6
agent ends up reusing openclaw's runtime under a separate, restricted
identity/workspace. Don't point `backend/apis/agent.py`'s stubs at this
address as-is; that would be exactly the personal-instance shortcut this
section argues against.

`backend/apis/deps.py`'s role resolution is **real** as of 2026-08-04: it
decodes and verifies a signed JWT (`backend/auth.py`, issued by
`POST /api/auth/login`) rather than trusting a debug header — see Phase
1's entry below for the full picture. `require_role`'s own signature
never changed across that swap, by design.

## Architecture decision: agent execution must be isolated from the API process

Decided 2026-08-03, prompted by the user thinking through prior real-world
agent sandbox-escape incidents (OpenAI/HuggingFace) and local agents'
core advantage being independence/isolation. Not implemented yet — this is
a principle to build Phase 6 against, not new infrastructure to build now
(there is no real agent execution behind `apis/agent.py`'s stubs yet, so
there's nothing to sandbox today; building the isolation boundary before
the capability it protects would be speculative infra for its own sake).

**The rule**: whenever an `apis/agent.py` stub gets a real implementation
that involves actual tool use (calling ComfyUI, writing files, hitting a
CRM/third-party API, running anything resembling an agent loop), that
execution must NOT run inside the same container/process as the public-
facing `backend` service. It belongs in a separate, more tightly scoped
worker — its own container, its own (much smaller) tool allowlist, no
personal-account access (see the openclaw note above), action logging,
and no network path back to the public internet beyond what one task
needs. The `backend` API's job is to authenticate the caller, check
`require_role`, and hand the request off to that worker — never to
execute agent logic in-process itself.

**Why this matters even though Docker already isolates `backend`/
`frontend`/`postgres-db` from each other**: that isolation protects
against *this app's own containers* stepping on each other, not against
*a successful prompt injection inside one agent turning into arbitrary
action on that agent's own container* — which is the class of incident
being guarded against here. A separate, minimal worker means a
compromised agent turn can, at worst, do what that narrow allowlist
permits — not everything `backend` itself can reach (Postgres, ComfyUI,
ingested documents, etc.).

Revisit this section — and actually build the worker — as the first step
of Phase 6, before implementing any `apis/agent.py` handler for real.

## Architecture decision: AI provider is swappable, deliberately — this is a second core differentiator, not a RAG implementation detail

Decided 2026-08-04, at the user's explicit direction: alongside the
RBAC/agent-isolation story, being able to swap the underlying AI vendor
(Ollama, OpenAI, Anthropic/Claude, Gemini) is called out as its own
selling point for this project, not an incidental RAG design choice.

`backend/providers/` is the abstraction: `ChatProvider` and
`EmbeddingProvider` protocols (`providers/base.py`), with real
implementations per vendor (`ollama.py`, `openai.py`, `anthropic.py`,
`gemini.py`) and a single selection point (`providers/registry.py`'s
`get_chat_provider()`/`get_embedding_provider()`, reading
`CHAT_PROVIDER`/`EMBEDDING_PROVIDER` env vars, default `ollama` for both).
`backend/retrieval.py` and `backend/apis/chat.py` (RAG retrieval/
generation, merged into the main chatbot as of 2026-08-04 — see that
section further down) are built against these protocols, never against
Ollama directly — swapping the default is a one-line env var change, not
a rewrite.

**Only Ollama actually works today.** OpenAI/Anthropic/Gemini are real
implementations (genuine API calls, not permanently-stubbed placeholders
like `apis/agent.py`'s poster/CRM/report routes) but every one of them
raises `ProviderNotConfigured` (a clean 503, not a crash) until its API
key env var (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) is
set — deliberately, since the user hasn't provided any paid API keys and
wasn't asked to. Add a key and the provider should just work with no
further code changes; if it doesn't, that's a real bug in that provider
file, not "it was never implemented."

**The two provider roles don't swap the same way — this is the nuance
worth remembering (and worth being able to explain in an interview):**
- `ChatProvider` (generation) is swappable per-call, freely. Today's
  answer can come from Ollama, tomorrow's from Claude, no side effects on
  anything already stored.
- `EmbeddingProvider` (embeddings) is NOT freely swappable once documents
  are ingested. Different providers/models produce vectors of different
  **dimensions** (nomic-embed-text: 768, OpenAI text-embedding-3-small:
  1536, Gemini text-embedding-004: 768), and pgvector's similarity search
  can't compare vectors from two different embedding spaces. Switching
  `EMBEDDING_PROVIDER` after documents exist means re-embedding every
  stored chunk, not flipping a config value — `models.py`'s
  `DocumentChunk.embedding` column is a fixed `Vector(768)` (matching the
  default, Ollama's nomic-embed-text) for exactly this reason. There is
  deliberately no `AnthropicEmbeddingProvider` at all — Anthropic doesn't
  offer an embeddings API, full stop (they point people at Voyage AI);
  that's a vendor gap, not something left unimplemented.

### Owner-facing model picker, 2026-08-04

The provider-swap story above was env-var-only until this point — an
owner couldn't actually change which model was live without editing
`docker-compose.yml` and restarting. `backend/apis/model_settings.py`
adds a real picker: `GET /agent/models` (lists what's actually usable —
Ollama entries queried live via `ollama show`'s `capabilities` field, so
nothing here is a hardcoded guess; cloud entries show each provider's own
configured default model, `selectable: false` until its API key env var
is set), `GET/PUT /agent/settings` (the owner's current pick, persisted
in a new singleton `AppSettings` row — id is always 1 — so it survives a
restart and applies globally to every visitor immediately, not just the
admin session that set it). Frontend: `ModelSettingsPanel`
(`frontend/src/components/modules/`), two dropdowns on `/dashboard`
(admin/owner), each option showing a vision-capability icon and a "Not
configured" badge where relevant, disabled options non-selectable rather
than hidden (so the roadmap — "here's what cloud vision support would
look like once it exists" — stays visible).

**Chat model selection is fully real, immediately, across every
configured provider** — `apis/model_settings.py`'s `resolve_chat_provider`
just layers a settings-row lookup on top of
`providers.registry.get_chat_provider(name, model)` (the registry gained
an optional `model` param for this), so picking an OpenAI/Anthropic/
Gemini chat model here works the moment that provider's API key is set —
no code change, consistent with the whole provider-abstraction premise.

**Vision model selection is Ollama-only in practice, and says so
honestly in the UI.** `generate_landing_page` (`backend/apis/agent.py`)
sends an image content part straight to Ollama's chat endpoint — no
provider here exposes an image-input chat call, so there's no cloud
vision path to select yet. Cloud entries appear in the vision dropdown
(for roadmap visibility, per explicit user direction — "Ollama + cloud
placeholder" over "Ollama only") but are always `selectable: false` with
an explanatory note; `resolve_vision_model`'s resolved provider is
defensively checked in `generate_landing_page` and returns a clear 501 if
it's ever anything other than `"ollama"`, rather than silently doing the
wrong thing.

**Real gap found and fixed building this**: `backend/apis/chat.py` was
still calling Ollama directly via raw `httpx` — a leftover from Phase 3,
before the provider abstraction existed, never migrated when
`providers/` was built for RAG. The root AGENTS.md's own architecture
snapshot table claimed `apis/chat.py` was "BE -> ChatProvider" already;
it wasn't. Fixed as part of this feature (`chat.py` now calls
`resolve_chat_provider(db)`, the same helper `apis/rag.py` used to call
`get_chat_provider()` directly — see the RAG-into-chat merge note just
below, `apis/rag.py` itself doesn't exist anymore) since the model-picker
would otherwise have silently done nothing for the public chatbot. Worth
remembering: a stale architecture-snapshot claim can describe intent
rather than fact — verify against the actual file before trusting it,
same lesson as the gemma4-vision gotcha below.

### RAG merged into the main chatbot, retiring the standalone /knowledge page, 2026-08-04

Prompted by the user testing both surfaces back to back with the same
question against a real uploaded document (`/chat` correctly gave the
generic portfolio-assistant answer since it had no RAG; `/knowledge`
correctly answered from the document) and asking whether keeping them
separate still made sense. Decision: merge. A real company deploying this
site wouldn't split "ask the assistant" and "ask about us" across two
public surfaces — a visitor gets one chatbot that answers from uploaded
documents when relevant and otherwise just converses, which is also
closer to what Phase 3's still-unstarted "intent recognition" item always
implied. `/knowledge` and `KnowledgeQueryPanel` are gone;
`backend/apis/rag.py` (the dedicated `POST /api/rag/query` endpoint) is
gone too — its retrieval half survives as `backend/retrieval.py` (a plain
`retrieve()` function, no router), now called from inside
`backend/apis/chat.py`.

**How the merge actually decides relevance**: every free-text `/api/chat`
turn now retrieves the top-`k` closest document chunks unconditionally
(when any `status="ready"` documents exist) and hands **all** of them to
the model as optional context — the system prompt tells it to "use these
excerpts if relevant, otherwise ignore them", so the same model already
answering the question also does the relevance judgment, no separate
intent classifier or second LLM call needed. A cosine-similarity cutoff
(`chat.py`'s `MIN_CITATION_SCORE`) is applied **only** to which chunks are
worth showing as `sources` citation chips — it has no effect on what the
model sees. That split is the result of a real bug, described next.

**Real bug found and fixed the same day, from the very next real-world
test**: the first version of this code used one score threshold
(`MIN_RELEVANCE_SCORE = 0.45`) to gate *both* citation display *and*
whether the model got any context at all — reasoned about using a
synthetic test document, where a same-language relevant question scored
~0.55-0.57 and a cross-lingual one scored ~0.44, comfortably (if
narrowly) above the 0.45 bar picked to exclude a ~0.39-scoring off-topic
case. The user then tested it for real: uploaded a real company PDF
(Aether Motion Technologies), asked "你们这家公司是做什么的" (Chinese
question, English PDF) — real chunks scored 0.37-0.43, **all below
0.45**, so the model received zero context and answered "we don't have
any company info loaded", even though `retrieve()` had found genuinely
relevant chunks. Diagnosis confirmed the exact mechanism directly against
the live document (`docker compose exec backend python3 -c "..."`
calling `retrieve()` and `providers.registry.get_embedding_provider()`
by hand): the identical question in English scored 0.41-0.51 on the same
document — cross-lingual queries score measurably lower with
nomic-embed-text, a real property of the embedding model, not a code
bug. Worse, further testing showed the "relevant" and "irrelevant" score
distributions for this document **overlap** (relevant cross-lingual
chunks as low as 0.37; an irrelevant same-language "what is the capital
of France?" scored up to 0.38 on its closest chunks) — no single fixed
threshold can cleanly separate them for every case.

**The actual fix was decoupling, not re-tuning the number**: whether the
model gets context and whether a citation chip is worth showing are two
different decisions with very different failure costs — a wrong call on
the first one breaks the answer entirely (this bug); a wrong call on the
second is cosmetic (an occasional spurious or missing citation chip, and
the model's own "use only if relevant" judgment already keeps the answer
text correct regardless — proven by the off-topic tests passing
throughout). Context now always includes every retrieved chunk,
unconditionally; only citation display is still gated, and even then at a
lower, more permissive `MIN_CITATION_SCORE = 0.4` (chosen because it's
comfortably above every off-topic score seen so far — up to 0.38 — while
still keeping this real document's top matches, 0.43 and 0.40). Verified
fixed by re-running the user's exact failing case against the same live
document after the code change: correct, grounded Chinese answer with 2
citations, and the off-topic guard (no spurious citations for "what is
1+1?") still holds. Still a heuristic, still not a tuned/validated value
— but a wrong guess now degrades gracefully instead of breaking retrieval
outright, which is the property that actually matters here.

**Frontend**: `ChatMessageBubble` now renders `SourceCitationList` under
any assistant message carrying `sources` (via `lib/chat.ts`'s
`sendChatMessage` returning `{reply, sources}` instead of a bare string,
and `ChatMessage.sources?: RagSource[]` in `lib/types.ts`) — the same
citation-chips component the old `/knowledge` page used, just relocated.
`default-theme.ts`'s hand-authored homepage and `nav.ts` both dropped
their "Knowledge Base" entries; the "Chatbot" module card's copy now
mentions RAG grounding.

**Explicitly deferred, per the user's own call**: distinguishing
visitors by IP/session and persisting conversation history for future
market-research analysis. The right thing to do eventually, not attempted
in this MVP — noted here so it isn't mistaken for an oversight. Same call
made again shortly after for a related idea — per-user (`owner`/`admin`/
`user`) personal profiles/preferences the AI could draw on — rejected for
the same reason (`user`-role visitors would need exactly the session/
identity tracking just deferred; `admin`/`owner` already have real
accounts but a per-account AI preference would cut against the
model-picker's deliberately *global* semantics, see above) unless a
concrete scenario ever justifies it.

### Visitor conversation persistence (chat session tracking), 2026-08-04

Picked back up as the next piece of work after the About-page schema
conversion above — this is the "persisting conversation history for
future market-research analysis" half of the item deferred just above.
The IP-tracking half is still **not** implemented — see scope decision
below.

**Scope decided with the user before building**: since `/api/chat` has no
auth at all (see the RBAC architecture note — every request, including
one made by the owner poking around, resolves to the same anonymous
`user` role), *every* session this table captures is visitor traffic by
construction — there's no separate "staff chat" to accidentally mix in.
That's the point: this exists so the owner can review what anonymous
site visitors have been asking, the same way a real small business would
skim a chat log, not to audit internal usage. Two things deliberately
**not** built in this pass, both to keep the change small and reversible
rather than because they're wrong ideas:
- **No admin viewer UI yet.** At this project's demo scale, a handful of
  DB rows queryable directly (`psql`, a DB GUI) is enough to prove the
  feature works; a `/dashboard` session-list-plus-transcript view is a
  reasonable next increment (see "Suggested next step" below) once
  there's actual traffic worth browsing through a UI instead of a query.
- **No IP capture.** Session identity is a client-generated UUID
  (`frontend/src/lib/chat.ts`'s `getChatSessionId()`, localStorage-backed,
  survives reloads in the same browser) sent as `session_id` on every
  `/api/chat` call — sufficient to group one visitor's turns together
  without the privacy/PII-handling questions (hashing, retention, GDPR-
  adjacent concerns) that raw IP storage would raise, and the original
  deferred item's "distinguish visitors" goal doesn't actually need IP to
  be satisfied.

**Implementation**: `backend/models.py`'s new `ChatSession`
(`session_key` unique-indexed, `created_at`/`last_seen_at`) and
`ChatMessage` (`role`, `content`, FK to session, cascade-deleted with it)
tables — migration `529fabf77a4f`. `backend/apis/chat.py`'s `chat()`
handler now best-effort-logs both turns of a request when `session_id` is
present: the user's message is committed *before* the provider call (so
the question survives even if generation then fails/503s — arguably the
more useful half to have for market research anyway), the assistant reply
committed after a successful response. `session_id` is optional and
purely additive — a request without one (or a future non-browser caller)
skips persistence entirely rather than erroring, same degrade-gracefully
principle as retrieval's provider-not-configured handling just above.
This logging is fully decoupled from `history` (still sent by the
frontend on every call, still what actually gives the model conversation
context) — the two would only look related, they don't share any code
path. **Verified end-to-end**: two turns sent via direct `curl` under the
same `session_id` produced one `chat_sessions` row (confirmed
`last_seen_at` advanced on the second turn, no duplicate row) and four
`chat_messages` rows in the correct order; test rows deleted after.

### Live availability check for the poster-generation capability card, 2026-08-04

Small, deliberately scoped follow-up to the model-picker's "gray out +
explain why" pattern (Ollama models without vision, cloud providers
without a key — see above), extended to a different kind of
unavailability: a *service*, not a model, being unreachable.
`backend/apis/agent.py`'s `GET /agent/integrations` pings ComfyUI's native
`/system_stats` endpoint (5s timeout, read-only, no side effects) and
returns `{comfyui: {available, detail}}`; the dashboard's "Generate
poster" capability card (still a 501 stub — this only changes what the
card *looks like* before you click, not the stub itself) fetches this
once on mount and grays itself out with the actual unreachable-reason if
ComfyUI isn't up, instead of only surfacing a generic 502 after "Try it".
CRM/report cards are untouched — pure placeholders with no external
service to check yet, `requiresIntegration` is simply omitted for them.
Deliberately not built into a general health-check system — the module
docstring says so explicitly — add an entry only when a real capability
actually depends on that service.

**Scope call, explicit, at the time**: the user asked whether to also
fully implement poster generation alongside this, and chose not to at
first — availability display only, poster generation itself stayed a 501
stub. Superseded the same day — see the next section.

### `generate_poster` is real, not a stub, 2026-08-04

The user mentioned they already had working ComfyUI txt2img/img2img
wired up as an **openclaw skill** (`~/.openclaw/workspace/skills/`) and
asked how to get *this* project generating images — specifically,
whether the owner should issue generate-image commands through the
public chatbot. Recommended against that direction and explained why,
tying back to decisions already made elsewhere in this file: `/api/chat`
is the public, role-blind endpoint (see the RBAC architecture note) — it
has no way to distinguish "the owner typing a command" from "any
anonymous visitor," so routing a real resource-consuming tool call
through free-text chat would be exactly the prompt-injection-triggers-a-
real-action risk category the RBAC/agent-isolation principles exist to
prevent, and would require building actual intent-recognition/agent-
reasoning ahead of the Phase 6 isolation boundary this file says must
land first. Also unnecessary here: openclaw has nothing to do with it —
`backend/apis/api.py`'s existing ComfyUI wrapper already talks to ComfyUI
directly, independent of openclaw entirely.

Landed in the structured, admin-only direction instead, matching
`generate_poster`'s own stub docstring from when it was written (it
always said "will likely compose the existing ComfyUI-backed
/api/generate-image and /api/add-text-overlay endpoints") and the same
pattern `generate_landing_page` already established: a deterministic,
non-agentic pipeline call gated by `require_role(admin, owner)`, no LLM
tool-selection involved. `generate_poster` now: builds a txt2img payload
via `apis/api.py`'s own `_build_payload_txt2img`, submits it to ComfyUI,
awaits completion by calling `apis/api.py`'s `wait_for_completion` route
function **directly as a plain Python function** (same process, so no
self-HTTP round-trip — reuses its existing websocket-first/polling-
fallback/cancel-on-timeout logic rather than reimplementing any of it),
then — if `overlay_text` was given — composites real rendered text via
`apis/api.py`'s `add_text_overlay`, called the same direct way. Frontend:
`PosterGeneratorPanel` (prompt + optional overlay text, admin/owner,
`/dashboard`), pulled `generate_poster` out of the generic stub-card grid
the same way `generate_landing_page`/document ingestion were before it —
it needs real input, not a throwaway sample payload. The generic
`requiresIntegration`/gray-out plumbing added earlier for the *stub*
poster card (previous section) moved into this panel directly (its own
ComfyUI reachability check, gating its own "Generate" button) since
nothing else in the stub grid used it — CRM/report are still pure
placeholders with no external dependency to check.

**Real bug hit and fixed during first test**: the endpoint's own first
draft 502'd on the text-overlay step with "All connection attempts
failed" — root cause was reusing the *browser-facing* `image_url`
(built from `COMFYUI_PUBLIC_URL = http://localhost:8188`, meant for a
browser tab to load) for a **server-side** fetch inside the backend
container, where `localhost:8188` means the container's own (nothing-
listening) port, not the host running ComfyUI. Exactly the same class of
bug as the frontend's `INTERNAL_API_URL`-vs-`NEXT_PUBLIC_API_URL` gotcha
documented elsewhere in this file, just recurring on the backend side
this time. Fixed by building a separate internal fetch URL
(`image_url.replace(COMFYUI_PUBLIC_URL, COMFYUI_URL, 1)`) for that one
server-side GET only — the URL returned to the caller still uses the
public one, since that one really does need to be browser-loadable.
**Verified end-to-end** after the fix: real prompt ("a modern minimalist
tech startup office...") with overlay text "We're Hiring" — 59s
end-to-end, correct image, legible text overlay with the semi-transparent
background box, viewed directly to confirm (not just checked for a 200).

## Progress against the plan's phases (四、开发顺序建议)

**Phase 1 — Skeleton**
- [x] Next.js (App Router + TS) + Tailwind base page structure — done, see `frontend/`
- [x] Database init (Postgres + SQLAlchemy + Alembic) — done. `pages`/`page_versions` (2026-08-04, page storage) and `users` (2026-08-04, real auth) tables both exist via Alembic migrations under `backend/alembic/versions/`.
- [x] **Real auth + RBAC, 2026-08-04** — the `X-Debug-Role` header + `DevRoleSwitcher` placeholder is gone. `backend/auth.py` (bcrypt password hashing, PyJWT sign/verify) + `backend/apis/auth.py` (`POST /api/auth/login`, `GET /api/auth/me`) + `backend/apis/deps.py` (now decodes a real `Authorization: Bearer` JWT — no token or an invalid one still resolves to the anonymous `user` role, so the public chatbot keeps working without login; only `require_role`-gated routes actually reject). Frontend: `frontend/src/lib/auth.ts` (localStorage-backed session + `useAuth()` reactive hook, same `useSyncExternalStore` pattern the old dev-role switcher used), `/login` page + `LoginForm`, `AuthStatus` header widget (replaces `DevRoleSwitcher`) showing email/role/logout when signed in or a "Log in" link when not. `apiFetch` (`lib/api.ts`) now attaches the real token automatically. **Not real Firebase Auth** — deliberately self-contained (FastAPI issuing its own JWTs), see the architecture note on why this was chosen over Firebase.
  - Three seeded demo accounts, all password `0000` (changed from the original seed's `demo1234` on 2026-08-04 at the user's request, via a one-off script directly updating the 3 existing rows — `seed.py`'s own re-run doesn't update passwords on accounts that already exist, see its docstring): `owner@example.com`, `admin@example.com`, `user@example.com`. Shown directly on the `/login` page — there's nothing behind these accounts worth protecting in a local docker-compose demo, so no reason to hide them from whoever's running it.
  - **Verified end-to-end**: login issues a real JWT, `/me` round-trips it, an admin-gated route returns 501 (past the RBAC gate) with a valid admin token vs 403 with no token, wrong password correctly 401s.
- **Scope decision (2026-08-03)**: this is a resume/portfolio MVP meant to run locally and be demoed on video — not a real deployment. Real **Firebase** Auth and an actual EC2 deploy are still explicitly **not required** — the self-issued-JWT approach above satisfies "real auth" for the demo without needing a third-party identity provider or a cloud deploy. Don't push to build actual Firebase/cloud deploy unless the user asks.

**Phase 2 — RAG core**
- [x] Ingest pipeline (upload → parse → chunk → embed → vector store), **2026-08-04**: `backend/ingest.py` (`parse_document` for pdf/docx/md/txt, `chunk_text` — paragraph-aware, 800-char chunks/100 overlap) + `backend/apis/documents.py` (admin/owner-gated `POST /agent/documents/ingest`, `GET /agent/documents`, `DELETE /agent/documents/{id}`) + `Document`/`DocumentChunk` tables (`backend/models.py`, `Vector(768)` column). Files are archived to `DOCUMENT_STORAGE_DIR` first (uuid-prefixed filename) before parsing, satisfying the "asset library" requirement — `DocumentManager` (frontend) is that FE-facing library. See the provider-swap architecture note above for why the embedding column is a fixed 768 dims.
- [x] Query API with source citations, **2026-08-04, later folded into `/api/chat`**: originally `backend/apis/rag.py`'s own public `POST /api/rag/query` endpoint (embed the question, pgvector cosine-similarity search over `status="ready"` chunks, build a context block, ask the chat provider to answer from it, return `{answer, sources: [...]}`, canned "I don't have that information" when nothing matched). Retired the same day once `/knowledge` was merged into `/chat` — see the "RAG merged into the main chatbot" section above for why and how. The retrieval logic didn't disappear, it moved to `backend/retrieval.py` and is now called from `backend/apis/chat.py`.
- [x] Local embedding model via Ollama (nomic-embed-text) — pulled by the user 2026-08-04, confirmed working (768 dims).
- [x] **Full end-to-end verification, 2026-08-04**: ingested a synthetic ~1.5MB/2196-chunk test document (`status` went `processing` → `ready`, `chunk_count: 2196`), then queried it in **Chinese** ("公司是做什么的？") against **English** source content — got back a correct, grounded English answer plus 5 real citations with excerpts and similarity scores, confirming both the pipeline and cross-lingual retrieval/generation work. Test document deleted afterward so the DB starts clean for the user's own real-document test.
- [x] **Real bug found + fixed during that test**: Ollama's `/v1/embeddings` silently breaks on large batches — works fine up to ~200 texts in one call, fails at ~300+ with `dial tcp 127.0.0.1:PORT: connectex: ... actively refused` (its internal tokenizer subprocess drops the connection), returned to callers as a bare 400. Reproduced directly against Ollama (bypassing this codebase) to confirm it wasn't our bug, then binary-searched the threshold (200 succeeds, 300 fails, confirmed not a permanent crash — a fresh small batch right after a failed big one still succeeds). Since `chunk_text`'s default 800-char chunks mean any document past roughly 150-200KB of extracted text produces 200+ chunks, this would have broken ingestion for any realistically-sized real document, not just this session's stress test. Fixed in `backend/providers/ollama.py`'s `OllamaEmbeddingProvider.embed()`: internally splits `texts` into sub-batches of 128 (comfortable margin under the observed ~200 line) and makes one sequential HTTP call per sub-batch, concatenating results in order. Other providers (OpenAI/Gemini) may have their own batch ceilings but weren't touched — they're still key-gated/unverified, not worth guessing a limit for before they're ever actually called.
- [x] Frontend UI — originally a standalone `/knowledge` page + `KnowledgeQueryPanel`; retired the same day the RAG-into-chat merge happened, see above — RAG-grounded answers now render inline in `/chat` via `ChatMessageBubble` + `SourceCitationList`. `DocumentManager` (admin/owner, on `/dashboard`) still handles upload/list/delete against the real ingest API, unaffected by the merge. See `frontend/AGENTS.md` for the current component catalog.

**Phase 3 — Chatbot**
- [x] Backend endpoint — `POST /api/chat` (`backend/apis/chat.py`) calls local Ollama's OpenAI-compatible `/v1/chat/completions`, model configurable via `OLLAMA_CHAT_MODEL` (default `gemma4:latest`). **Verified end-to-end** through Docker (frontend container → backend container → host Ollama → back), ~15-17s per reply on `gemma4:latest`. Required two host-side fixes, see gotchas below: Ollama's bind address, and CORS on the backend (browser calls from :3000 to :8000 are cross-origin). **Refactored 2026-08-04** to go through the `ChatProvider` abstraction (`resolve_chat_provider`, see the owner-facing model picker note above) instead of a hardcoded direct Ollama call — it had been bypassing `providers/` entirely since before that abstraction existed; now the owner's dashboard-selected chat model actually applies here too, not just to RAG answers. **RAG-merged the same day** — see "RAG merged into the main chatbot" above; this is now the only place both plain conversation and document-grounded answers happen, replacing the separate `/knowledge` page.
- [ ] Streaming (SSE/WebSocket) — current endpoint is a single non-streaming call; plan calls for streaming
- [ ] Intent recognition + structured field extraction + CRM placeholder — the frontend's scripted flow (below) mimics the *shape* of this but doesn't call an LLM for it
- [x] Frontend UI shell — `/chat` page + `ChatPanel`/`ChatMessageBubble`/`ChatControlRenderer`. Steps 0-3 (category → tags → channel → free text) are a **scripted local flow**, not LLM-driven — demonstrates the `{type, options}` structured-control-rendering contract. Once that flow completes, further free-text messages call the real `POST /api/chat` endpoint via `frontend/src/lib/chat.ts`. Auto-scrolls to the newest message (`bottomRef` + `scrollIntoView` in `chat-panel.tsx`).
- `backend/apis/chat.py`'s `SYSTEM_PROMPT` was tuned 2026-08-03 — the first version made `gemma4:latest` deflect simple/off-topic questions ("what is 1+1" → refused) and give vague non-answers about itself. Rewritten to explicitly permit direct answers to general questions and honest self-description; quality improved noticeably on the same model. If replies feel evasive/generic again, revisit this prompt before assuming it's a model-capability ceiling.

**Phase 4 — CTE editor**
- [x] **Real, 2026-08-04 — deliberately NOT GrapesJS.** Before building, flagged to the user that the original plan's "integrate GrapesJS" is the one place in this project where the named tech pick actively conflicts with an architecture decision made later: GrapesJS edits raw HTML/CSS directly, but this project's landing-page story (Phase 5, see below) is built specifically so an LLM/editor never touches raw markup — only a typed `PageSection`. User agreed on a lightweight, schema-native editor instead — same call as the earlier Astro→Next.js swap: a named-in-the-plan tech choice overridden for a documented reason, not silently dropped.
  - **How it works**: `components/theme/cte/` — a `CteProvider`/`useCte()` context, an `Editable` wrapper inserted directly into the 5 already-existing section components (`hero-section.tsx`, `feature-grid-section.tsx`, `text-block-section.tsx`, `cta-banner-section.tsx`, `badge-list-section.tsx`) around their headline/body/image/item/CTA output — the exact same components every public page already renders through, so the editor is pixel-identical to production, not a parallel preview surface — and `lib/cte.ts`'s `setByPath()` (hand-rolled, lodash-`_.set`-shaped immutable updater over the `sections` array). `/editor` (`CteEditorPanel`, admin/owner-gated like the rest of the agent console) loads an existing slug via the same `getPublicPage`/`savePageVersion` used by `PageGeneratorPanel`'s save flow — no backend changes needed for the editing mechanism itself, CTE edits are just another `PageSection[]` save. `/editor` only edits *existing* saved content — there's no blank-page/add-new-section path; generating new content is still `PageGeneratorPanel`'s job.
  - **Redesigned the next day (2026-08-05) off real usage feedback** — four concrete problems with the first cut, all from the user actually trying it:
    1. **Popover positioning was broken near the bottom of a page.** The original editor was a `position: fixed` box positioned via `getBoundingClientRect()` next to the click, clamped to stay on-screen — but a block near the bottom of a long page could still push it partly/fully off-screen, and because it was `position: fixed`, scrolling afterward couldn't bring it into view (fixed elements track the viewport, not the page). **Fixed by switching to a `Sheet`** (shadcn/base-ui, already used by `MobileNav`) — always renders at a fixed screen edge regardless of click position, sidesteps the whole class of bug, and incidentally made room for a real form instead of a cramped 320px box (see the image editor below). `cte-editor-popover.tsx` keeps its filename despite no longer being a popover, to avoid a needless rename on top of the redesign.
    2. **Hover-based discovery doesn't work on mobile, and "click anywhere in the block" broke down for stacked/overlapping content.** `TextBlockSection`'s `background_image` variant (a photo with heading/body text on top of it) was the concrete case that surfaced this: the whole image was one giant click target competing with the text on top of it, so a click meant to edit the image could only ever resolve to whichever element was on top — no way to reach the image at all. **Fixed by replacing whole-block hover-outlines with a small, explicit pencil-icon button**, always visible while edit mode is on (no hover needed) and rendered as a DOM **sibling** of the field's content, never nested inside it — text fields get an inline pencil right after the text, block fields (image, feature-item, CTA) get one pinned to a corner. The sibling relationship is what actually fixes the stacked-element problem: the background image's badge and the heading's badge now live in genuinely different screen positions instead of competing for the same click area. It's also why a badge nested inside a `<Link>` (feature cards, CTA buttons) never triggers that link's navigation — being a sibling, its click never reaches the anchor at all.
    3. **"Edit mode" is now an explicit `Switch` in `CteEditorPanel`'s toolbar**, off by default — `CteProvider`'s `active` prop is driven by it directly, so a freshly-loaded page looks exactly like the live site until you deliberately flip the switch on. This is what makes the badges from point 2 discoverable without hover in the first place (the switch, not proximity, is what reveals them) and doubles as a real preview toggle.
    4. **CTA buttons (Hero + CtaBannerSection) are now editable** (label + href, new `"cta"` fieldType) — the first version had no way to edit them at all, an explicit scope cut that turned out to matter in real use.
  - **Image editing grew from a 2-field URL/alt form into 4 tabs** (`ImageFieldEditor`, used by both the standalone "image" fieldType and feature-item's nested image): URL (unchanged), Upload (`FileDropzone` → base64 → `POST /agent/media/upload`), Generate (reuses `generate_poster`, `lib/poster.ts`, with empty overlay text — no new backend generation endpoint needed), and Library (`GET /agent/media`, a grid picker). Prompted by the user wanting real image sourcing, not just pasting a URL you'd have to have gotten from somewhere else already.
  - **New backend: `apis/media.py` + the `.env`-ification described in "Configuration" above.** `GET /agent/media` merges two independently-configurable image sources — `COMFYUI_OUTPUT_DIR` (wherever the image-gen backend writes its own output; a "Generate" tab result lands here automatically, no extra save step) and a new `MEDIA_UPLOAD_DIR` (`/app/storage/media`, same bind-mount/`.dockerignore` pattern as `DOCUMENT_STORAGE_DIR`) — deliberately kept as two directories, not one, because the image-gen backend itself is expected to change (ComfyUI could be swapped for a different SD backend; the current install is portable and can move). `POST /agent/media/upload` saves into `MEDIA_UPLOAD_DIR`; a `StaticFiles` mount at `/api/media/uploads` (`main.py`) serves them back out — reading a known filename is unauthenticated (matches ComfyUI's own `/view` endpoint), only uploading and *listing* are admin-gated, so a filename isn't discoverable without the gated list endpoint. This is also what prompted converting `backend/apis/api.py`'s previously-hardcoded `COMFYUI_URL`/`COMFYUI_PUBLIC_URL`/`COMFYUI_WS_URL` constants to env-driven (same defaults, so nothing changed for existing callers) — building a second backend-served-image path made "everything ComfyUI-related is still hardcoded" impossible to justify leaving as-is.
  - **Scope cuts that still stand, decided while building, not asked about again**: padding/margin editing (named in the original plan) is still **not** built — the schema has no spacing fields, and adding arbitrary CSS would undercut the same "no raw generated CSS" principle `accent_color` was deliberately scoped around (see `theme.ts`); a future controlled enum (e.g. `spacing: "compact"|"normal"|"relaxed"`) is the natural follow-up, not open CSS. Carousel slides are still not editable either.
  - **Verified**: `setByPath` unit-tested directly (immutability, nested array/object paths including the new `cta`/feature-item-image shapes, sibling-reference preservation) via standalone Node scripts mirroring the TS logic. Full round-trips verified against the live backend via `curl` as a real admin for both the original fields and the new `cta` fieldType — saved a baseline, applied a CTE-shaped edit, read back and confirmed every field persisted correctly with version history intact; test pages deleted after. The new media endpoints verified directly: uploaded a real (tiny) PNG, confirmed it's listed by `GET /agent/media` alongside real ComfyUI output files and is fetchable at its returned URL; test upload deleted after. `docker compose config` confirmed the `.env`-ified compose file resolves to byte-identical values as the previous hardcoded version before applying it. `tsc --noEmit` and `eslint` both clean throughout. **Full interactive click-to-edit-in-a-real-browser (toggling the switch, clicking badges, the Sheet's tabs, drag-drop upload, an actual ComfyUI generation) was not possible to verify this session — no working Chrome extension connection either time.** This is the one real gap: everything above is verified at the API/logic level, not through an actual browser session. Worth a manual click-through before calling this fully done.
  - **Real, more serious bug found from a screenshot, same day**: `Editable`'s inactive path (edit mode off — the *default* state on every public route, and on `/editor` itself before the Switch is flipped) used to be a bare `return <>{children}</>`, silently dropping `className` entirely. Harmless for text fields (nothing wrapped them before Editable existed either), but for `as="div"` block fields carrying real layout — HeroSection's/TextBlockSection's image wrapper (`aspect-[4/3] overflow-hidden rounded-2xl`) — this meant every image lost its aspect ratio, clipping, and border radius the instant edit mode was off, i.e. essentially always, on every real page. Caught from the user's own screenshot comparing the editor's placeholder box (rounded) against the same hero image after an upload+save (square corners). Fixed by always rendering the wrapping element with `className` applied when one was given — only the outline/badge is actually conditional on edit mode now. Verified by curling a real saved page (`/p/service`) post-fix and confirming `aspect-[4/3] w-full overflow-hidden rounded-2xl` is present in the server-rendered HTML on the public (non-editor) path. Same screenshot also surfaced two smaller polish issues, fixed alongside it: the corner badge used negative offsets (`-top-2 -right-2`) that got clipped by any wrapped content that also set `overflow-hidden` (exactly the image case) — moved to a fully-inset `top-2 right-2` so it can never be clipped; and CTA buttons' corner badge overlapped a small button's own label — CTA now uses the inline badge style instead. (Separately noticed while investigating: the `pages` table currently has a slug literally `"Home"`, capitalized, saved before the slug-normalization fix below existed — since Postgres slug lookups are case-sensitive and `/` specifically requests `getPublicPage("home")` lowercase, that saved page is only reachable at `/p/Home`, not `/`. Left as-is rather than silently renamed — flag to the user if it's meant to be the actual homepage.)
  - **Two more small fixes from the user's first real click-through, same day**: (1) the slug field (`CteEditorPanel` and `PageGeneratorPanel`'s `SavePageForm`) accepted any free text verbatim — typing a human-readable name like "Summer Promo!" would try to save/load a page literally titled that instead of a URL-safe slug. Fixed with a new shared `lib/slug.ts`'s `slugify()` (lowercase, whitespace/underscores → hyphens, strips anything else, collapses stray hyphens), applied right before the value is actually used (Load/Save), not per-keystroke, so typing isn't mangled mid-name — verified with a standalone unit test covering accented characters and all-hyphen edge cases. (2) `/editor` loading a saved page's default slug ("home") on page load felt broken — pressing "Load" immediately did nothing, only working after first interacting with the slug `<datalist>`. Root cause not fully pinned down (plausibly the browser's native datalist suggestion popup intercepting that first click since it renders right over the adjacent Load button; separately, "home" had nothing saved to it yet during testing, which some navigation would silently show as an easy-to-miss `EmptyState` rather than looking obviously "responded to") — fixed regardless of exact cause by auto-loading the default slug once on mount (removes the need for a first click at all) and adding Enter-to-submit on both slug inputs as a general robustness improvement.
  - **Second real bug found from a follow-up screenshot, same day**: the inline badge (text fields, CTA buttons) used `flex` for its own outer display instead of `inline-flex` — `flex` is block-level, so the badge was forced onto a new line *every single time*, independent of whether the preceding content actually left room for it on the current line. This looked like it uniquely broke short text and small buttons ("the pencil pushes the text up / half the button's badge is invisible") but was actually universal — short content just made the badge's forced new line visually collide with whatever rendered directly below it, while longer/taller content had enough vertical breathing room to hide the same bug. One-word fix (`inline-flex`) in `Editable`; verified via `tsc`/`eslint` and a restart, no dedicated new test since this is pure CSS display behavior, not logic.
  - **Insert/delete items within an existing array field, 2026-08-05 — explicitly NOT whole-section insert/reorder/delete.** Asked the user directly before building: should CTE let you add/remove whole sections too? Agreed no — a WordPress-style "only the reusable blocks we ship" ceiling on purpose, not full free-form page authoring, since a section-type picker with sensible per-type defaults pushes CTE toward duplicating `PageGeneratorPanel`'s job and reopens the section-ordering/reordering scope creep flagged when this was first discussed. What *did* ship: a new `"create"` mode on `CteSelection` (`lib/cte.ts`) — `AddItemButton` (`components/theme/cte/`, self-gates on edit mode) renders a dashed "+" tile after the last feature-grid item / CTA button, opens the same `CteEditorPopover` prefilled with a blank template, and saving appends via a new `appendByPath()` instead of replacing via `setByPath()`. Existing feature-item/CTA items also gained a Delete button in the popover footer (`onDelete` prop, gated behind a `window.confirm()`, matching `PageManager`'s pattern) — backed by a new `removeByPath()`. Both new path functions reuse the existing `setRecursive` internals plus a small new `getByPath` reader; `appendByPath` treats a missing array (e.g. a `HeroSection` with no `ctas` yet) as empty rather than throwing, so "add the first button" works. Badge-list items were deliberately left out of this — that field is already edited as one whole comma-separated list, so insert/delete is just editing the text, no separate UI needed. **Verified**: both new path functions unit-tested (append to existing/missing array, remove from the middle, remove-to-empty, immutability) via a standalone Node script; full round-trip verified via `curl` against a throwaway test page (added a hero CTA that didn't exist before, added a feature card, removed one, read back correctly); test page deleted afterward using the *new* `DELETE /agent/pages/{slug}` endpoint (see the page-storage entry below) instead of a manual `psql` cleanup for the first time this session.

**Phase 5 — Visual polish (post-core)**
- [x] Landing-page architecture decided and scaffolded 2026-08-03: vision LLM output is a **page-section schema** (`frontend/src/lib/theme.ts`'s `PageSection` union — hero/feature-grid/carousel/text-block/cta-banner/badge-list), not raw HTML/CSS. Rendering maps each section to a real reusable component (`frontend/src/components/theme/`, via `SectionRenderer`) — safe to render, stays on-brand, never needs pixel-perfect fidelity. Home page (`/`) renders through this from a hand-authored "default template" (`frontend/src/config/default-theme.ts`).
- [x] **About page converted to the same section schema, 2026-08-04**: `frontend/src/app/about/page.tsx` was hand-written JSX until now — rewritten to the same `getPublicPage("about")` + `SectionRenderer` + fallback pattern as `/` (fallback content is `DEFAULT_ABOUT_SECTIONS`, `frontend/src/config/default-theme.ts` — the old JSX's copy carried over verbatim, no content changes). This means About can now go through the same generate/save/publish/rollback pipeline as Home (`PageGeneratorPanel` + `PageManager` on `/dashboard`, see the page-storage entry below) instead of needing a code change to update — e.g. the owner could feed a real About-page design image through `generate_landing_page` and save it to the `"about"` slug. No backend changes needed — `backend/apis/pages.py`'s save/list/restore routes are already slug-generic, `"about"` is just another slug alongside `"home"`. Verified by curling the running dev server: page renders correctly through `SectionRenderer` off the fallback (nothing's been saved to `"about"` yet), all original content (background bio, 3 target-role cards, Next.js-over-Astro rationale, 4-item stack-rationale grid) present. `frontend/AGENTS.md`'s Routes section and `default-theme.ts` doc entry updated to match.
- [x] **`generate_landing_page` (`backend/apis/agent.py`) is real, not a stub**, as of 2026-08-03. Calls a vision-capable Ollama model (originally hardcoded to `OLLAMA_VISION_MODEL`, default `qwen3.6:latest`; owner-selectable as of 2026-08-04, see `resolve_vision_model` in the model-picker note above — the original "`gemma4` has no vision capability" claim here turned out to be stale, see the gotcha below) through the same OpenAI-compatible `/v1/chat/completions` endpoint `chat.py` uses, with an `image_url` content part + a schema-describing system prompt (`_VISION_SYSTEM_PROMPT`) asking for `{"sections": [...], "accent_color": "#rrggbb"}` JSON directly — never HTML. Response is cleaned (`_extract_json_object` strips qwen3.6's `<think>` blocks and ```` ```json ```` fences, since models don't reliably obey "no commentary") then validated through the same `GenerateLandingPageResponse` Pydantic model as the request contract, so a malformed/hallucinated model response surfaces as a clear 502 with the raw output attached, not a silent mismatch. RBAC still gates it correctly (`user` → 403, unaffected by this becoming a real implementation).
- [x] **Schema v2, same day**: first real-image test (a Wix orchard-site template screenshot) surfaced concrete gaps — no color at all, no way to show a photo in a hero or feature card (only icons), and blank space where an image should be since the LLM can't produce a working URL. Fixed by extending the schema (both `frontend/src/lib/theme.ts` and the mirrored Pydantic models): `HeroSection.image` and `FeatureItem.image` (optional `ThemeImage`, takes priority over `icon`), and a top-level `accent_color` hex string. A new `ThemeImageBox` component (`frontend/src/components/theme/`) renders a real `<img>` when a URL exists or a deterministic gradient-plus-alt-text placeholder when it's `"#"` — the LLM is told to always write a real `alt` description even though it can't provide a URL, so "no image" never means "blank". `SectionRenderer` applies `accent_color` as a scoped `--primary` CSS custom-property override (retints buttons/badges/icons; doesn't recompute `--primary-foreground` contrast — rough approximation, not full theming, on purpose). **Re-verified end-to-end** with the same Wix screenshot after these changes: hero correctly came back with both an `image` (real alt text: "A man and a woman in the orchard picking green apples...") and a `carousel` section for a second photo, ~64-89s per generation (vision + 36B + JSON — budget a minute or two, not seconds; endpoint timeout is 240s, don't reuse `chat.py`'s 60s).
- [x] **Lenient validation, same day**: a content-richer test image (hero + several feature-grids + testimonials + a cta-banner — a dozen-plus items in one generation) hit real qwen3.6 unreliability: some `FeatureItem`s missing `href`, a couple with fields smeared across two malformed entries. The endpoint used to validate the *whole* response in one shot (`GenerateLandingPageResponse(**parsed)`), so one bad card threw away an otherwise-good generation as a 502. Fixed two ways: (1) `FeatureItem.href` now defaults to `"#"` instead of being required — absorbs the model omitting it despite being told to write `"#"`; (2) `_coerce_sections()` validates each section, and each feature-grid item, independently via Pydantic's `TypeAdapter` — a malformed item/section is dropped, not fatal, and the endpoint only 502s if *nothing* survives. Verified via a direct unit call reproducing the user's exact failing shapes (`docker compose exec backend python -c "..."` importing `_coerce_sections`) — a valid item, an item missing only `href`, and two unsalvageable items (missing `title`/`description` entirely) went in; the first two survived, the last two were dropped, no exception. Same principle as `SectionRenderer`'s `default: return null` on the frontend for an unrecognized section type — degrade gracefully instead of all-or-nothing.
- [x] **Schema v3, same day**: comparing that same richer generation against its source design surfaced 3 concrete layout gaps — a text-block section that should've had a photo beside it, a feature-grid that should've been "heading left, grid right" instead of stacked, and a text-block that should've had a full-bleed background photo. Diagnosis mattered here: all three were **schema/component expressiveness gaps, not a model or context-length limitation** — the model's content extraction (grouping, copy, item counts) was already accurate; it simply had no field to express "there's a photo here" or "this is a split layout" because those fields didn't exist yet. Fixed by adding `TextBlockSection.image`/`image_position` (side-by-side text+photo, mirrors Hero's `image`), `TextBlockSection.background_image` (full-bleed photo + dark scrim behind the text — mutually exclusive with `image`), and `FeatureGridSection.layout: "stacked" | "split"` (split = heading/subheading in a left column, a 2-column item grid in a right column, capped at 2 cols regardless of `columns` since a split grid only gets ~2/3 of the container width). Mirrored in both `frontend/src/lib/theme.ts` and `backend/apis/agent.py`'s Pydantic models; prompt updated to describe all three.
- [x] **Follow-up diagnosis, same day**: re-tested with a fuller-page image and got the *actual* generated JSON this time (not just the rendered HTML) — confirmed the schema v3 fields work exactly as designed: the model correctly set `layout: "split"` on a feature-grid and `image` on the hero, both rendered correctly. The remaining rough edges (a text-block that set `image_position: "left"` but left `image: null`; a whole background-image text-block the model just didn't generate that run; three testimonial items using nonsensical icons — `bar-chart`, `settings`, `layout-dashboard`) are **LLM run-to-run non-determinism, not a schema or rendering bug** — same source image, same schema, different subset of visual detail surfaced each generation. Decided not to keep chasing this via more prompt tweaking (diminishing returns for a resume-MVP where "close enough" was always the bar). Only fix applied: added a `quote` icon (`icon-registry.ts`, mapped to lucide's `Quote`) and told the prompt to prefer it for testimonials/reviews — cheap, concrete win; left everything else as expected model variance.
- [x] **Stale-browser-tab false alarm, same day**: what looked like `background_image`/`layout` "not working" turned out to be the browser running a pre-schema-v3 JS bundle — confirmed the running container's code was correct (`docker compose exec frontend grep` showed both fields wired up), then a fresh page load (not just a refresh) picked up the current bundle and everything rendered exactly matching the generated JSON. **Recurring gotcha this session** (also hit for the chat panel's canned reply and the `nativeButton` warning): after a component with meaningfully different render output changes, don't trust an already-open tab's HMR patch — reload fully before concluding something's broken.
- [x] **Layout-choice heuristic sharpened, same day**: even with schema v3 working correctly, the model still sometimes picked `"stacked"` for a feature-grid whose source design was unambiguously a fixed split layout (narrow text column beside a wide 2×2 image grid, both starting at the same row) — this one wasn't stylistic variance, the source had one clearly correct answer. Rewrote the prompt's layout guidance from a vague "beside vs above" description to a concrete, checkable visual test (do the heading and the first grid image start at the same height on the same row?). **Confirmed working** on the user's next test — `layout: "split"` was chosen correctly with `columns` sensibly reduced to 2.
- [x] **`max_tokens` regression, same day — introduced then reverted within the hour**: chasing a separate "section 4 missing" report, hypothesized Ollama might be silently capping output length and set `"max_tokens": 4096` on the request as a preventive fix. This immediately broke generation entirely: `finish_reason: "length"` with a **completely empty** `message.content`. Root cause: qwen3.6 is a "thinking" model that spends a large, variable number of tokens on internal reasoning *before* it starts writing the actual JSON — 4096 was entirely consumed by that reasoning phase, leaving zero budget left to write any answer. Every prior successful test had run with no `max_tokens` set at all (Ollama defaults to the model's full context window), so the fix for a problem that was never actually confirmed to be a length issue introduced a guaranteed-failure length issue. **Reverted** — `max_tokens` is deliberately left unset, with a comment explaining why, so nobody reintroduces this. The `finish_reason` field added to the 502 error detail alongside this change is worth keeping, though — it's exactly what made this regression instantly diagnosable instead of another round of guessing.
- Net effect on the original "section 4 missing" question: still unresolved/unconfirmed — likely still model choice (well-formed, non-truncated JSON in every case actually inspected), not a length cap. Don't reach for `max_tokens` to fix that without first confirming `finish_reason: "length"` on an actual failing case.
- [ ] Swiper carousel section built (`carousel-section.tsx`) but unused by the current default template — no carousel content exists yet to feed it
- [ ] GSAP/ScrollTrigger — not started
- [x] Frontend upload UI built 2026-08-03: `/dashboard` → set dev role to `admin`/`owner` → `PageGeneratorPanel` (below the Agent console grid) → pick an image, optional notes, "Generate" → preview renders live via `SectionRenderer`.
- [x] **Page storage + publish + rollback, 2026-08-04**: a generated result used to live only in React state — closing the tab lost it, and there was no way to actually put it on the live site. Now: `Page`/`PageVersion` tables (`backend/models.py`, first real Alembic migration — see Phase 1 above), `backend/apis/pages.py` (admin-gated save/list-pages/list-versions/restore + a public `GET /api/pages/{slug}` with no RBAC, used by the site itself). **Every save creates a new version, never overwrites** — restore works by copying an old version's content into a new version on top, so history is never destroyed. Frontend: `PageGeneratorPanel`'s `SavePageForm` (pick a slug — existing via a datalist, or type a new one — + optional note + Save) and `PageManager` (list saved pages, expand version history, one-click Restore), both under `AgentConsoleSection`. `/` (slug `"home"`) and the new `/p/[slug]` route both fetch their content from the DB via `lib/pages.ts`'s `getPublicPage`, falling back to `DEFAULT_HOME_SECTIONS` only for `/` when nothing's saved yet (`/p/[slug]` 404s via `notFound()` if the slug doesn't exist). Both routes are `export const dynamic = "force-dynamic"` — no longer statically prerendered, by design, since the whole point is a save should show up without a rebuild. **Verified end-to-end**: save → appears live immediately, list/version-history/restore all round-tripped correctly via direct API calls, RBAC still enforced (403 for `user` on every admin route), public 404 for an unsaved/nonexistent slug.
- Two real bugs hit and fixed while building this — see the gotchas section below: (1) Server Components need a *different* backend base URL than the browser does (`INTERNAL_API_URL` vs `NEXT_PUBLIC_API_URL`); (2) Next.js's Server Component `fetch` cache and/or a corrupted `.next` dev cache silently served stale/404 results even under `force-dynamic` until the frontend's anonymous volumes were renewed.
- [x] **Delete, 2026-08-05**: the one page-storage operation still missing until now — `DELETE /agent/pages/{slug}` (admin-gated, `apis/pages.py`) deletes the `Page` row, cascading to every `PageVersion` via the existing FK's `ondelete="CASCADE"`. Unlike save/restore, this genuinely has no undo (no "new version on top" trick applies to deleting the whole page), so `PageManager`'s new Delete button gates it behind a plain `window.confirm()` rather than a full dialog component — a one-off destructive action in an internal admin tool didn't seem worth a new UI pattern for. Prompted by real cleanup need: this session left behind several throwaway test pages (`cte-test`, `cte-test2`, `delete-test`, ...) that had to be removed by hand via `psql` each time, since there was no way to do it through the UI/API at all. Verified end-to-end via `curl`: created a throwaway page, confirmed 403 without an admin token, 204 on delete with one, confirmed both the public read and a second delete attempt 404 afterward, and confirmed the `page_versions` row was actually gone (not orphaned) directly in Postgres.

**Phase 6 — Agent security layer**
- [x] Isolation principle decided (see "Architecture decision: agent execution must be isolated from the API process" above) — agent execution runs in a separate, narrowly-scoped worker, never in the `backend` process itself. Principle only; no worker exists yet.
- [ ] The separate worker/container itself — not started; build this *first*, before any `apis/agent.py` handler goes from 501 to a real implementation
- [ ] openclaw skill permission boundaries documented — not started (only a `comfyui` skill exists in `~/.openclaw/workspace/skills/`, no permission/logging docs yet)
- [ ] Agent action logging — not started
- [ ] Red-team pass (prompt injection, privilege escalation) — not started

**Backend, independent of the phases above**
- [x] Dockerized FastAPI + Postgres/pgvector + frontend services (`docker-compose.yml`)
- [x] ComfyUI wrapper API (`backend/apis/api.py`): text2img/img2img generation, job polling/cancel, text-overlay compositing — predates the job-search MVP plan as a standalone utility, but is no longer unrelated to it: `apis/agent.py`'s `generate_poster` (real as of 2026-08-04, see above) composes this module's functions directly
- [x] RBAC dependency framework (`backend/apis/deps.py`) — placeholder role source, real gating logic
- [x] Admin/owner agent-console route contracts reserved (`backend/apis/agent.py`) — originally all 501 until implemented; `generate_landing_page` (2026-08-03) and `generate_poster` (2026-08-04) are both real now, CRM/report are still 501
- [ ] Everything else (real chat intent/CRM, online-AI fallback) — not started; users (auth) and RAG are both done, see Phase 1 and Phase 2 above

## Frontend details

For the full reusable-component catalog (what exists, what it does, when
to reach for it), **read `frontend/AGENTS.md`** — don't re-derive it by
re-reading every component file. Keep that catalog in sync whenever a
component is added, renamed, or its API changes.

## Known gotchas worth remembering

- **Never run `npm run build` (or any command that writes `.next`) inside
  the live `frontend` container via `docker compose exec` while `next dev`
  is also running there** — confirmed 2026-08-04 to actually take the
  frontend down, not just a theoretical risk. Both processes share the
  same `.next` directory (bind-mounted, not the anonymous volume — see
  below); running a production build against it while the dev server is
  live corrupts its cache, the dev server auto-restarts into a broken
  state, and every route (including `/`) starts 404ing, exactly like the
  stale-cache gotcha two entries down but self-inflicted rather than
  incidental. Fix is the same: `docker compose up -d
  --renew-anon-volumes frontend`. To actually verify a production build
  compiles without risking this, use a one-off container instead:
  `docker compose run --rm frontend npm run build` (a fresh container,
  though it still shares the named/anonymous volumes — safest is to only
  do this when nothing else needs the frontend up at that moment) — or
  just trust `npm run lint` + TypeScript passing during normal dev-server
  hot-reload, which doesn't touch `.next` the same way.
- **Ollama must bind to all interfaces, not just loopback, for the backend
  container to reach it.** It shipped bound to `127.0.0.1:11434` by
  default (`OLLAMA_HOST` unset) — the backend container reaches the host
  via `host.docker.internal`, and a loopback-only Ollama is unreachable
  from inside a container (the request hangs until the client timeout
  rather than getting refused). **Fixed 2026-08-03**: user set
  `OLLAMA_HOST=0.0.0.0` (User env var) and restarted Ollama; it now
  listens on `::` (all interfaces). If Ollama ever gets reinstalled or the
  env var reset, this will silently regress — the symptom is `/api/chat`
  timing out after ~60s with an empty error message even though `curl
  http://localhost:11434/...` works fine directly from the host.
- **CORS**: the frontend (:3000) and backend (:8000) are different origins
  from the browser's perspective. `backend/main.py` adds `CORSMiddleware`
  allowing `http://localhost:3000` (override via `CORS_ALLOW_ORIGINS`,
  comma-separated, once a deployed frontend origin exists). Without this,
  browser calls to `/api/chat` fail CORS preflight even though `curl`
  against the same endpoint works fine (curl doesn't enforce CORS).
- This repo is **not a git repository** at the root. `frontend/` got its
  own nested git repo from `create-next-app`'s default init — that's an
  artifact of the scaffolding tool, not an intentional multi-repo setup.
- Next.js in `frontend/` is **v16** with React 19 — meaningfully different
  from most training-data-era Next.js knowledge. Its own
  `frontend/AGENTS.md` flags this; when in doubt, check
  `frontend/node_modules/next/dist/docs/` before assuming an API works the
  old way.
- shadcn/ui here uses the `base-nova` style, which is powered by
  `@base-ui/react`, **not Radix**. Composition uses a `render` prop
  (`<Button render={<Link href="/x" />}>`) instead of Radix's `asChild`.
  Passing a component/function prop (e.g. a Lucide icon) from a Server
  Component into a Client Component will fail RSC serialization — pass
  primitive values instead (see `frontend/src/components/layout/nav-link.tsx`
  for the pattern this bit us on once already).
- `frontend/Dockerfile` needs a `.dockerignore` (already added) excluding
  `node_modules`/`.next` — without it the build context was ~780MB and
  slow to transfer on every build.
- **Adding a new npm dependency requires more than `docker compose up
  --build`.** `frontend/node_modules` is an anonymous volume (so the
  container's Linux-native modules aren't shadowed by the host's Windows
  ones — see above) — but Compose *reuses* an existing anonymous volume
  across container recreation by default, so a plain rebuild+recreate
  still mounts the stale pre-dependency volume and the new package 404s
  ("Module not found") even though the image itself has it. Fix: `docker
  compose up -d --build --renew-anon-volumes frontend` (hit this exact
  issue adding `swiper` 2026-08-03).
- **Server Components need a different backend base URL than the browser
  does.** The browser reaches the backend at `http://localhost:8000`
  (docker-compose publishes that port to the host) — but Server Components
  run *inside the frontend container*, where `localhost:8000` means that
  container's own (nothing-listening) port 8000, not the backend's.
  `frontend/src/lib/api.ts` picks the base URL based on `typeof window`:
  `NEXT_PUBLIC_API_URL` in the browser, `INTERNAL_API_URL`
  (`http://backend:8000`, the docker-compose *service name*, resolved via
  Docker's internal DNS) on the server. Hit this building the page-storage
  feature — `/` and `/p/[slug]` are Server Components that need to reach
  the backend, and the browser-facing URL silently failed there. If a
  Server Component's fetch to the backend fails/hangs, check which env var
  it's actually using before assuming the backend itself is down.
- **A corrupted/stale `.next` dev cache can make working pages 404 —
  broader than just "new dependency needs a volume renew" (above).** While
  debugging the page-storage feature, `/dashboard` (a long-working,
  completely unrelated route) started returning 404 after a plain
  `docker compose restart frontend` — not a code bug, not a new
  dependency, just a bad dev-cache state that neither a restart nor
  deleting `.next/cache` from inside the container fixed. Fix: `docker
  compose up -d --renew-anon-volumes frontend` (same remedy as the
  new-dependency case, but reach for it any time an existing route
  inexplicably 404s/serves stale content with no corresponding code
  change — don't assume it must be a fetch-caching or logic bug first).
- **A brand-new route file 404ing is usually simpler than the above**:
  Turbopack dev mode doesn't always pick up a freshly-created `page.tsx`
  (e.g. `app/login/page.tsx`) until the dev server restarts, even though
  it hot-reloads *edits* to existing routes fine. Try a plain `docker
  compose restart frontend` first for a new route that 404s — only reach
  for `--renew-anon-volumes` if a restart alone doesn't fix it (that's the
  signal it's the deeper cache-corruption case above, not just route
  discovery). **The reverse happens too**: deleting a route file
  (`app/knowledge/page.tsx`, removed 2026-08-04 when `/knowledge` merged
  into `/chat`) kept serving 200s from the stale route table until a
  plain restart — same fix, same root cause, just triggered by removal
  instead of addition. See `frontend/AGENTS.md`'s Routes section for the
  specific case.
- **Ollama's `/v1/embeddings` breaks on large batches** — confirmed 2026-08-04
  while doing the first real RAG ingest test. Works fine up to ~200 texts in
  one request, fails at ~300+ with the internal tokenizer subprocess
  refusing the connection (400 back to the caller, not a timeout). A
  document past roughly 150-200KB of extracted text hits this via
  `ingest.py`'s default 800-char chunking. Fixed in
  `backend/providers/ollama.py` by sub-batching `embed()` calls at 128
  texts per request — see the Phase 2 entry above for the full
  root-cause writeup. If a *different* Ollama version/model ever regresses
  this at a different threshold, the batch size is the one constant to
  check first, not chunk size or document size in isolation.
- **`gemma4`'s vision capability claim in this file may be stale.** The
  Phase 5 entries below state `gemma4` has no vision capability (checked
  2026-08-03 via `ollama list`'s `capabilities` column, which is why
  `OLLAMA_VISION_MODEL` defaults to `qwen3.6:latest`). Re-checking via
  `ollama show <model>`'s `capabilities` field on 2026-08-04 (while
  investigating the model-picker feature request, see "Suggested next
  step") shows `gemma4:latest` reporting `['completion', 'vision',
  'audio', 'tools', 'thinking']` — vision *and* audio, not none. Didn't
  change `OLLAMA_VISION_MODEL`'s default off the back of this alone
  (`ollama list` and `ollama show` may simply disagree, or the local model
  was updated between the two checks) — flagging so whoever builds the
  model-picker feature re-verifies capabilities from `ollama show` (or
  equivalent) live rather than trusting either past note.

## Suggested next step

Real Firebase Auth / EC2 deploy are explicitly out of scope (see Phase 1's
scope decision above) — don't suggest those as "next steps" unless asked.
Phase 2's RAG pipeline and the chat/knowledge merge are both done now (see
above) — don't suggest either as a next step anymore. The About-page
schema conversion (previously listed here as candidate (a)) is also done
now, 2026-08-04 — see the Phase 5 entry above — don't suggest it again.
Per-visitor session tracking/conversation persistence (previously
candidate (b)) is also done now, 2026-08-04, DB-only — see the "Visitor
conversation persistence" section above — don't suggest re-building the
persistence itself; the admin viewer UI that section deliberately left
out is still a legitimate follow-up (see below). The CTE click-to-edit
layer (previously candidate (a)) is also done now, 2026-08-04 — a
lightweight schema-native editor, not GrapesJS, see the Phase 4 entry
above — don't suggest rebuilding it; a real in-browser click-through
verification pass (not possible this session, no working Chrome
extension connection) and the deliberately-deferred padding/margin
editing are the legitimate follow-ups on it (see that entry). Reasonable
candidates now: (a) a `/dashboard` viewer for the chat sessions/messages
persisted earlier (session list + per-session transcript, admin/owner-
gated) — the natural follow-up now that there's something to browse,
deliberately deferred out of the persistence work itself to keep that
change small, (b) extending CTE's scope (per-section spacing controls,
CTA button/carousel editing) — see the Phase 4 entry's explicit scope
cuts for why these were left out of the first pass. Ask the user which.
