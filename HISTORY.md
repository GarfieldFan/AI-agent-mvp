# AI MVP — full development history

**This is the archive, not the entry point.** Frozen as a full copy of
`AGENTS.md` on 2026-08-06, at the point that file was split in two to
save context: `AGENTS.md` is now a short, current-state-only reference
(read it first, every session); this file is the complete chronological
log everything in `AGENTS.md` was condensed from — every bug found,
every decision debated, every verification run, in full narrative detail
with exact numbers/error messages/file paths.

**Read this only when `AGENTS.md`'s condensed version doesn't answer
your question** — e.g. you need the *exact* reasoning behind a specific
design call, a past bug's root-cause story, or how a feature evolved
across several iterations. Don't read it top-to-bottom by default; grep
for the topic you need. New work should still update `AGENTS.md` going
forward — only append here if you're deliberately preserving a detailed
narrative that doesn't belong in the lean reference.

---

Everything below this point is the original, unedited log, preserved
as-is from before the split.

---

# AI MVP — project log (original, pre-split)

Read this before doing anything else in this repo. It exists so any AI
agent session (Claude Code or otherwise) can pick up work without
re-deriving context from scratch. Keep it current: update the relevant
section whenever you finish a chunk of work, not just at the end of a
session.

An original project plan (positioning, tech choices, module list, phased
build order) existed as a local planning document, not tracked in this
repo — this file tracks *status against real, verified behavior*, not a
plan.

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
│       ├── agent.py           admin/owner-only "agent console" — generate_landing_page, generate_poster, generate_geo_page, CRM entry capture, report generation: all real
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
worth remembering:**
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
- **Scope decision (2026-08-03)**: this is an MVP meant to run locally, not a real deployment (at the time — real deployment automation was added later, see the root AGENTS.md's "Deploying to a real server" section). Real **Firebase** Auth and an actual EC2 deploy were still explicitly **not required** at this point — the self-issued-JWT approach above satisfies "real auth" without needing a third-party identity provider or a cloud deploy. Don't push to build actual Firebase/cloud deploy unless the user asks.
- [x] **Real bug fixed, 2026-08-05: an expired session left the header's login widget showing the old logged-in user indefinitely.** Reported directly: after a token expired, admin-gated sections correctly started 403ing (the backend was never wrong here — see `apis/deps.py`'s docstring, it deliberately never hard-401s on a bad/expired token, silently downgrading to the anonymous `user` role instead, since the public chatbot needs to keep working with no token at all), but `AuthStatus` in the header kept showing the stale logged-in email/role, since nothing ever actually cleared the stale `localStorage` entry — there was no server 401 to react to in the first place, by design. Fixed entirely client-side in `frontend/src/lib/auth.ts`: `getAuthToken()` (called by `apiFetch` on every single request, to build the `Authorization` header) now decodes the token's own `exp` claim and, if expired (or the token fails to decode at all — treated the same as expired, safest default), calls the real `clearAuth()` — removing the stored session *and* firing the change event every `useAuth()` subscriber listens for — right there, before the request even goes out. `useAuth()`'s own snapshot function (`getAuthState()`) got a matching pure (non-mutating) expiry check, since it backs `useSyncExternalStore` and mutating storage inside a snapshot read isn't safe (this file already has one documented "infinite loop" bug from a purity violation — the fix deliberately keeps the two functions' responsibilities split: `getAuthState()` stays a pure read, `getAuthToken()` is where the actual side-effecting cleanup happens, since it's called from `apiFetch`, outside any render). Net effect: the header updates to "logged out" as part of the very request that would have 403'd anyway, not on some later unrelated re-render. Verified: JWT expiry-decode logic tested directly (a real freshly-issued token → not expired; a synthetic token with a past `exp` → expired; a garbage/non-JWT string → treated as expired) via a standalone Node script mirroring the TS logic; confirmed `apiFetch` is the *only* caller of `getAuthToken()` in the codebase, so every authenticated request goes through this one fixed choke point. `tsc`/`eslint` clean, full route sweep clean after a restart.

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

### Generic Container/Image/Text/Button block schema, 2026-08-05

Prompted by a concrete gap the user found comparing a Wix source design
against its generated result: the source had a row split into two 50/50
columns, each with its own padding, holding a photo and a caption — the
generator only managed to approximate the padding, with no way to
express the actual row/column structure at all, since every existing
section type is a fixed composite shape (a feature-grid is always a
uniform card grid, a hero is always one fixed two-column split, etc.).

**Scope, agreed with the user before building**: NOT a WordPress-Gutenberg-
style general block library — a small, fixed set of four primitives
(`ImageBlock`, `TextContentBlock`, `ButtonBlock`, `ContainerBlock`), no
input/textarea/select-type blocks (the chatbot already handles
interactive needs), and no free-form CSS anywhere — every style knob is a
constrained enum or a plain hex color string, the same controlled pattern
`accent_color` already established. `ContainerBlock` (`layout: "row" |
"column" | "grid"`) is the one new idea: it holds a `children: Block[]`
array that can include more containers, so "a row of two padded columns"
is just two levels of nesting, not a special case — and it doubles as
both a top-level `PageSection` (`SectionRenderer` gained a `"container"`
case) and a nested child, same shape either way.

**Deliberately staged, riskiest part first, nothing built ahead of
verifying the previous step**:
1. **Schema** (`frontend/src/lib/theme.ts`): the four block types plus
   `Block = ImageBlock | TextContentBlock | ButtonBlock | ContainerBlock`,
   `ContainerBlock` added to the `PageSection` union. Named the text
   primitive `TextContentBlock`, not `TextBlock`, to avoid colliding with
   the existing, unrelated `TextBlockSection`.
2. **Frontend renderers** (`components/theme/blocks/`): `BlockRenderer`
   (dispatches on `block.type`) is mutually recursive with
   `ContainerBlock` — the one genuinely tree-shaped part of this schema,
   everything else stays flat. `layout: "row"` gives each direct child
   `flex-1 min-w-0` (via `itemClassName`) so columns actually split 50/50
   instead of sizing to content. Enum props map to Tailwind classes via
   lookup tables, same pattern as every other section component; color
   fields are applied as plain inline `style`, same as `accent_color`.
3. **Backend Pydantic mirror** (`backend/apis/agent.py`): the same four
   models plus a self-referential discriminated union
   (`ContainerBlock.children: list["Block"]`, resolved via
   `model_rebuild()`, standard Pydantic v2 pattern). `_coerce_sections`'
   per-section leniency was **not** extended inside a container's
   `children` — a malformed nested block fails the whole container, not
   just that child; deliberately deferred rather than guessed at.
4. **Vision prompt**: a 7th section type description with "when to use
   this over a feature-grid" guidance, a worked two-column example, and
   an explicit "prefer section types 1-6 over Container whenever one
   already fits" rule — Container is structurally riskier
   (nested/recursive) than anything else in the prompt.
5. **Verified at the schema/rendering layer only, not yet against the
   vision LLM**: a real nested container (two padded columns) validated
   correctly through the real Pydantic models and rendered correctly
   (50/50 split, padding, border, text) on a real saved page; `tsc`/
   `eslint` clean. **Explicitly deferred**: whether qwen3.6 can actually
   produce a correct nested-container structure from a real design image
   — left for the user to try before further investment (CTE editing
   support for these blocks hasn't been built and shouldn't be until
   generation quality is confirmed usable).
6. **Scope cuts, not built**: CTE (click-to-edit) support for the new
   block types — matches the agreed build order (validate generation
   quality before investing in editing UI). A checkpoint commit exists in
   both git repos from immediately before this schema work started, in
   case real-image testing shows the direction doesn't pan out.
7. **First real test run against a real image, two bugs found.** (a)
   `FeatureGridSection`'s `key={item.title}` broke on a duplicate-empty-
   title item — switched to `key={itemIndex}`, same pattern already used
   for CTA keys elsewhere. (b) A long, deep generation (hero + several
   feature-grids + a container) failed with a genuine JSON syntax error
   (`finish_reason=None`, not the `max_tokens`/truncation case noted
   above) — root cause was an unescaped literal newline inside a JSON
   string value. **Fixed by adding `json-repair` (PyPI) as a fallback,
   never a replacement**: strict `json.loads()` still runs first on every
   generation; `repair_json()` only kicks in after strict parsing has
   already failed, so a systematically broken prompt still surfaces as a
   loud error rather than being silently papered over. Verified against a
   synthetic repro of the same error class at two different string
   positions; strict parsing still succeeds unmodified for well-formed
   input. Not yet verified against the actual failing generation from
   this session.
8. **First real vision-LLM test of the schema — genuinely close.** The
   model correctly reached for `container` for the "row of two padded
   sections" pattern this schema was built for, unprompted by `notes` —
   real validation that the "prefer 1-6" prompt rule doesn't stop the
   model from using Container when it genuinely fits. Three findings:
   - **Bug**: an image with `aspect_ratio: "auto"` inside a `row`
     container collapsed to ~0px tall — `"auto"` applied no aspect class
     and no explicit height, and a `flex-1` child with nothing to resolve
     `h-full` against collapses to its content's near-zero natural height.
     Every other image-rendering component in the codebase always applies
     a fixed ratio for exactly this reason; `ImageBlock` was the one that
     didn't. Fixed: `"auto"` now falls back to the `"video"` ratio.
   - **Prompt gap**: a large photo section with no heading was silently
     dropped from the output — none of the 7 section types obviously fit
     "just a photo, no text." The schema could already express this (a
     `container` holding one `image` block); added a rule + example.
   - **Schema + prompt gap**: testimonial avatars got mapped onto the
     rectangular `FeatureCardWithImage` style. Added
     `FeatureItem.image_style?: "photo" | "avatar"` (default `"photo"`)
     and a new `FeatureCardAvatar` component for the circular case.
   - **Full-bleed, same day**: `ContainerBlock.full_bleed?: boolean`
     (default `false`) skips the page's max-width wrapper for that one
     top-level section only — nested containers are already inside their
     parent's box, nothing to break out of. Prompt: set it when a
     photo/background visibly touches both page edges.
   All four verified via real saved pages / rendered HTML (test pages
   deleted after).
9. **Second test round, three generations compared as raw JSON.**
   - **Schema gap, fixed**: added `HeroSection.background_color?: string`
     (plain hex, same controlled pattern as `ContainerBlock`'s) for a
     colored-banner-then-separate-photo pattern Hero couldn't express at
     all before. Prompt: that pattern is TWO sections (a background-color
     hero, then a `full_bleed` container with the photo), not one hero
     forcing the photo into its own `image` slot.
   - **Reliability finding, prompt-mitigated, not solved**: one
     generation mangled a 3-column layout into 4+ levels of nested
     containers with an empty `children: []` — confirms the risk flagged
     before this schema was built (deep/recursive JSON is measurably
     harder for the model than a flat section list). Mitigated with a
     prompt change: prefer a single `layout: "grid"` container over
     nested `row`>`column` for N *equal-width* columns, a stated 2-level
     nesting expectation, and a "never emit an empty `children: []`" rule.
   - **Reliability finding, not fixed**: `feature-grid`'s `layout:
     "split"` was the correct call in one case despite existing detection
     guidance (see "Layout-choice heuristic sharpened," Phase 5). Added
     one more specific check; flagged to the user that further tuning
     here may have diminishing returns, same conclusion reached once
     before for a different generation-quality issue.
10. **Third test round, three more generations compared item-by-item.**
    - **Fixed**: full-bleed images shouldn't be rounded — prompt now says
      `rounded: "none"` specifically for them.
    - **Fixed**: a color-banner hero (no image) had full hero-sized
      vertical padding. `hero-section.tsx` now treats "`background_color`
      set, no `image`" as a compact banner (`py-10 sm:py-14` vs the
      normal `py-20 sm:py-28`); every other hero renders unchanged.
    - **Fixed**: a feature-grid's incomplete last row left a dead gap
      instead of the remaining cards stretching to fill it — CSS Grid
      can't redistribute a short row's leftover space across fixed
      column tracks. Switched the "stacked" layout's item row (only that
      one; `"split"`'s fixed 2-column grid was untouched) from `grid` to
      `flex flex-wrap` with `grow` on each item, matching Grid's original
      per-row height behavior otherwise.
11. **Uneven row-column width ratios — landed after a real architecture
    conversation, not silently added.** The user asked why `HeroSection`
    needs to exist separately from `ContainerBlock` at all, given it's
    structurally just a row of columns. Answer: not structural necessity
    — a *reliability* tradeoff already validated twice this session
    (nested `container`/`Block` JSON is measurably more error-prone for
    the model than the flat composite sections, see finding 9's nesting
    bug). Decision: the fixed composite types stay the preferred/reliable
    path; general layout flexibility (uneven splits) goes only on
    `ContainerBlock`, not Hero.
    - **Shipped**: `BlockWidth` (`"auto" | "1/4" | "1/3" | "1/2" | "2/3" |
      "3/4" | "full"`) on all four block types, meaningful only as a
      direct child of a `layout: "row"` container. Deliberately a small
      fixed set of stops, not an arbitrary fraction — the user's own
      framing ("不需要精确到 3/5, AI 能分析出来、效果出来就行"): the
      model noticing *some* columns are uneven matters more than the
      exact ratio. Verified Pydantic rejects out-of-set values.
      `"auto"` (the default) keeps the prior equal-split behavior
      unchanged; fixed-ratio children get `shrink-0 grow-0` to hold their
      share exactly. Verified: correct Tailwind classes present for both
      a `1/3`+`2/3` row and an all-`auto` row in the rendered HTML.
12. **Fourth test round — one real code bug, two prompt reinforcements,
    two architecture conversations.**
    - **Real bug, my mistake**: finding 10's incomplete-last-row fix
      *still* didn't trigger this round — an earlier "verified" claim had
      only checked the CSS classes were present, never that the grow
      behavior actually had room to run. Root cause: `AddItemButton`'s
      wrapping `<div>` rendered unconditionally even though the button
      itself returns `null` outside edit mode, silently adding an
      invisible 6th flex item (5 real + 1 invisible = a false-complete
      two-row grid, no incomplete row left for `grow` to fill). Fixed by
      applying the classes directly to `AddItemButton`'s own element
      instead of a wrapper — re-verified by checking the actual rendered
      text was absent, not just a grep match against the RSC prop-
      serialization payload (which exists regardless of visible render).
    - **Two prompt reinforcements** for findings that didn't stick:
      full-bleed rounding (moved the rule directly next to the
      `"rounded"` field itself, worded as a hard "no exceptions" rule);
      the banner-as-Container guidance held up fine this round, no
      reinforcement needed.
    - **"Should the AI just write the CSS class itself?"** — the user's
      framing, since one case needed a short row to *stretch and fill*
      while another needed it to *leave genuine blank space*, two
      opposite behaviors no single hardcoded rule can produce. Answer:
      no — that would undo the "controlled enums only, never open CSS"
      principle this schema has held throughout. The actual gap was that
      the prompt never explained a second use of the existing `width`
      field: give every real child of a conceptually-N-column row an
      explicit `1/N` fraction (not `auto`) when fewer than N columns have
      real content, so the leftover space is reserved rather than
      stretched over. Documented as a second case under `width`; verified
      mechanically (non-growing `shrink-0 grow-0` classes present, so
      leftover space is genuinely unclaimed).
    - **"Should we remove `hero` entirely?"** — the user's follow-up,
      reasoning fewer section types means less for the model to choose
      between. Pushed back: Hero renders a real `<h1>`, `TextContentBlock`
      never does — an SEO/accessibility loss. The user's response: not
      concerned with classic SEO for this project, GEO (Generative Engine
      Optimization) matters more going forward, and a dedicated GEO page
      is planned as separate, later work (not started, not scoped).
      **Net decision: keep `hero`, unchanged** — this round's evidence
      didn't actually implicate it (the model correctly used `container`
      for the banner); the real remaining gaps are feature-grid/text-
      block boundary calls, not Hero. Nothing coded; revisit only if
      future evidence implicates Hero itself.

### Git checkpoint before the block-schema experiment, 2026-08-05

Neither repo existed before this — the project root had no version
control at all (only `frontend/` had its own repo, from `create-next-app`'s
scaffold init, a single commit with no remote). At the user's request,
initialized a **new root-level git repo** (`git init` at the project
root) to snapshot `backend/`, `docker-compose.yml`, both `AGENTS.md`
files, `.env.example`, etc. — deliberately kept **separate** from
`frontend/`'s existing repo rather than absorbing it (the user's explicit
choice when asked), so a rollback needs `git reset --hard` in both
places, not one. New root `.gitignore` excludes `.env` (machine-specific,
see `.env.example`), `.claude/` (personal Claude Code settings),
`backend/storage/` (runtime uploads — RAG documents, CTE media), Python
`__pycache__`, and `frontend/` itself. Both repos got one checkpoint
commit each, captured *before* any of this Container/Block schema work
landed, specifically so the user can cleanly roll back both sides
together if the new schema direction doesn't pan out. (Noticed but not
touched: `backend/nul`, a stray Windows artifact — excluded from git via
`.gitignore` rather than deleted, since deleting files that weren't asked
about isn't this session's call to make.)

### GEO/SEO company-profile page, 2026-08-05

The GEO (Generative Engine Optimization) idea flagged much earlier this
session as "planned, later work, not started" (see the block-schema
Phase 5 entries above — the "should we remove hero" conversation)
finally got built. **User's framing**: a page auto-generated from
whatever's already in the RAG knowledge base, primarily for search
engines/AI systems to read on a visitor's behalf, not a human-facing
landing page. Explicit scope, agreed before building: three actions —
generate, manually edit, delete — nothing more.

**Turned out to be genuinely simple, reusing almost the entire
`generate_landing_page` pipeline** — the core insight is that this is
the *same* schema-generation problem with a different input: text (RAG
document content) instead of an image, so it reuses the exact same
`PageSection`/`_coerce_sections`/`json_repair`-fallback validation
infrastructure, just swapping the vision-model raw-`httpx` call for the
already-provider-abstracted `resolve_chat_provider(db)` (plain text, no
vision needed) — actually a *better* fit for the provider-swappable
architecture than `generate_landing_page` itself, which still hardcodes
Ollama for vision (see the provider-swap architecture note near the top
of this file). New backend: `GEO_PAGE_SLUG = "seo"` (a single fixed
slug — there's exactly one canonical GEO page, not an admin-chosen one
like `PageGeneratorPanel`, so there's no slug picker and no separate
"save" step; generating auto-saves a new `PageVersion` in one request),
`_gather_ready_document_text()` (concatenates every `status="ready"`
document's chunks, already ordered by `chunk_index` via the ORM
relationship, up to a fixed 16,000-char budget — a simple cap, not real
retrieval/summarization, appropriate since "everything ingested" is
realistically a handful of documents at this project's scale), a
separate `_GEO_SYSTEM_PROMPT` (not shared with `_VISION_SYSTEM_PROMPT` —
genuinely different inputs, and this one explicitly forbids every
image/icon field since there are no photos to describe; some
duplication with the vision prompt's section shapes is the accepted
cost of keeping each prompt self-contained), and
`POST /agent/geo-page/generate`. Editing/deleting needed **zero new
backend code** — both reuse the already-generic `/editor` (CTE) and
`DELETE /agent/pages/{slug}` endpoints, since a GEO page is just another
`Page`/`PageVersion` row once saved.

Frontend: `GeoPagePanel` (`components/modules/`, added to
`agent-console-section.tsx` right after `DocumentManager`, since it
depends on what's ingested there) — Generate/Regenerate button, a
`SectionRenderer` preview, Edit (links to `/editor`, which already lists
`"seo"` in its own slug picker once generated — no query-param deep-link
was built for this, kept deliberately simple) and Delete (behind
`window.confirm()`, matching `PageManager`'s precedent) once a page
exists, an `EmptyState` before the first generation. `lib/geo-page.ts`'s
`generateGeoPage()` is the only new client function — status/preview
reuse `getPublicPage`/`listPageVersions`/`deletePage` from `lib/pages.ts`
unchanged.

**Hit the `react-hooks/set-state-in-effect` lint rule on the mount-fetch
effect** — same class of issue this codebase has hit before (see
`file-dropzone.tsx`'s and `image-field-editor.tsx`'s comments) but this
one had no clean event-driven trigger to move the fetch to (unlike
`ImageFieldEditor`'s tab-switch case) since it genuinely needs to run
once on mount. Resolved with an explicit, justified
`eslint-disable-next-line` rather than restructuring further — the
effect's empty dependency array means it only ever runs once, so the
rule's "cascading re-render" concern doesn't actually apply here, it's
just unable to tell that statically.

**Verified end-to-end for real, twice** — ingested a real synthetic
company-profile document via `POST /agent/documents/ingest`, called
`generate_geo_page`, and got back genuinely strong output: an accurate
hero, two factual text-block sections, a `feature-grid` with
`item_style: "list"` for services (following the prompt's instruction
correctly), a `badge-list` for certifications, and a `cta-banner` for
contact info — no hallucinated facts, no image/icon fields anywhere.
Confirmed the saved page rendered correctly at `/p/seo`. Also verified
the 400 error path (no ready documents ingested yet) and the exact API
shapes `GeoPagePanel` depends on (`getPublicPage`/`listPageVersions`
round-tripping the generated content correctly). Test document/page
deleted after both rounds.

**Hit two Docker/Turbopack gotchas back-to-back while verifying,
worth remembering together**: after the first real generation, `/p/seo`
404'd even though the backend had the data — the *deeper* stale
`.next`-cache gotcha (a plain restart wasn't enough; even the
previously-working `/p/service` started 404ing too). Ran the documented
fix, `docker compose up -d --renew-anon-volumes frontend` — which then
surfaced a *second*, different failure: `Module not found:
Can't resolve 'framer-motion'`. Root cause: `framer-motion` (added
earlier this session for the section move/delete animations) had only
ever been `npm install`-ed live inside the *running* container, never
rebuilt into the image itself — renewing the anonymous volume wiped that
live install, and the stale image underneath had no record of the
dependency. This is exactly the documented "adding a new npm dependency
requires more than a restart" gotcha, just discovered a full session
later than the dependency was actually added. Fixed with the *full*
remedy this file already prescribes for that case: `docker compose up -d
--build --renew-anon-volumes frontend`. Worth internalizing as one
lesson, not two: **any time `--renew-anon-volumes` is needed, check
first whether a live-only `npm install` happened since the last image
build — if so, `--build` is required too, not optional.**

**Not built, matching the agreed scope**: no meta `<title>`/description
support, no JSON-LD structured data, no sitemap entry, no automatic
regeneration triggered by document ingestion (generation stays a
deliberate admin click, consistent with every other agent-console
capability in this project — nothing here auto-triggers an LLM call
from a data-mutation event). Flag these as real follow-ups only if the
user decides the page needs to do more than just exist and be crawlable.

### CTE style editing (color, spacing, layout, typography), 2026-08-06

Up to this point CTE only edited *content* — text, images, feature items,
CTAs, badge lists — never *style*. The user asked directly for color,
background color, border, container/row/column, font size/weight,
position (clarified as justify/align, not CSS `position`), padding,
margin, and display — plus a specific architecture question: should
layout be unified around flexbox (`flex-direction` + `justify`/`align`
covering every left/right/top/bottom/center case) rather than keeping a
separate CSS Grid mode.

**Answered the flex question before building anything**: recommended
unifying on flex going forward — this project has already proven
`flex-wrap` handles the "N equal columns, wraps to new rows" case Grid
was originally for (see `FeatureGridSection`'s stacked-layout `grow`/
`basis-*` fix and the numbered-card grid, both earlier this session) —
but kept `ContainerBlock.layout: "grid"` as a value for backward
compatibility (renders unchanged) rather than deleting it; new alignment
capability (`justify`) only targets `row`/`column`, matching `align`'s
existing scope.

**Real scope realization surfaced before building, changed the plan**:
the requested style fields (`color`, `background_color`, `border_color`,
`size`, `weight`, `padding`) already existed in the schema — but *only*
on the generic Container/Image/Text/Button Block primitives, never on
the fixed composite sections' (Hero, FeatureGrid, ...) own text/CTA
fields, which render through hardcoded Tailwind classes with no per-
instance override at all. So "add style editing" and "wire CTE into the
Block system" (previously flagged, when the block schema was built, as a
bigger, deferred increment pending generation-quality confirmation —
which since happened, several rounds of real testing) turned out to be
the *same* piece of work, not separable. Flagged this to the user
explicitly rather than silently picking an interpretation; agreed to
scope this pass to full style+content editing for Block-based content
only, leaving the fixed composite sections' own text fields exactly as
before (content-only editing, no style override) — a real, legitimate
boundary, not an oversight.

**What shipped**:
- Schema: `ContainerBlock.justify?: "start"|"center"|"end"|"between"`
  (main-axis, `align`'s counterpart) and `ContainerBlock.margin?:
  "none"|"sm"|"md"|"lg"` (mirrors `padding`, applied outside the border)
  — `lib/theme.ts`, backend Pydantic mirror, and `container-block.tsx`'s
  new `JUSTIFY_CLASS`/`MARGIN_CLASS` lookups. An explicit `justify` now
  overrides the earlier `min_height`+`background_image` "anchor to
  bottom" heuristic rather than fighting it.
- **Path threading through the whole Block tree** — the real
  prerequisite for any of this, not previously needed since nothing in
  the Block system was clickable. `BlockRenderer` gained an `arrayPath`
  prop; each block's own path is `${arrayPath}.${index}`, and
  `ContainerBlock` passes `${path}.children` down to its own
  `BlockRenderer` call for its children — so a block at any nesting
  depth gets an unambiguous dot-path address using the exact same
  `setByPath` addressing scheme every other CTE field already uses, no
  separate mechanism needed. `SectionRenderer`'s `"container"` case seeds
  the recursion with `path={String(index)}` for a top-level container
  section.
- `ContainerBlock`/`ImageBlock`/`TextContentBlock`/`ButtonBlock` (the
  four block components) each wrapped in `Editable` now — new
  `EditableFieldType`s `"block-container"|"block-text"|"block-image"|
  "block-button"`, each editing the *whole* block object (content and
  style together, since they live on the same object for a Block, unlike
  the fixed sections' plain-string fields). `Editable` gained a `style`
  prop (forwarded on both the active and inactive render paths, same
  "must apply even when edit mode is off" reasoning as `className`'s
  2026-08-05 bugfix) so `ContainerBlock`'s inline `background_color`/
  `border_color` styles survive being wrapped. `block-text` joined
  `text`/`cta` in using the inline (not corner) badge style, since a text
  run reads more naturally with an inline edit affordance than a block
  does.
- New `CteEditorPopover` forms for all four, built on two new shared
  pieces: `EnumField` (a generic labeled `<Select>` over any small fixed
  option set, with an optional "Default" entry that clears the field back
  to `undefined` — covers layout/justify/align/gap/padding/margin/
  min_height/size/weight/text-align/aspect-ratio/rounded, one component
  instead of a bespoke dropdown per field) and `ColorField`
  (`components/theme/cte/color-field.tsx` — a native `<input
  type="color">` swatch paired with a hex text input and a Clear button;
  still a human picking one controlled hex value, the same value shape
  the schema already stores when a vision LLM sets it, not a new "free
  CSS" surface). `block-container`'s form also handles its optional
  `background_image` the same way `feature-item`'s image already does
  (Add/Remove toggle around `ImageFieldEditor`, not always-visible).
- **Deliberately deferred, not silently dropped**: editing/inserting/
  removing blocks within a container's `children` (only *existing*
  blocks' own fields are editable this pass — matches CTE's original
  "touch up what's there" scope decision, see the Phase 4 section
  above); editing `width` (`BlockWidth`, only meaningful as a row child).
  `onDelete` is correctly never passed for the new `block-*` fieldTypes
  in `CteEditorPanel` (already gated to `feature-item`/`cta` only, no
  code change needed there) — no delete affordance appears for these
  yet, consistent with insertion/removal being out of scope.
- **`setByPath`/`appendByPath`/`removeByPath` needed zero changes** —
  already generic dot-path array/object traversal, confirmed to handle
  arbitrary nesting depth (`"1.children.0.children.0"`) without any
  special-casing for the new block paths.

**Verified end-to-end for real, at three nesting depths in one test
page**: saved a page with a top-level `row` container holding a text/
image/button block, plus a second top-level container nesting a `column`
container one level deeper. Simulated a CTE edit at each depth — the top
container's own `justify`/`margin` (path `"0"`), its text child's
`color`/`size` (path `"0.children.0"`), and the twice-nested text's
`weight` (path `"1.children.0.children.0"`) — matching exactly what
`setByPath` would produce, then re-saved and confirmed all five edits
present in the actual rendered HTML (`justify-center`, `m-10`,
`text-2xl`, `style="color:#ff0000"`, `font-bold`), not just checked for
class-string presence in isolation. **Hit the recurring Turbopack/`.next`
gotchas twice more during this verification** — once the plain-restart
stale-bundle case (the new `justify`/`margin` classes were missing until
a restart, despite `tsc`/`eslint` already passing clean against the file
on disk), once the deeper generated-`.next/dev/types`-file syntax-error
case that needed `--renew-anon-volumes` (no `--build` this time — no new
dependency since the last one, only `--renew-anon-volumes` was needed).
Test page deleted after via the delete-page endpoint. **Not yet verified
in an actual browser** — no working Chrome extension connection this
session, same recurring gap as every other CTE-adjacent change; a real
click-through (dropdowns, the color picker, the background-image add/
remove toggle) should happen before calling this fully done.

### CTE style editing, part 2 — RichText for the fixed composite sections, 2026-08-06

The style-editing pass above only covered the generic Block system
(Container/Image/Text/Button) — the fixed composite sections (Hero,
FeatureGrid, TextBlock, CtaBanner, BadgeList) still had zero style
editing at all, only ever plain content (a `Textarea`, nothing else).
**User caught this directly**: even on pages built entirely from fixed
sections (Home, Service — no Block content at all), the *existing*
`"text"`/`"cta"` fieldTypes' editors should reasonably be expected to
carry at least color/size/weight and button color/background/link,
since those affordances already existed as editable badges — they just
opened a bare content-only form.

**Real design question this raised, resolved before building**: the
user proposed the fix directly — an API to update the JSON, the
frontend passes props to the component, same as everywhere else in this
schema. This is *not* a reopening of the earlier page-generator "should
the AI write CSS classes" decision (answered no, back when the block
schema was built) — the risk profile is different: this is an
authenticated admin editing through a controlled UI (dropdowns, a color
picker), never the vision LLM, and the data stays structured (a hex
color, a fixed size/weight enum) rather than a free class/CSS string.
Confirmed this framing with the user before touching code.

**The actual scope problem, found investigating**: `HeroSection.
headline` (and every other heading/body field across the 5 fixed
sections) was a bare `string` in the schema — nowhere to attach a
color/size/weight override *to*. Two ways to fix it: (a) a
`headline_color`/`headline_size`/`headline_weight` sibling field per
text field, which multiplies badly across 5 section types × 1-3 fields
each; (b) restructure every such field from `string` to `string |
RichText`, one shared shape. Chose (b) — bigger one-time change, but
doesn't repeat itself.

**What shipped**: `lib/theme.ts`'s `RichText = { content, color?, size?,
weight? }` (backend Pydantic mirror in `agent.py`) — `HeroSection.
headline`/`subheadline`, `FeatureGridSection.heading`/`subheading`/
`body`, `TextBlockSection.heading`/`body`, `CtaBannerSection.heading`/
`body`, `BadgeListSection.heading` all widened to `string | RichText`.
A plain string — every field's original shape, and the *only* shape the
vision LLM ever produces (the generation prompt was deliberately left
untouched; RichText is CTE-only, never AI-generated) — means "use this
section's own default styling, unchanged," so every existing saved page
and every future generation renders byte-for-byte the same. Only an
actual CTE edit that sets a color/size/weight promotes a field to the
object form. `ThemeCta` (shared by Hero/CtaBanner/FeatureGrid — one
type, not duplicated per section) gained `background_color`/
`text_color`/`border_color`, mirroring `ButtonBlock`'s existing pattern;
applied via a new `themeCtaStyle()` helper (`theme-cta-style.ts`) as
inline `style` on top of the existing `variant` palette — normal CSS
specificity means the inline colors win with no extra logic needed.

New shared helpers (`components/theme/rich-text.tsx`): `resolveRichText()`
normalizes `string | RichText` to the object form; `richTextClassName()`
returns just the override's Tailwind classes, meant to be appended
*after* a section's own fixed default classes in a `cn(...)` call —
`cn` (clsx + tailwind-merge) resolves the conflict by keeping the later
class, so the override wins without the call site needing to
conditionally omit its own base classes. **Known, accepted limitation**:
a default class that only applies at a responsive breakpoint (Hero's
headline has `sm:text-5xl`) lives in a different tailwind-merge "slot"
than a plain override class, so a size override on that one field only
fully applies below `sm` — confirmed exactly this in the real render
(`sm:text-5xl` survived a `size` override, `text-4xl` correctly didn't).
Not worth a bespoke per-breakpoint override system for a CTE
convenience feature.

**New `"rich-text"` `EditableFieldType`, deliberately separate from
`"text"`.** Reusing `"text"` for these fields (now object-capable) was
considered and rejected: `"text"` is still used for fields that were
*not* widened (Hero's `eyebrow`, badge-list's own heading is now
rich-text but the badges themselves aren't) — if the same fieldType
showed style controls unconditionally, saving a color onto a field
whose schema type is still plain `string` would write an object into a
slot that only ever expects a string, and the component rendering it
directly as `{eyebrow}` would crash (`Objects are not valid as a React
child`) the next time that page loaded. Keeping `"rich-text"` distinct
means the editor only ever shows style controls for fields that can
actually hold them. `CteEditorPopover`'s "cta" form also gained the
three `ColorField`s; both forms save the minimal shape (`"rich-text"`
falls back to a plain string when no color/size/weight is set, rather
than always writing an object).

**Verified end-to-end for real**: backend Pydantic models accept both
plain strings and RichText objects on all 5 section types plus the new
`ThemeCta` colors (tested directly). Saved a real page mixing plain and
styled fields across Hero/TextBlock/BadgeList (a styled headline with
color+size+weight, a plain subheadline, a colored CTA button, a plain
heading beside a styled body, a styled badge-list heading) and confirmed
every override present in the actual rendered HTML — including the
`text-4xl` → `text-3xl` tailwind-merge replacement working correctly (no
duplicate/conflicting classes) and the `sm:text-5xl` limitation
reproducing exactly as predicted. **Hit a real, if brief, false alarm
mid-verification**: the first load attempt 500'd with "Objects are not
valid as a React child (found: object with keys {size, color, weight,
content})" — looked like a real bug in some missed unresolved render
site, but a careful re-read of every touched component found nothing
wrong; a restart fixed it immediately, confirming it was the same
recurring Turbopack stale-bundle gotcha (several brand-new files plus
edits to five existing components since the last restart) rather than
an actual logic error — worth remembering not to trust a "must be a
real bug" instinct here before ruling out a stale bundle first, given
how consistently this exact gotcha has recurred all session. Test page
deleted after. **Still not verified in an actual browser** — same
recurring gap as every CTE change this session.

### CTE style editing, part 3 — more button params + live editing, 2026-08-06

Two follow-ups from the user after trying the style editing above: (1)
button styling was missing some obviously-common parameters (border
width/style, corner rounding, button size — colors alone weren't the
whole picture), and (2) a bigger UX complaint — every field edit
required an explicit Save click just to *see* whether a color/size
looked right, and the Sheet's dimmed/blurred backdrop made comparing the
change against the live page harder than it needed to be. Both were
scoped and built the same session, no separate confirmation round needed
— clear, concrete asks with an obvious implementation.

**Button params**: `ThemeCta` and `ButtonBlock` both gained `rounded?:
"none"|"sm"|"lg"|"full"` (same fixed-stop pattern as `ImageBlock`'s),
`size?: "sm"|"default"|"lg"` (every CTA button was hardcoded `size="lg"`
before this — a small button next to a large one is a common real
pattern), and `border_width?: "thin"|"thick"`. New shared helper
`theme-cta-style.ts`'s `themeButtonClassName()` (structurally typed, so
it works for both `ThemeCta` and `ButtonBlock` without a new shared base
type) — `rounded`/`border_width` become Tailwind classes appended after
the Button component's own base classes, same tailwind-merge
later-class-wins resolution as `richTextClassName`. Note: every shadcn
`Button` variant already carries a base 1px `border` regardless of
`variant`, so `border_color` was always visible once set even before
this — `border_width` only matters for asking for something *heavier*
than that default. Wired into all four CTA render sites (Hero,
CtaBanner, FeatureGrid's single `cta`) plus `ButtonBlock` itself.
Backend Pydantic mirror updated the same way.

**Live editing, the bigger piece.** Previously every `CteEditorPopover`
field kept local draft state and only pushed it into `sections` (and
thus the live preview) on an explicit "Save" click inside the sheet —
so checking whether a color looked right meant Save, look, reopen if
wrong, adjust, Save again. Fixed by making "edit" mode selections
(`selection.mode !== "create"`) apply live: a `useEffect` watching every
draft-state variable across every fieldType's form calls `onSave(
computeValue())` on each change, with the sheet staying open throughout
(`CteEditorPanel`'s `handleFieldSave` no longer closes the selection for
edit-mode saves — only "create" mode's explicit Add still does, see
below). `handleSave`'s old branching logic was extracted into a pure
`computeValue()` function so both the live effect and the explicit Add
button share one calculation instead of two copies that could drift.
The Sheet's Save/Cancel footer button pair is gone for edit mode,
replaced with a single "Done" button (closing the sheet no longer needs
to distinguish "committing" from "closing" — every change already
applied) — `CteEditorPanel`'s existing "Save as new version"/"Reload
(discard edits)" toolbar buttons remain the real undo point for
everything since the last backend save.

**Why "create" mode had to stay explicit-Add-only, not live**:
`AddItemButton`'s selections use `appendByPath`, not `setByPath` — live-
firing on every keystroke while filling out a brand-new feature-item/CTA
would append a fresh array element on *every change* instead of
refining one draft, visibly spamming duplicate cards into the page as
you type. This is a real structural reason a single popover component
needs two different commit strategies depending on `mode`, not
inconsistency for its own sake.

**A subtle correctness detail, caught while designing this**: the live
effect fires once automatically on mount (React effects always do),
which would mark the page dirty the instant *any* editor is merely
opened, even with zero real changes. Fixed with a `skipFirstRun` ref
that swallows exactly that one initial firing, so dirty-tracking still
only reflects genuine edits.

**Overlay removed**: `SheetContent` (`components/ui/sheet.tsx`) gained
an opt-in `showOverlay?: boolean` prop (default `true`, so every other
Sheet use — e.g. `MobileNav` — is unaffected), and `CteEditorPopover`
passes `showOverlay={false}`: the dimming/backdrop-blur overlay actively
worked against a panel that's meant to stay open while you compare
several live values against the page behind it.

**Verified**: backend Pydantic models accept the three new button
fields on both `ThemeCta` and `ButtonBlock` (tested directly). Saved a
real page with a `rounded: "full"`/`size: "sm"`/`border_width: "thick"`
CTA button and a `rounded: "none"` `ButtonBlock` with the same border
treatment, and confirmed the exact expected classes (`rounded-full
border-2`, `rounded-none border-2`, correct `h-7` for the `sm` size) on
the correct elements in the rendered HTML. **Hit the deeper `.next`-
cache-corruption gotcha during this round of verification, not just the
lighter stale-bundle case** — a plain restart alone left the page
serving a *stale cached 200* momentarily and then flipped to an
outright 404 (matching this file's existing note that a restart can
sometimes make things worse, not better, when the corruption is the
deeper kind); `--renew-anon-volumes` was required to actually fix it.
Test page deleted after. **The live-update/no-overlay UX itself is
unverified in an actual browser** — this piece is fundamentally a
client-side interaction pattern (does the page visibly update as you
drag a color picker, does the panel actually stay open, does it feel
right) that curl/backend verification cannot exercise at all, unlike
the CSS-class-in-rendered-HTML checks above. This is the most important
open item to click through by hand before calling this done — more so
than prior CTE passes, since the entire point of this change is an
interaction quality that can only be judged by actually interacting
with it.

### CTE style editing, part 4 — real usage feedback, 2026-08-06

First real click-through of part 3's live-editing UI, same day. Four
findings, three fixed, one investigated at length without a definitive
answer:

1. **Reported bug**: color live-updated correctly, but font size/weight
   didn't. **Investigated extensively** — read every line of `EnumField`
   (used for size/weight) against `ColorField` (which worked) and the
   full `ui/select.tsx` primitive, and found no logical asymmetry: both
   go through the identical live-update effect, identical
   `resolveRichText`/`richTextClassName` render path, and the class-merge
   mechanism itself was already independently verified working (a direct
   API-saved page correctly showed `text-3xl`/`font-bold` overriding the
   defaults, part 2 above). Confidence this was actually the recurring
   Turbopack/`.next` staleness gotcha, not a real bug, went up
   significantly from an unrelated data point found *while verifying
   finding 2 below*: this session's own brand-new `BUTTON_SIZE_CLASS`
   override silently failed to appear after a plain `docker compose
   restart frontend` and only showed up after the full `--renew-anon-
   volumes` — i.e., a change made *in this same turn* hit the identical
   symptom (a correct code change producing zero visible effect) for a
   confirmed-innocent reason. Not proof the user's report was the same
   cause, but a strong enough analogue that the honest, evidence-based
   conclusion is "very likely the cache issue, ask them to retest" rather
   than continuing to guess at a code fix for a bug that couldn't be
   reproduced or located by inspection. Flagged directly to the user
   rather than claiming a fix that was never actually identified.
2. **Button size differentiation was too subtle to read as different
   sizes at a glance, and font size never changed with size at all.**
   Root cause: `Button`'s own `size` variants (`sm`/`default`/`lg`) only
   differ by 1px of height (`h-7`/`h-8`/`h-9`) and share one hardcoded
   `text-sm` in the shared base class regardless of size — reasonable for
   a dense admin UI, wrong for a marketing-page CTA. Fixed with a new
   `BUTTON_SIZE_CLASS` lookup in `theme-cta-style.ts` (`h-8/text-sm` →
   `h-10/text-base` → `h-12/text-lg`, with matching padding), appended
   after `Button`'s own classes via the same tailwind-merge override
   pattern as everything else — `themeButtonClassName()` now takes `size`
   too, not just `rounded`/`border_width`. **Verified**: saved a real
   page with `size: "sm"` and `size: "lg"` CTAs, confirmed `h-8 px-3
   text-sm` and `h-12 px-7 text-lg` respectively in the rendered HTML —
   also hit (and is the finding-1 analogue described above) the deeper
   `.next`-cache case needing `--renew-anon-volumes`, not just a restart.
3. **Sticky edit-mode toolbar.** `CteEditorPanel`'s Edit-mode/Save/Reload
   bar moved from sitting above the preview to being the sticky first
   child *inside* the preview container (`sticky top-14 z-30`, `top-14`
   matching `SiteHeader`'s own `h-14`/`z-40` so the two stack without
   overlapping) — no more scrolling back to the top of a long page just
   to toggle edit mode or hit Save. Background changed from translucent
   `bg-muted/30` to a near-opaque `bg-background/95` + backdrop-blur
   (matching `SiteHeader`'s own treatment) so scrolled-past section
   content doesn't show through a bar that's now meant to stay pinned
   over it.
4. **Section-level move/delete in the CTE preview**, matching
   `PageGeneratorPanel`'s preview per the user's explicit reference.
   Required a real prerequisite fix first: `SectionRenderer` gained an
   optional `startIndex` prop, because `CteEditorPanel` now renders each
   section individually (`sections={[section]}`) to wrap it in its own
   move/delete controls — without `startIndex`, every section's internal
   `Editable` paths would compute as if it were section 0, silently
   corrupting whichever section actually occupies that position (this is
   the one real risk PageGeneratorPanel's analogous per-section preview
   never had to deal with, since CTE isn't active there). `startIndex`
   defaults to 0, so the many other full-array `SectionRenderer` callers
   are unaffected. `handleMoveSection`/`handleDeleteSection` are plain
   index swap/filter — deliberately *not* the id-based/animated approach
   `PageGeneratorPanel` uses, since there's no regenerate-merge step here
   needing stable identity across a full array replacement; a plain index
   op on directly-user-driven reordering doesn't have that problem. Move/
   delete buttons sit top-left (not top-right, to avoid colliding with
   existing CTE pencil badges' `top-2 right-2`), visible only when edit
   mode is on. **Verified**: saved a real 3-section page, confirmed all
   three sections render with correct content via the public route
   (the actual move/delete *interaction* — like part 3's live editing —
   is client-side only and wasn't verifiable this session).

**Also answered, not built yet — a real design question, not a bug**:
the user asked whether `sections` state only reaches the backend via
"Save as new version" (confirmed: yes — every live edit, including all
of part 3's color/size adjustments, stays in local React state until
that explicit click) and proposed a local undo/redo log that snapshots
on *popover close*, not on every intermediate value change (e.g. not
every keystroke while typing a hex color). Recommended building it
exactly that way if/when the user wants it: snapshotting is effectively
free given `setByPath`/`appendByPath`/`removeByPath` (and the new
move/delete) are already fully immutable — every edit produces new
objects without mutating anything already referenced elsewhere, so an
undo stack only needs to hold onto old `sections` *array references*,
never deep-clone anything. Not implemented this session — explicitly
left as a follow-up pending confirmation, not assumed from "what do you
think?" phrasing.

### CTE style editing, part 5 — two real bugs from the user's actual retest, 2026-08-06

The user retested part 4 directly. Weight now worked (supporting part
4's "was probably just the cache" theory for that one), but **size still
didn't — and the toolbar wasn't actually sticky at all**. Both turned
out to be real, findable bugs once there was a specific, reproducible
symptom to chase rather than an unreproducible report.

**Size override bug, root cause found.** The user tested on `Home`'s
Hero headline specifically — and `HeroSection`'s headline classes are
`text-4xl font-semibold tracking-tight sm:text-5xl`, i.e. it has a
*responsive* size variant (`sm:text-5xl`) alongside the plain one, while
`font-semibold` has no such responsive variant. That difference exactly
predicts the difference in symptom: `richTextClassName`'s override
(`text-lg` or whatever) lives in a different tailwind-merge "slot" than
`sm:text-5xl` and can't beat it — at any viewport ≥640px (i.e. basically
any real desktop browser window), the responsive rule keeps winning
regardless of what plain-class override sits alongside it. Weight had no
competing responsive class to lose to, so it "just worked" by comparison
— this was the actual, previously-flagged "known limitation" from part 2
above, just discovered to bite on the very first, most obvious thing
anyone would test (a hero headline) rather than being a rare edge case.
**The user's own instinct was the fix**: they asked directly whether the
size should carry an actual value instead of a class — correct. Replaced
`richTextClassName` (Tailwind-class override) with a new
`richTextStyle()` (`rich-text.tsx`) that applies color **and** size
**and** weight as inline `style` (`fontSize` in rem matching Tailwind's
own default scale, `fontWeight` as a numeric value) instead of classes —
inline styles always win over any class regardless of media query, since
Tailwind's utilities never use `!important`, so this isn't merely a
patch for the Hero case, it structurally can't lose to a responsive
class ever again. All 5 fixed sections updated to the single
`style={richTextStyle(rt)}` call, replacing the old `cn(base,
richTextClassName(rt))` + separate manual color-style pairing.
**Verified**: saved a real Hero with a `size`+`weight` override and
confirmed `style="font-size:1.125rem;font-weight:500"` present on the
actual `<h1>` in the rendered HTML — a value, not a class, immune to the
responsive-breakpoint problem by construction.

**Sticky toolbar wasn't sticky at all — also a real, findable CSS bug.**
Root cause: the toolbar's parent (`overflow-hidden rounded-xl border`,
used purely to clip child content to the rounded corners) established
its *own* CSS scroll-containment context — per spec, any `overflow`
value other than `visible` does this, whether or not it actually
produces a user-visible scrollbar. Since that div has no bounded height,
it never itself scrolls, so `position: sticky` inside it had nothing to
track — the toolbar just scrolled away with the page instead of
sticking to it, exactly as the user described. Fixed by dropping
`overflow-hidden` from that wrapper (kept `rounded-xl border`; added
`rounded-t-xl` to the toolbar itself so the top corners still read as
rounded without the clipping) — the sticky toolbar's nearest scroll
container is now correctly the page/viewport itself. Traded off: a
section whose own content somehow extended past the box's rounded
corners would no longer get clipped, accepted since real section content
doesn't do that.

**Both were genuinely findable from the symptom, unlike part 4's
unreproduced report** — the difference this round: the user gave a
*specific, comparable* symptom (weight works, size doesn't, on the exact
same field) rather than "it doesn't update," which is what actually made
root-causing possible without a browser. Worth remembering as a pattern:
when CTE-adjacent reports don't resolve on the first pass, the most
useful next question is usually "what specifically differs between the
part that works and the part that doesn't," not another round of code
re-reading in isolation.

### CTE style editing, part 6 — retest confirmed the sticky fix, surfaced two more real issues, 2026-08-06

The user confirmed part 5's sticky-toolbar fix works. Two new reports
came back from the same retest, both real, both fixed:

**Size range too small — the enum itself was the wrong shape for this
field, not a bug in it.** Even `RichText.size`'s largest stop (`"3xl"` =
1.875rem/30px) came out *smaller* than Hero's own unstyled default
(`text-4xl`/`sm:text-5xl` = 36-48px) — the six-stop enum, copied from
`TextContentBlock.size` (a small atomic text-run field, where that range
makes sense), was never wide enough to cover an actual page headline,
which can legitimately need anywhere from small print to a large display
size depending on the source design. The user's own suggested fix
("是否应该把size的数值加上去" — should size take an actual numeric value)
was correct and is what shipped: `RichText.size` (`frontend/src/lib/
theme.ts`, `backend/apis/agent.py`) changed from the fixed enum to a
plain pixel `number`, bounded 12-96px (`Field(ge=12, le=96)` backend,
matching `RT_SIZE_MIN`/`RT_SIZE_MAX` frontend) — still controlled, single-
property, inline-style data, same principle as every other style field
here, just a *continuous* bounded range instead of six fixed stops.
`TextContentBlock.size` (the Block primitive) deliberately kept its
original enum unchanged — that field's own range was never the problem,
only `RichText`'s was. New `NumberField` (`cte-editor-popover.tsx`)
replaces `EnumField` for this one field only, with a "Reset to default"
link mirroring `EnumField`'s `allowUnset` semantics, and clamps an out-of-
range typed value on blur rather than silently accepting it.
`richTextStyle()` (`rich-text.tsx`) applies it directly as `${size}px`
now, dropping the old rem-lookup table entirely. **Verified**: saved a
real Hero headline with `size: 64`, confirmed `font-size:64px` present on
the rendered `<h1>` — well past the old enum's ceiling; backend rejects
an out-of-bounds value (tested `size: 200` → `ValidationError`) rather
than silently clamping server-side.

**Move/delete section buttons reportedly invisible — real z-index bug,
and a side effect of the part-5 sticky fix landing.** `CteEditorPanel`'s
per-section move-up/move-down/delete badges (`top-2 left-2 z-20`,
requested back in part 4) were implemented correctly and gated on the
same `editModeOn` the pencil badges use — but while the toolbar's sticky
positioning was *broken* (part 5), it could never visually overlap
anything, since a non-sticky element just scrolls normally with the
page. The moment sticky started genuinely working, the toolbar (`z-30`)
began actually sitting on top of whatever content scrolls underneath it
— and a section's own top-2 badge, whenever that section's top edge
scrolls to the same screen position the stuck toolbar occupies (most
obviously the very first section, right below the toolbar — exactly what
the user was looking at, Home's Hero), was being painted *underneath*
it: invisible, not missing. Fixed by bumping the badge container's
z-index from `z-20` to `z-40`, safely above the toolbar's `z-30`, so it
always paints on top regardless of scroll position. Not independently
verified in a live browser (still no working Chrome extension connection
this session — confirmed again, `tabs_context_mcp` still reports the
extension not connected) — this is a z-index/paint-order fix reasoned
from the CSS stacking rules and the toolbar's own z-30/badge's z-20
values, not confirmed via a screenshot; flag to the user to double-check
on the next retest same as everything else in this file that couldn't be
browser-verified.

**Both fixes verified**: `tsc --noEmit` and `npm run lint` clean; backend
`RichText` Pydantic model exercised directly (`docker compose exec
backend python3 -c "..."`) for both the valid and out-of-range cases; a
real page saved and read back via `curl` confirmed the numeric size
renders correctly end-to-end; test page deleted after via the existing
delete-page endpoint.

### CTE, part 7 — computed "current value" for rich-text fields, and Task 1 of a bigger structural-editing rework, 2026-08-06

Two separate follow-ups from the same conversation. The first closes a
gap from part 6; the second is the start of a much bigger, explicitly
staged feature the user asked for after clarifying that "part 6's
move/delete buttons" had been misread.

**"CTE 里应该有一个当前值，而不是 default 或者 unset."** Every
`RichText` style control (`NumberField`/size, `EnumField`/weight,
`ColorField`/color) showed a blank "Default" placeholder for a field
that had no explicit CTE override yet — even though that field is
visibly rendering at *some* real size/weight/color already. Unlike most
other style fields in this schema, `RichText` has no *one* universal
default to hardcode into the popover (`ContainerBlock.layout` always
defaults to `"row"` regardless of context; a Hero headline and a
badge-list heading render at completely different hardcoded sizes of
their own) — so the only way to show "what this actually looks like
right now" is to read it straight off the live DOM. Implemented via
`Editable` (`components/theme/cte/editable.tsx`): a ref on the wrapped
element plus a new `readComputedRichTextDefaults()` that calls
`window.getComputedStyle()` at click time (`fontSize` → px number,
`fontWeight` → nearest named `TextWeight` via a numeric-threshold
mapping, `color`'s `rgb(...)` → hex via a small regex converter) and
passes the result through `cte.select()` as a new
`CteSelection.computedDefaults` field (`lib/cte.ts`). `CteEditorPopover`
seeds `rtSize`/`rtWeight`/`rtColor`'s initial state with
`richTextValue?.xxx ?? computedDefaults?.xxx` instead of leaving them
`undefined` when unset. Accepted trade-off: since the field is now
pre-filled, saving without touching it "pins" that value into the
`RichText` object instead of staying a plain string — harmless (it's
exactly what's already rendering) but means a page saved this way no
longer inherits a *future* change to that section's own hardcoded
default class; the "Reset to default" control still clears back to a
real `undefined` for anyone who wants the old inherit-forever behavior.
Not verifiable via curl (a live `getComputedStyle()` read only exists in
an actual browser DOM) — `tsc --noEmit`/`npm run lint` clean, unverified
in a real browser this session, same recurring gap as everything else
CTE-interaction-shaped.

**Structural editing, reframed as one general concept.** The user
clarified that "move/delete buttons next to every pencil badge" wasn't
about the section-level toolbar already built — it meant treating
*every* array-of-reusable-components in the schema the same way: page
`sections`, a feature-grid's `items`, a CTA array, and (eventually) a
`ContainerBlock`'s `children` should all support move/delete/insert
through one consistent mechanism, not bespoke handling per array. This
directly reopens a call made explicitly the other way back in Phase 4
("agreed no [to whole-section add/remove] — a WordPress-style 'only the
reusable blocks we ship' ceiling on purpose") — confirmed with the user
this reversal is intentional, not a drift. Agreed scope, staged into
small tasks rather than one big pass:
- **Task 1 (this entry)**: insert-only, at the `sections` (page) level —
  move/delete already existed there since part 6.
- **Task 2 (not started)**: extend the same insert mechanism to
  feature-item/cta arrays, which currently have *insert-at-end*
  (`AddItemButton`) and delete (the popover's footer button) but no
  move and no insert-at-an-arbitrary-position.
- **Task 3 (not started)**: `ContainerBlock.children` — currently has
  *none* of insert/delete/move; the largest remaining piece, since it
  needs its own add/delete infrastructure built from scratch (previously
  flagged and deliberately deferred when the Block schema first shipped).

**Task 1, what shipped**: the user's own suggestion for how the "+"
picker should decide its option list — a declarative `insertable` flag
per component type, rather than a hardcoded list baked into the picker
component, "so we can directly filter which components can go in the
list and which can't." New `frontend/src/lib/section-registry.ts`:
`SECTION_REGISTRY`, one entry per `PageSection` type (`type`, `label`,
`description`, `insertable`, `createDefault()`) — `INSERTABLE_SECTION_
TYPES` is just the registry filtered on that flag. All 6 real section
types are `insertable: true`; `carousel` is deliberately `false` (the
type exists in the schema/renderer but has no CTE editing support for
its `slides` yet, see Phase 4/5's scope-cut notes — inserting one would
be a dead end with no way to fill it in) — the registry is the single
place that decision lives, so a future section type doesn't also require
remembering to touch the picker UI.

New `SectionInsertMenu` (`components/theme/cte/`) — same `Sheet`
component and visual language as `CteEditorPopover` (the user's explicit
ask: "+" should feel like the same interaction as the pencil editor,
just showing a type list instead of a value form), a flat list of
`INSERTABLE_SECTION_TYPES` for now (not tabs — only 6 entries; revisit
once Task 3's container-children picker exists alongside this one and
the combined option count actually gets unwieldy). Picking a type
inserts `def.createDefault()` at the clicked gap's position via a new
`handleInsertSection` in `CteEditorPanel` (a plain immutable
`splice`-insert, same reasoning as `handleMoveSection`/
`handleDeleteSection` staying plain array ops — no regenerate-merge step
in this preview that needs stable identity preserved). New `InsertGap`
component renders a thin, **always-visible** (not hover-revealed) "+"
divider before the first section, between every pair, and after the
last (N sections → N+1 gaps) — deliberately not hover-gated, since this
session already hit one real "I can't see the button" report from a
different cause (part 6's z-index bug); an always-visible `bg-primary`
badge (same high-contrast style as `Editable`'s pencil badge, already
confirmed visible/usable by the user) avoids reopening that ambiguity
for a brand-new control.

**Container's default, per the user's explicit call**: picking
"Container" from the picker inserts a ready-to-use 2-column row
directly (`layout: "row"`, two `TextContentBlock` children) rather than
a second nested "row vs column vs grid, how many columns" picker step —
simpler, and the pencil editor already fully covers layout/justify/
align/gap fine-tuning afterward, so a two-step picker would just be
redundant with an editing surface that already exists.

**Verified**: `tsc --noEmit`/`npm run lint` clean. Every
`SECTION_REGISTRY.createDefault()` output (all 6 insertable types)
POSTed directly to the real backend as one page's `sections` array and
confirmed it passes Pydantic validation and renders (`200` on the public
route) — i.e. every default this picker can produce is guaranteed
save-able, not just plausible-looking TypeScript. Test page deleted
after. **The actual "+" click → Sheet → pick → insert interaction is
unverified in a live browser** — no working Chrome extension connection
this session (confirmed again via `tabs_context_mcp`), consistent with
every other CTE interaction this whole thread.

### CTE, part 8 — real browser screenshots confirm Task 1 works; Tasks 2+3 built the same round, 2026-08-06

The user tested Task 1 for real and sent actual screenshots (not through
this session's own Chrome tool — that's still reporting disconnected —
but from their own browser) — the first hard confirmation this session
that the sticky toolbar, section move/delete, insert gaps, and pencil
badges genuinely work end-to-end for a real user, not just at the API/
render level. Four concrete findings from those screenshots, all
addressed the same round:

1. **Row insert only ever offered 2 columns.** Rather than add a
   column-count picker (a second UI step this project's earlier "just
   insert a 2-column default, fine-tune afterward" call had specifically
   tried to avoid), resolved by pairing with finding 3 below: a Row now
   starts genuinely empty and gains columns one at a time through the
   same "+" mechanism being built for Task 3 anyway — asking for a 5th
   column is just clicking "+" a 5th time, not a separate N-picker.
   `section-registry.ts`'s "container" default changed from two
   pre-filled `TextContentBlock`s to `children: []`.
2. **`ContainerBlock`'s own edit badge (top-right, whole-block) was
   visually indistinguishable from its children's own badges** — both
   used the same `bg-primary` color, so a corner badge next to the last
   child read as "edit that child," not "edit the whole row." Fixed in
   `Editable`: `fieldType === "block-container"` now renders its badge
   `bg-blue-600 text-white` instead of the default primary color — every
   other fieldType unchanged.
3. **Empty Row columns should show "+", not placeholder text** — see
   finding 1; this is Task 3 (below), pulled forward into this same round
   since an empty row with no insert mechanism would otherwise be a dead
   end.
4. **Every reusable-component array item needs move/delete, not just
   page sections** — feature-grid items, CTA buttons, and (once it
   exists) `ContainerBlock.children`, with a deleted/empty slot showing
   "+" to re-populate it. Scoped with the user before building (asked via
   AskUserQuestion): **array-based content only this round** — a fixed
   section's own single optional field (Hero's `image`/`eyebrow`/
   `subheadline`) staying a plain delete-with-no-reinsert is explicitly
   out of scope, since turning a single named field into a "slot" is a
   structurally different mechanism than array insert/move/delete and
   wasn't asked for.

**Tasks 2 (feature-item/cta move) and 3 (`ContainerBlock.children`
insert/move/delete) built together**, since both need the same new
primitives:
- `lib/cte.ts` gained `insertByPath(sections, arrayPath, index, value)`
  (insert at any position, not just append — `appendByPath` stays for
  `AddItemButton`'s original always-at-the-end case) and
  `moveByPath(sections, itemPath, direction)` (generalizes
  `CteEditorPanel`'s original section-only swap logic to work at any
  path depth). Unit-tested directly (insert into empty/insert-at-
  position/move/boundary-no-op, immutability of the original reference
  at every step) via a standalone Node script mirroring the TS logic.
- `CteContext`/`CteProvider` (`cte-context.tsx`) gained `move`/`remove`/
  `insertAt` methods alongside the existing `active`/`select` — so a
  deeply-nested renderer (a `BlockRenderer` several containers deep) can
  trigger a top-level `sections` mutation without threading callbacks
  down as props through every intermediate component, the same reasoning
  `select` was already built on. `CteEditorPanel` supplies real
  implementations (`handleMoveItem`/`handleRemoveItem`/`handleInsertAt`,
  thin wrappers around the three `lib/cte.ts` functions); every other
  provider usage defaults to no-ops via a shared `noop`.
- New shared `ArrayItemToolbar` (`components/theme/cte/`) — move-
  earlier/move-later/delete, `position: absolute; top-2 left-2` (the
  *left* corner specifically, so it never collides with a fieldType's own
  pencil badge, which claims either the inline position or `top-2
  right-2` — same left/right split `CteEditorPanel`'s section-level
  toolbar already established). "Earlier/later," not up/down/left/right
  icons — these arrays render in different physical directions (a row's
  children left-to-right, a stacked list top-to-bottom) and one icon pair
  can't be visually correct for both. Wired into `HeroSection`/
  `CtaBannerSection`'s CTA arrays and `FeatureGridSection`'s
  `EditableFeatureCard` (shared by all 3 item-style branches — list/
  split/stacked — so one change covered all of them).
- New `lib/block-registry.ts` (`BLOCK_REGISTRY`/`INSERTABLE_BLOCK_TYPES`,
  same `insertable`-flag pattern as `section-registry.ts`) and
  `BlockInsertMenu` (the `Block`-type analogue of `SectionInsertMenu`) —
  kept as a separate component/registry rather than generalizing the
  section ones, since the two pick from genuinely different type unions
  with no shared shape worth abstracting over for just two call sites.
- `BlockRenderer` (`components/theme/blocks/`) is now the real structural
  editor for `ContainerBlock.children`: gained local `insertAt` state,
  renders an `InsertGap` (pulled out of `CteEditorPanel` into its own
  `components/theme/cte/insert-gap.tsx` so both can share it) before/
  between/after every child — for an empty array this means exactly one
  gap, which is what makes a freshly-inserted empty Row show a "+"
  instead of collapsing to nothing — and wraps each child in
  `ArrayItemToolbar` when `useCte().active`. Outside edit mode it renders
  byte-for-byte what it always did (no extra wrapper divs) — verified by
  keeping the inactive branch's original conditional-wrapper logic
  unchanged, just reached through a new `if (!cte.active)` early return
  rather than being the component's only path.

**Real bug hit and fixed mid-build**: making `BlockRenderer` a Client
Component (needed for `useState`/`useCte()`) broke `ContainerBlock`
(still, deliberately, a Server Component) with `Error: Functions cannot
be passed directly to Client Components` — `ContainerBlock` was passing
`itemClassName={rowItemClassName}`, a function, across the server→client
boundary, exactly the component/function-prop RSC gotcha this file
already documents elsewhere (icons/render props). Fixed by moving the
`WIDTH_CLASS` lookup and the row-sizing logic *into* `BlockRenderer`
itself and replacing the function prop with a plain serializable boolean
(`sizeForRow={layout === "row"}`) — `ContainerBlock` no longer needs to
compute or pass a function at all. A good concrete instance of this
file's general rule: converting an existing component to a Client
Component isn't just a local change, it can break any Server Component
parent that was passing it a non-serializable prop.

**Verified**: `tsc --noEmit`/`npm run lint` clean throughout (hit the
recurring stale `.next`-artifact gotcha once mid-session — a restart
fixed it, as usual). Backend accepts and renders (`200`) a real page
mixing an empty top-level container, a container with all 4 block types
as direct children, and a 2-level-nested container (a row inside a row)
— confirms `insertByPath`'s target shapes all validate and render, not
just the registry's own defaults. Test page deleted after.
**Everything client-interaction-shaped (the actual "+"/move/delete
clicks, the badge color distinction, the empty-row "+" prompt) is still
unverified by this session's own tools** — `tabs_context_mcp` still
reports the extension disconnected on this side — but the user's own
real screenshots from Task 1 are the strongest signal yet that the
underlying mechanism (Sheet-based pickers, always-visible high-contrast
badges) genuinely works in practice, not just in theory.

### CTE, part 9 — real screenshot from Task 3, three UI fixes, 2026-08-06

The user tested Task 3 (nested container children) for real and sent a
screenshot of a row with several narrow nested columns: every "+" gap,
move/delete arrow, and pencil badge crammed into one visually noisy
strip, hard to tell apart or click precisely. Three concrete, related
causes, all fixed:

1. **`InsertGap` stretched to its row's full cross-axis height.** It was
   built for `CteEditorPanel`'s vertical section list (a fixed `h-4` +
   a full-width absolute divider line) and never adjusted for
   `BlockRenderer` reusing it inside a `layout: "row"` container — as a
   plain flex item there, `align-items: stretch` (the row's own default)
   stretched both the gap and its divider line to match tall siblings,
   producing crossed lines instead of a small floating "+". Fixed by
   dropping the divider line entirely (cosmetic, not load-bearing) and
   adding `self-center shrink-0` plus real `px-3 py-3` padding — the "+"
   now stays a small, centered, consistently-spaced circle regardless of
   the parent's flex direction or alignment.
2. **Near-empty children collapsed too short for their own toolbars to
   fit without overlapping.** A freshly-inserted empty row's children (or
   any lightly-filled block) had no minimum footprint, so the badges
   absolutely-positioned inside them had nowhere to spread out. Fixed
   with `min-h-16` on each child's wrapper `div` in `BlockRenderer`,
   edit-mode only — outside edit mode this wrapper doesn't gain the
   class, so nothing about the live site's layout changes.
3. **A container's own "edit the whole thing" pencil and its move/delete
   toolbar lived in two separate corners**, which read as visual clutter
   once several narrow nested columns pushed them close together — the
   user's own suggestion: fold them into one group. `ArrayItemToolbar`
   gained an optional `onEdit` button (same `bg-blue-600` as the
   container badge it replaces, for visual continuity); `Editable`
   gained a `hideBadge` prop so `ContainerBlock` can suppress its own
   corner badge when an external toolbar is already offering the same
   action. `BlockRenderer` wires the two together only for `container`-
   type children (`onEdit` calls `cte.select(...)` directly with that
   block's own path/value, and `hideOwnBadge` is passed to that one
   `ContainerBlock` instance) — every other block type (image/text/
   button) is unaffected, still just gets move/delete. **Deliberately
   scoped to nested children only, not top-level container *sections***
   — the reported crowding was specifically the nested case; merging the
   equivalent badges for a top-level container section would need
   threading a suppress-flag through the public-facing `SectionRenderer`
   for a case nobody's flagged as a problem, not a proportionate change
   right now.

**Verified**: `tsc --noEmit`/`npm run lint` clean. A page with a nested
container (row → column → text, alongside a plain text sibling) saved
and rendered (`200`) without error, confirming `hideOwnBadge`/`onEdit`
threading doesn't break the render path structurally. Test page deleted
after. **The actual visual outcome — does the padding look right, does
the merged toolbar read as one group, is the "+" properly centered — is
unverified**, same as every other CTE interaction this session; this is
a pure CSS/layout fix reasoned from the screenshot and the flex-stretch
mechanism, not confirmed by re-rendering it in a browser.

### CTE, part 10 — extended the badge merge to top-level container sections, 2026-08-06

The user re-sent the same screenshot from part 9 with a hand-drawn
annotation clarifying scope: they wanted the edit-pencil/move/delete
merge (part 9) applied to a top-level **container section**, not only a
nested container child — a case part 9 deliberately skipped ("nobody's
flagged it as a problem"). Now flagged directly, so extended the same
day. Also confirmed in the same message: the earlier recommendation
against unifying Hero/FeatureGrid/etc. into one generic layout-JSON
system — accepted, not pursued.

`SectionRenderer` gained `mergeContainerBadge?: boolean` (default
unset/false — every existing caller, including every public route and
`PageGeneratorPanel`'s preview, renders exactly as before): when true,
a top-level `container` section's `ContainerBlock` gets
`hideOwnBadge={true}`, same mechanism part 9 built for nested children.
`CteEditorPanel` passes `mergeContainerBadge` on its own
`SectionRenderer` call and — only when `section.type === "container"` —
adds a 4th button (an edit pencil, same `bg-blue-600` as everywhere else
this merge appears) to its existing per-section move/delete toolbar,
calling `setSelection({ path: String(index), fieldType: "block-container",
value: section })` directly. Every other section type's toolbar is
unaffected (still just move/delete, no pencil — those section types have
no single "edit the whole section" action, only per-field edits).

**Verified**: `tsc --noEmit`/`npm run lint` clean. A page whose only
section is a top-level container (row of two text children) saved and
rendered (`200`) without error. Proactively restarted the frontend
container before handing this back for retest, given how often a plain
code change has needed that this session even without a compile error —
better to rule out staleness before the user's next screenshot. Test
page deleted after. **Visual outcome still unverified in an actual
browser**, same gap as parts 7-9.

### CTE, part 11 — nested container's own toolbar overlapped its own empty-state "+", 2026-08-06

Confirmed via a real screenshot: part 10's positioning was correct
(merged pencil/move/delete now consistently top-left at every level), but
a nested, empty `ContainerBlock` child showed its own `ArrayItemToolbar`
(from the *parent* `BlockRenderer`, floating at that child's `top-2
left-2`) visually overlapping the child's *own* leading `InsertGap` (the
one `BlockRenderer` renders internally for that child's own, currently
empty, `children` array) — both landed in the same small area since an
empty nested row has nothing to push its own content down.

Root cause distinct from part 9's row-stretch bug and part 10's missing
merge — this is two *different* pieces of CTE UI (an ancestor's edit
toolbar vs. a descendant's own insert affordance) coincidentally
occupying the same screen position, not a single component's own layout
bug. Fixed with `pt-10` on `BlockRenderer`'s per-child wrapper, but only
when that child is itself a `container` — reserves vertical clearance
for exactly the case that can have its own top-edge content (a nested
container's first `InsertGap` or real children); leaf blocks (image/
text/button) have nothing internal competing with their own toolbar, so
they're untouched. Unconditional on whether the nested container is
actually empty (detecting that precisely wasn't worth the complexity —
a little extra top padding on a populated nested container while
editing is a minor, acceptable cost, not a regression).

**Verified**: `tsc --noEmit`/`npm run lint` clean; a page with a
container nested inside another container, the inner one empty,
saved and rendered (`200`) without error. Restarted the frontend
proactively again before handing back for retest. Test page deleted
after. **Still unverified visually in a live browser** — same
recurring gap; flagged to the user to check padding/no-overlap
specifically on the next retest.

### CTE, part 12 — insert/move/delete controls switched to hover-reveal, 2026-08-06

Another real screenshot, this time of a row with 3 nested empty
containers: even with part 11's padding fix (no more overlap), the sheer
*count* of always-visible controls — 4 insert gaps, 3 per-child move/
delete/edit toolbars, all visible at once around 3 small empty boxes —
was itself the problem. The user's own framing: hover-reveal in edit
mode, either just for insert gaps between components, or for every "+"
across the board.

**Went further than asked, deliberately**: extended the same hover
treatment to the move/delete/edit toolbars too (`ArrayItemToolbar`,
`CteEditorPanel`'s section-level toolbar), not just `InsertGap`, since
the screenshot's clutter came from both and this codebase already has
working precedent for exactly this pattern in an admin-only, desktop-
oriented editing surface — `page-generator-panel.tsx`'s
`LockableSectionPreview` has hover-revealed its own move/lock/delete
toolbar since 2026-08-05, with no reported discoverability complaints.

**This is a real reversal of an earlier decision, not an oversight —
worth being explicit about why it doesn't undermine that decision.**
`Editable`'s own doc comment documents a 2026-08-04 redesign that
*rejected* hover specifically because "hover doesn't exist on touch
devices, so mobile had no way to discover what was editable" — and nine
different points in this file's CTE parts 6-11 chose always-visible
controls for the same reason, most recently InsertGap's own doc comment
(now rewritten). The distinction that makes hover correct *here*: that
2026-08-04 call was about the **pencil edit badges** — the primary "what
can I edit" discovery mechanism, which stays untouched and
always-visible. Insert/move/delete are **secondary, structural**
actions, and `/editor` itself is an admin-only surface realistically
only ever used from a desktop browser, unlike the touch-first public
site the original concern was actually about. Hover-reveal trading away
zero-click discoverability for a *structural* action, on a *desktop*
admin tool, isn't the same trade the 2026-08-04 call made.

**Mechanism**: `opacity-0 group-hover:opacity-100 group-focus-within:
opacity-100` on `InsertGap`'s button and `ArrayItemToolbar`'s wrapper —
`group-focus-within` (not just `group-hover`) so tabbing to a button by
keyboard still reveals it, not just mouse hover. Every caller that
already had a `relative` wrapper (hero/cta-banner's CTA arrays,
`feature-grid-section.tsx`'s `EditableFeatureCard`, `BlockRenderer`'s
per-child wrapper) just gained `group` alongside it — one word each, no
structural change. `CteEditorPanel`'s section-level wrapper already had
`group`, so only its toolbar div's className changed.

**Verified**: `tsc --noEmit`/`npm run lint` clean; `/` and `/editor`
both still return 200 after a restart. Hover-based visibility is
fundamentally a live-interaction property (does it actually fade in on
mouse-over, does keyboard tab-focus reveal it) that can't be verified
via curl/backend checks at all — this is the least backend-verifiable
change of the whole CTE-part-6-through-12 run, more so than the CSS
layout fixes, which at least had rendered-HTML class presence to check.
Needs a real browser click-through before considering this settled.

### CTE, part 13 — dropped the merged toolbar's blue pencil background, 2026-08-06

Small follow-up, the user's own suggestion: once the "edit this
container" pencil (parts 9/10) sits *inside* the same grouped toolbar as
move/delete, its solid `bg-blue-600` reads as visually inconsistent with
its neutral `bg-background/90` neighbors — the color made sense back
when it was a lone floating badge that needed to be told apart from an
unrelated adjacent badge (the original part-8 problem this color was
built to solve), not once it's already grouped with icons that make its
purpose obvious on their own. Changed both places this button exists —
`ArrayItemToolbar`'s `onEdit` button and `CteEditorPanel`'s matching
inline section-level one — to the same `bg-background/90 text-
muted-foreground` style as move/delete. **Deliberately left unchanged**:
`Editable`'s own *standalone* `block-container` badge (only ever visible
when nothing merges it, e.g. `PageGeneratorPanel`'s preview) — that
context still has the original problem (an unrelated adjacent badge to
be told apart from), so it still needs the color.

**Verified**: `tsc --noEmit`/`npm run lint` clean (hit the recurring
stale `.next`-artifact gotcha once more mid-check — a restart cleared
it, as usual); `/editor` still returns 200 after the restart. Purely a
color/class change with no logic behind it — nothing else to verify at
the API/render level.

### CRM entry capture + report generation, made real, 2026-08-06

The last two `apis/agent.py` stubs — after this, every "agent console"
capability is real, not a placeholder. Picked up right after the user
paused the CTE structural-editing work (parts 1-13 above) with "MVP应该
够用够展示了" (the MVP should be good enough to demo) — a deliberate
scope shift back toward finishing out the plan's originally-reserved
routes rather than continuing to deepen CTE.

**CRM — real internal record store, not a third-party push.** Confirmed
with the user before building: no HubSpot/Salesforce/etc. account or API
key exists for this project, and unlike the AI providers (a handful of
well-known, roughly standardized chat/embedding APIs worth coding a
generic client against, even unconfigured) there's no single "the" CRM
API worth picking without a real vendor account to test against. Rather
than fake a vendor integration or leave it a 501 forever, `create_crm_
entry` now genuinely stores the lead in this project's own Postgres —
new `CrmEntry` model (`backend/models.py`, migration `43fe48dd8bda`:
`contact_email`, `summary`, `tags` as JSONB, `created_at`), a real
`INSERT` + commit, `crm_id` in the response is just that row's own id
stringified (no external system assigns a different one). Added
`GET /agent/crm/entries` (most-recent-first) alongside the existing
`POST`, matching every other real capability's "not just a black-box
POST" bar (DocumentManager, PageManager, ...). Swapping this for a real
third-party push later means adding that API call *alongside* this
insert, not a schema change — same "swappable, not hardcoded" principle
already applied to AI providers and the image-gen backend.

Frontend: new `CrmPanel` (`components/modules/`, on `/dashboard`) — a
capture form (email/summary/comma-separated tags, matching badge-list's
existing tag-input convention) plus a list of what's been captured so
far, `lib/crm.ts`'s `pushCrmEntry`/`listCrmEntries`. Deliberately not an
attempt to simulate a real chat-driven intake flow (that would need real
intent recognition, Phase 3's still-unstarted item) — just proves the
capture pipeline end-to-end from a manual admin form, the same scope
`generate_poster`'s first cut had before its own frontend panel existed.

**Report — structured data + a real chart, not a `report_url`.**
Confirmed with the user before building: this project has no static-
report-file generation infrastructure, so the original stub contract's
`report_url: str` had nothing real to point at. Redesigned
`ReportResponse` to return per-day structured data instead
(`ReportDayPoint{date, session_count, message_count}`) computed directly
from `ChatSession`/`ChatMessage` (the visitor-conversation log already
being persisted, see "Visitor conversation persistence" above) —
`func.date(...)` grouped counts for both tables across the requested
`[start_date, end_date]`, zero-filled for any day with no activity so
the frontend always gets one point per calendar day, not a sparse list.
`report_type` narrowed from a bare `str` to `Literal["chat-volume"]` —
only one report exists, and a bad value now 422s immediately instead of
silently returning an empty report. **Deliberately scoped to chat volume
only** — the original stub docstring also mentioned "RAG query trends,"
but whether a given `/api/chat` turn actually used retrieved context was
never persisted (`ChatMessage` stores the reply text, not `sources`), so
that series genuinely isn't computable from data this project has today;
extending it later means adding that column first, not just adding a
case here.

Frontend: new `ReportPanel` (`components/modules/`) — a start/end date
picker (defaults to the last 7 days) and a real line chart (sessions +
messages per day) via **recharts**, newly added as a dependency
(`docker compose up -d --build --renew-anon-volumes frontend` — both
flags together, per this file's own documented lesson: a live-only
`npm install` needs `--build` before `--renew-anon-volumes` will pick it
up, not just the volume renewal alone). No shadcn chart wrapper existed
in this codebase yet; built directly on recharts' own primitives
(`LineChart`/`XAxis`/`YAxis`/`Tooltip`/`Legend`) rather than adding one
for a single chart.

**Stub-card grid retired.** `AgentConsoleSection`'s generic
`AGENT_CAPABILITIES` grid (sample-payload "Try it" cards exercising the
RBAC gate against a still-501 endpoint) had exactly two occupants — CRM
and report — and both are real now, so the whole grid/`AgentCapability
Card` apparatus was removed rather than left rendering empty, the same
"pull it out once it's real" treatment `generate_landing_page`/
`generate_poster`/`generate_geo_page` already got.

**Verified**: `docker compose exec backend python3 -c "import apis.agent"`
clean; `POST`/`GET /agent/crm/entries` round-tripped a real entry via
curl (403 with no token, 200 with an admin token, entry correctly listed
back). Report aggregation verified against real data, not just an empty
DB: inserted a synthetic `ChatSession`+2 `ChatMessage`s directly, called
the endpoint, confirmed `session_count: 1, message_count: 2` on the
correct day, then deleted the synthetic rows (and the CRM test entry)
afterward. `tsc --noEmit`/`npm run lint` clean both before and after the
image rebuild; `/dashboard`, `/docs`, and `/agent/crm/entries` all
confirmed reachable post-rebuild. **The actual admin UI (the form, the
chart rendering, date-picker interaction) is unverified in a live
browser** — same recurring gap as the whole CTE run above; this is
purely `tsc`/curl/backend-level verification.

**Phase 5 — Visual polish (post-core)**
- [x] Landing-page architecture decided and scaffolded 2026-08-03: vision LLM output is a **page-section schema** (`frontend/src/lib/theme.ts`'s `PageSection` union — hero/feature-grid/carousel/text-block/cta-banner/badge-list, plus the generic Container/Image/Text/Button block primitives added 2026-08-05, see above), not raw HTML/CSS. Rendering maps each section to a real reusable component (`frontend/src/components/theme/`, via `SectionRenderer`) — safe to render, stays on-brand, never needs pixel-perfect fidelity. Home page (`/`) renders through this from a hand-authored "default template" (`frontend/src/config/default-theme.ts`).
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
- [x] **Section locking on regenerate, 2026-08-05**: user's own idea, after enough rounds of "regenerate the whole page to fix one bad section, lose a section I liked" — `PageGeneratorPanel` (`frontend/src/components/modules/page-generator-panel.tsx`) now renders each preview section individually (`LockableSectionPreview`, one `<SectionRenderer sections={[section]} accentColor={...} />` call per section instead of one call for the whole array) with a hover-revealed Lock/Unlock toggle badge. `handleGenerate` runs `mergeLockedSections(oldSections, newSections, lockedIndices)` before calling `setResult` whenever a previous result exists and at least one section is locked. **Purely client-side, index-based, no backend/prompt change** — deliberately, consistent with this file's repeated finding that asking the vision LLM to do something structurally unreliable (here, "regenerate only part of the image's content, echo the rest back verbatim") isn't trustworthy; the model still re-analyzes the whole image every regenerate, so this doesn't save any generation time, it only guarantees a bad regenerate can never silently overwrite a section the admin already locked in. Merge behavior: locked indices are read from the *old* result and written into the *same* index of the *new* result; if a new generation comes back with fewer sections than a locked index, that locked section is appended at the end rather than dropped, so a locked section can never be silently lost even if the model's section count shifts. Locks reset whenever a genuinely new file is chosen (`handleFileChange` clears both `result` and `lockedIndices` together — a new source image makes the old lock indices meaningless). Verified two ways: `mergeLockedSections` in isolation via a standalone Node script (single lock preserved + rest replaced; a locked index beyond the new array's length correctly appended, not dropped; zero locks passes the new array through unchanged; multiple simultaneous locks), and `tsc --noEmit` + `npm run lint` both clean against the actual component.
- [x] **Manual reorder/delete in the preview, same day**: same user report — index-based locking can still land "乱" (jumbled) if a regenerate reorders or adds/removes sections, since `mergeLockedSections` above trusts the *position* of a locked index, not its content, to still mean the same thing next generation. Rather than build automatic content-aware matching — considered and explicitly deferred, see below — added two manual tools to the same per-section toolbar as the lock badge: Move up/down and Delete, both in `page-generator-panel.tsx`. Delete is gated behind a plain `window.confirm()` (matches `PageManager`'s precedent) even though it's non-destructive against anything actually saved — it only edits the unsaved preview — purely to guard against an accidental click losing preview work with no undo. **Automatic content-aware section matching (e.g. matching old/new sections by `type` instead of raw index) was raised and deliberately not built**: the schema has no stable per-section ID, and matching by `type` alone is ambiguous the moment a page has two sections of the same type — exactly the kind of heuristic this file has repeatedly found unreliable for anything beyond simple index/threshold rules (see the RAG citation-score and vision-LLM-layout-heuristic sections above). User explicitly accepted this is best-effort, not a full fix: repeated regenerate-and-lock cycles can still accumulate near-duplicate sections that then need manual deletion. Recommended: use move/delete to fix ordering after a regenerate; revisit smarter matching only if that's still too tedious in practice.
- [x] **Stable per-section ids + move/delete animation, same day**: user reported the plain swap/removal above was disorienting on its own — a moved section just silently changed content at its old screen position with no visual sense of "where did it go," and delete had no transition at all. Root cause of *why* an animation wasn't trivial to bolt on: the preview list was keyed by array index (`key={index}`), so React reused the same DOM node across a swap and just patched its props in place — nothing to animate, since as far as React's reconciler was concerned nothing was added, removed, or reordered. Fixed by introducing `PreviewItem = { id: string; section: PageSection }` (`page-generator-panel.tsx`) — a client-only id via `crypto.randomUUID()`, generated once per section and carried through moves/deletes/regenerate-merges — used as the real `key`, so React (and framer-motion, newly added as a dependency: `docker compose exec frontend npm install framer-motion`, `^13`) can actually track identity across a reorder. Each preview item is now a `motion.div` with `layout` (animates into its new position on move) plus `initial`/`exit` height+opacity (animates out on delete, via the list's `AnimatePresence mode="popLayout"` so remaining items reflow immediately rather than waiting for the exit to finish). **Locking moved from index-based (`Set<number>`) to id-based (`Set<string>`) as part of this same refactor** — a nice side effect of having stable ids at all: a locked item's lock now trivially follows it through a move or a regenerate-merge with no separate remapping logic needed (the old `moveSection`/`deleteSection` had to manually shift `lockedIndices`; the new `moveItem`/`deleteItem` don't touch locks at all, since the lock is keyed by the content's own id, not its position). `mergeLockedSections` still places a locked item at the *position* it occupied in the old array (see the entry above — this part is unchanged and still positional/best-effort), it just no longer needs to reindex anything since ids never shift. Verified: `mergeLockedSections`/`moveItem`/`deleteItem` unit-tested via a standalone Node script (locked item keeps its own id and content across a merge; overflow-append still works; a lock tracked by id is provably unaffected by a swap; edge no-ops at both ends of the array), `tsc --noEmit` + `npm run lint` clean against the actual component. **Not yet verified in an actual browser** — no working Chrome extension connection this session; the animation behavior (smooth reposition on move, fade+collapse on delete) should get a real click-through before calling this fully done.
- [x] **`HeroSection.image_position`, 2026-08-05**: real-image test against a Wix notary-site template found the hero rendered photo-right/text-left when the source had photo-left/text-right — `HeroSection` had no way to control which side `image` renders on at all, always text-then-image. Fixed by adding `image_position?: "left" | "right"` (default `"right"`, matching the only order this section supported before — every existing hero renders unchanged) to `lib/theme.ts`, the backend Pydantic mirror, and `hero-section.tsx` (conditionally renders the image `Editable` block before or after `textColumn`, same as `TextBlockSection`'s existing `image_position` pattern). Prompt updated with the field description and an explicit "only set `left` when the photo is actually on the left" rule. **Hit the recurring Turbopack stale-bundle gotcha during verification** — first round-trip test showed the DOM order unchanged despite `image_position: "left"` correctly persisted in the saved JSON; a plain `docker compose restart frontend` fixed it, consistent with every other occurrence of this gotcha logged in this file. Verified both directions after the restart: a real saved page with `image_position: "left"` renders the image `div` before the `<h1>` in the actual SSR'd HTML (not just class-string presence — checked literal tag order); a page with no `image_position` set still renders text-before-image, unchanged from before this field existed. Test pages deleted after via the delete-page endpoint.
- [x] **`ContainerBlock.min_height`, 2026-08-05 — a second real design (a Wix 3D-printing site) surfaced a pattern neither Hero nor the existing Container/Block system handled: a full-bleed hero banner with the headline/CTA overlaid directly ON a photo (not beside it — Hero only supports side-by-side), and a grid of "numbered" cards whose entire background is a photo with a number/title overlaid near the bottom.** Diagnosed as feasible via the *existing* `ContainerBlock.background_image` mechanism (already renders a photo behind children, absolutely positioned, negative z-index) — the missing piece was purely that a container's height is otherwise 100% content-driven, so a container with just a headline/button as children would collapse far shorter than the design's tall photo band. Fixed by adding `min_height?: "sm" | "md" | "lg" | "xl" | "screen"` (a small fixed set of stops, not an arbitrary value — same reasoning as `BlockWidth`) to `ContainerBlock` (`lib/theme.ts`, backend Pydantic mirror, `container-block.tsx`'s `MIN_HEIGHT_CLASS` lookup) — omitted, every existing container renders exactly as before. **Also fixed a related rendering gap discovered while building this, not a schema change**: a `layout: "column"` container with both `background_image` and `min_height` set now anchors its children to the bottom (`justify-end`) automatically — without this, text would sit stranded at the top of all the extra height `min_height` adds, defeating the point for a hero-style "headline near the bottom of a tall photo" pattern. Deliberately a rendering *default* for this specific combination, not a new schema field — keeps the JSON schema surface unchanged. **Explicitly not built**: no scrim/contrast handling for text over a real photo (unlike `TextBlockSection.background_image`'s unconditional `bg-black/55` + forced white text) — `ContainerBlock`'s children already have their own optional `color`, so contrast is left to whoever sets it (model or CTE user) rather than the component forcing white text, which could be wrong for a light-background photo like this one's. Prompt updated: `min_height`'s description, an explicit rule that a photo-behind-text hero pattern is a Container not a Hero, and a worked example for the numbered-card-grid pattern (a `"grid"` container of `"column"` containers, each with its own `background_image`+`min_height: "sm"`). **Verified**: saved a real page reproducing both patterns (a `full_bleed` hero-style container with `min_height: "lg"` + `background_image` + text/button children, and a `min_height: "sm"` card inside a grid) and confirmed in the rendered HTML: `min-h-[28rem]`, `min-h-64`, and `justify-end` all present on the correct elements. Hit the same recurring Turbopack stale-bundle gotcha as every other component edit this session — a restart fixed it. Test page deleted after.
- [x] **Testimonial/CTA/photo decomposition guidance, same day.** The same Wix design's "Trusted by Visionaries" section mixes testimonial cards with a call-to-action ("Ready to Extrude?") and a stray product photo in an irregular, staggered grid (cards at uneven heights, gaps where a card is visually "missing"). **User's own framing when this was raised**: worried that trying to represent this mix would "搞复杂" (over-complicate things) — agreed, explicitly decided NOT to build any new schema for irregular/staggered grid positioning or mixed-content-type grids (masonry layouts, arbitrary card gaps). Instead, purely a prompt-level fix: added a rule telling the model to decompose this pattern into two ordinary, already-supported sections — a complete/regular `feature-grid` of just the testimonials (`image_style: "avatar"` if they have profile photos), followed by a separate `cta-banner` for the call-to-action — and to simply drop a stray photo mixed into that area rather than forcing it in anywhere. No code changes; this is the same "approximate, don't force an exact layout match" principle already applied elsewhere (e.g. the earlier decision not to chase the exact scattered stat-overlay positions in this same design's "Scale of Innovation" section).
- [x] **First real generation against this design, same day — genuinely mixed results, saved as a real page (`lithos-test` slug) for the user to inspect directly rather than judged from raw JSON alone.** A real ~13MB PNG screenshot, base64-encoded and posted directly to `generate_landing_page` (not a synthetic test — this also caught an unrelated infra gotcha: running that `curl` via the Bash tool's `run_in_background` mode failed silently for an 18MB request body with no backend log entry at all, i.e. the request never arrived; the identical command succeeded immediately when run in the foreground instead — worth remembering if a future large-payload background command fails with no server-side trace). Results:
  - **`min_height`+`background_image`+`full_bleed` worked exactly as designed** for "Scale of Innovation" — the model correctly built a `column` container with all three set, `background_image` pointing at the printer photo, and three number+label text pairs as children, each with an explicit per-pair `color` (alternating dark/white) — a real, unprompted sign the model is at least attempting per-element contrast against the (placeholder) photo, not just defaulting to one color. This is the strongest validation yet that the pattern this field was built for actually works end-to-end, not just at the schema/rendering layer.
  - **The model did NOT reach for the same pattern for the hero banner or the numbered 01/02/03 cards** — despite the new prompt rule explicitly telling it to. The hero came back as a plain `hero` section with a side-by-side `image` (not wrong, just not the full-bleed-photo-with-overlay-text style the source actually shows); the numbered cards came back as ordinary column containers with a separate `image` child each (title/description/image content all correctly extracted, just not styled as a photo-background overlay). Not a code bug — the underlying content extraction was accurate in both cases — read as the model defaulting to the more familiar/simpler pattern it already knows well over a newer, less-reinforced one, consistent with this file's repeated finding that a single prompt mention doesn't reliably change model behavior on the first try.
  - **Testimonials were dropped entirely, not decomposed** — the model produced only the `cta-banner` half of the intended split (content and copy correct: "Ready to Extrude?", the CAD-files body text, "Request Quote"), with no testimonial content at all, not even in a degraded form. This is a real content-loss regression relative to the goal (the instruction said "decompose into two sections," the model effectively did "keep one, discard the other") and is the one finding from this round worth a follow-up prompt reinforcement if the user wants to chase it further — everything else here is within this project's established "close enough" bar.
  - Test page **kept saved** at `lithos-test` (not deleted immediately, unlike this session's usual test-page cleanup convention) specifically so the user can view the actual rendered result directly (`/p/lithos-test` or via `/editor`) rather than only reading a description of the raw JSON — delete it once reviewed.
- [x] **`FeatureGridSection.item_style`, 2026-08-05 — "not every repeated-item design is a card."** Same Wix test found two `feature-grid` sections the fixed card treatment (rounded box, border/background, image top) couldn't express at all: a service list rendered as single-column rows (small square photo left, text right, divided by thin lines, no card chrome) and a 3-column process section with plain stacked text-then-photo, again no card chrome. The `split` layout's left column also had nowhere to put a longer body paragraph + a button (just heading/subheading), which the source design's left column needed. **User's framing before building**: this is an MVP, "大概能跑就行" (roughly working is enough) — not aiming for pixel-perfect fidelity, so the fix stayed intentionally simple rather than a fully general item-styling system. Shipped: `FeatureGridSection` gained `item_style?: "card" | "plain" | "list"` (default `"card"`, every existing generation/saved page renders byte-identical — the original `FeatureCard` dispatch logic is untouched, just gated behind the default), `item_image_position?: "top" | "bottom"` (only meaningful for `"plain"`), and optional `body?: string` / `cta?: ThemeCta` (only meaningful for `layout: "split"`'s left column). New components in `feature-grid-section.tsx`: `PlainFeatureItem` (same grid/row arrangement as `"card"`, no border/background/rounded, image position configurable) and `ListFeatureItem` (small square photo + text, meant for a `divide-y` single-column list). `item_style === "list"` is a genuinely different arrangement, not a per-item style swap within the existing grid — it ignores `columns`/`layout`'s grid entirely and renders one full-width column of divided rows regardless of `layout`. Mirrored in the backend Pydantic model (`FeatureGridSection`, `backend/apis/agent.py`) and the vision prompt (when to pick each `item_style`, plus the `body`/`cta` left-column fields). **Verified**: Pydantic accepts/defaults all new fields correctly, rejects an invalid `item_style`; saved a real page reproducing both problem sections (a `split`+`list` section with `body`+`cta`, and a `stacked`+`plain`+`item_image_position: "bottom"` section) and confirmed in the rendered HTML: `divide-y` and `aspect-square` present for the list section, the body paragraph and CTA button text present in the split left column, and the plain section's item shows text before its image with no card `ring`/`bg-card` classes anywhere near it. Hit the same recurring Turbopack stale-bundle gotcha as the Hero fix above mid-verification — a restart fixed it. Test page deleted after. **Not yet tested against a real vision-LLM generation** — verified at the schema/rendering layer only, same deliberate staging this file has used for every other schema addition; whether qwen3.6 reliably picks the right `item_style` from a real image is untested.

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
- [x] Admin/owner agent-console route contracts reserved (`backend/apis/agent.py`) — originally all 501 until implemented; `generate_landing_page` (2026-08-03), `generate_poster` (2026-08-04), `generate_geo_page` (2026-08-05), and CRM entry capture + report generation (2026-08-06) are all real now — see "CRM + report generation, made real" below for the last two
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

Out of scope by explicit decision — don't suggest: real Firebase Auth or
an actual cloud/EC2 deploy (Phase 1's scope decision). Beyond that, check
the Phase checklists above (`[x]` vs `[ ]`) before proposing a next step
— completed work isn't re-tracked here separately.

**2026-08-06, end of session**: the user explicitly paused feature work
here — "MVP应该是够用够展示了" (the MVP is good enough to demo) — after a
long run building out CTE structural editing (parts 1-13: style editing,
computed-current-values, section/feature-item/cta/container-children
insert-move-delete, hover-reveal polish). A `width`/`height` CTE-editing
proposal (expose the existing `BlockWidth` enum on all 4 block types +
`ContainerBlock.min_height`) was discussed and deliberately shelved, not
built — a real, ready-to-pick-up candidate if this area gets revisited,
not a rejected idea.

Reasonable candidates right now, roughly in order of how directly they'd
increase demo-readiness vs. add new scope:
- **A real in-browser click-through of everything built in CTE parts
  1-13** — still the single biggest gap. No working Chrome extension
  connection existed on this side for the entire session; every fix was
  verified via `tsc`/`eslint`/curl/backend-Pydantic checks plus the
  user's own screenshots, never a live interaction test by this session's
  own tools. Hover-reveal (part 12) in particular is a pure interaction
  property with zero backend-verifiable surface.
- A `/dashboard` viewer for the chat sessions/messages already being
  persisted (session list + per-session transcript, admin/owner-gated) —
  deliberately deferred out of the persistence work itself to keep that
  change small; see "Visitor conversation persistence" above.
- Whether qwen3.6 can reliably generate the Container/Block schema from a
  real design image, *including* the newer nested-children patterns CTE
  now supports editing — the original generation-quality question was
  tested a few rounds (Phase 5's block-schema entries); whether the model
  reaches for genuinely deep nesting on its own, vs. everything tested
  this session being hand-authored via curl, is still open.
- Phase 6 (agent security layer) — entirely unstarted: the isolated
  worker/container, openclaw permission-boundary docs, action logging,
  red-team pass. `apis/agent.py`'s CRM/report routes are still 501 stubs
  waiting on this. The largest remaining piece of the original project
  plan, and the one most different in kind from the CTE/generation work
  this session focused on.
- Smaller, unstarted items already flagged elsewhere in this file:
  chat streaming (SSE/WebSocket), real LLM-driven intent recognition
  (the current `/chat` flow's first few steps are a scripted, not
  LLM-driven, shape), GSAP/ScrollTrigger, Swiper carousel content (built,
  unused, and still not CTE-editable).

Ask the user which, if anything, to pick back up.

---

### 2026-08-07 — real `generate_landing_page` failure: model hallucinated `"type": "row"`, JSON also partially corrupted

The user hit a real 502 from the page generator: "None of the model's
sections matched the page-section schema," with a garbled raw-output
snippet in the error detail — `{ "sections": [ { "type": "row", "gap:
columns, children:[{":".url","alt":"..." }, {"type":":" },"children"] }`
— clearly not well-formed JSON on its face.

**Diagnosis, reproduced exactly rather than guessed at.** Ran the exact
reported string through `json_repair.repair_json(..., return_objects=True)`
directly in the backend container (bypassing the actual vision call
entirely — the raw text was already captured in the error message, no
need to re-run generation to investigate). Confirmed `repair_json`
*does* successfully coerce it into a Python dict — `json_repair` is
aggressive enough to force even quite broken text into some parseable
structure — but the result is telling: `parsed["sections"]` came back as
`[{'type': 'row', 'gap: columns, children:[{': '.url', 'alt': '...'},
{'type': ':'}, 'children']`, i.e. a 3-element list containing one dict
with `type: 'row'` plus two garbled/garbage keys, a second dict with
`type: ':'` (pure garbage), and a bare string `'children'`.

Ran this straight through the existing `_coerce_sections()` to confirm
*why* it produced zero surviving sections (not just assumed): the
`'row'`-typed dict fails Pydantic validation because `"row"` isn't a
valid section-type discriminator value (`PageSection`'s union has no
`"row"` variant — only `"container"` with a separate `"layout"` field
can be `"row"`); the `':'`-typed dict fails for the same reason; the bare
string isn't even a dict, so it's skipped at the `isinstance` check
before validation is attempted at all. Three inputs, three ways to fail,
zero survivors — exactly matching the observed "None of the model's
sections matched" 502.

**The `"type": "row"` part is not a one-off fluke worth shrugging off.**
`_VISION_SYSTEM_PROMPT` (`backend/apis/agent.py`) already contains
several explicit, repeated warnings about exactly this confusion — e.g.
"Prefer the specific section types (1-6) over Container whenever one of
them already fits" and the worked example showing `{"type": "container",
"layout": "row", ...}` as the only correct shape for a row layout. The
model still collapsed the two-field concept (`type: "container"` +
`layout: "row"`) into a single hallucinated `type: "row"` anyway. Given
how much prompt real-estate is already spent trying to prevent this, it
reads as a real, recurring risk for row/column/grid-heavy designs, not a
freak occurrence — worth absorbing in code rather than trusting prompt
wording alone to eliminate it, consistent with this file's established
pattern of lenient, salvage-what's-usable validation (`FeatureItem.href`
defaulting to `"#"`, `_coerce_sections`' per-item feature-grid handling).

**Fix**: new `_normalize_container_type_aliases()` in `backend/apis/
agent.py` — recursively walks a raw (already-parsed) section dict,
including into nested `"children"` arrays, and rewrites any `{"type":
"row"|"column"|"grid", ...}` into `{"type": "container", "layout":
"row"|"column"|"grid", ...rest}` before Pydantic ever validates it.
Called at the top of `_coerce_sections()`'s per-section loop, so it
benefits both `generate_landing_page` and `generate_geo_page` (both
funnel through the same `_coerce_sections`). Deliberately recursive, not
just top-level: a mislabeled nested child inside a real container's
`children` would otherwise fail the *entire* parent container's
validation in one shot (Pydantic validates a nested discriminated-union
list atomically — there's no existing per-child salvage loop for
`children` the way feature-grid items already get one), so the same
hallucination one level deeper is an even more silent, harder-to-diagnose
failure mode than the top-level case actually reported here.

**Verified two ways**, both against the real logic, not just reasoned
about: (1) re-ran the user's *exact* reported garbled string through
`repair_json` → `_coerce_sections` with the fix applied — went from 0
recovered sections to 1 (an empty-but-valid `container`/`row`, since the
original `children` content was itself unrecoverably destroyed by the
corruption — this fix can't resurrect data that was never parseable to
begin with, only rescue sections whose *type* was the only thing wrong).
(2) Regression-checked well-formed input completely unaffected (a
normal hero + nested row/column container + feature-grid all still
validate identically), and confirmed the *nested*-child case works too:
a real outer container whose one child was `{"type": "row", ...}`
previously dropped the whole outer container — now the outer container
survives with that child correctly normalized to
`layout: "row"`.

**What this fix does not solve, and shouldn't be expected to**: the
non-`type` corruption in this exact case (garbled key names swallowing
what should have been `gap`/`children` data) is genuinely unrecoverable
— no amount of schema-level repair can reconstruct content that was
never validly serialized in the first place. That's a real generation-
quality ceiling for this specific request (a row/column-shaped design),
consistent with this project's earlier, separately-documented finding
that deeply-nested Container/Block JSON is measurably harder for the
vision model to produce reliably than the flat composite sections — see
the "Generic Container/Image/Text/Button block schema" and "Deliberately
kept separate, not unified" entries elsewhere in this file. This fix
converts a guaranteed-total-failure case into a partial-recovery case
when the *type* mislabeling is the only thing wrong; it doesn't and
can't fix badly corrupted JSON syntax elsewhere in the same object.

---

### 2026-08-08 — chat-driven lead capture + optional caller identity: verified end-to-end, documented for the first time

Picked up mid-session on "请接着之前完成用户auth" — the feature (a prior
session's work: `apis/chat.py` resolving `get_current_user` to
personalize replies and let a signed-in visitor's requests get logged
under their account email without retyping it) had real, working code
but **had never been verified live or written into `AGENTS.md`** — a
documentation gap, not a code gap.

Verified with real login + chat round-trips against the running stack
(not just read the code): logged in as `user@example.com`, asked for a
quote for a website redesign without ever typing an email in the
message, and confirmed a `CrmEntry` was created using the account's
email automatically (`_maybe_capture_lead`'s `known_email` fallback).
Started a fresh session afterward and confirmed the assistant recognized
the returning visitor and referenced the prior request — the
`(Signed-in visitor: ...)` context block only appears once a visitor has
at least one prior `CrmEntry`, so a first-time logged-in visitor is
correctly treated the same as an anonymous one. Also confirmed
`ChatSession.user_email` gets backfilled correctly via a direct DB query.

Along the way, hit `qwen3.6:latest` as the configured chat model timing
out (`providers/ollama.py`'s 120s `httpx` timeout, empty error message)
during a routine test turn — unrelated to this feature, but the first
concrete evidence in this project that qwen3.6 is unreliable as the
*plain chat* model, not just slow. Temporarily switched the global model
setting to `gemma4:latest` for testing, switched back after — this
became a standing gotcha (see `AGENTS.md`'s "Known gotchas") once the
attachment-analysis work below made multi-model-call turns routine.

Test data (temp chat sessions, a test `CrmEntry`) cleaned up after
verification; `AGENTS.md` gained its first real section for this feature
("Chat lead capture & optional caller identity").

---

### 2026-08-08 — chat file attachment, first pass: public upload endpoint + storage

New ask: let a visitor attach a photo/PDF in the public chat (for a
claim/quote) without requiring login. Since `POST /api/chat` already has
no RBAC gate at all, the new `POST /chat/upload` endpoint needed to be
deliberately *more* paranoid than the admin-gated uploads it's modeled on
(`apis/media.py`, `apis/documents.py`): a fixed extension allowlist
(images + PDF, explicitly no `.svg`/`.html` — either can carry script if
ever opened directly outside the app), an 8MB hard cap, and a random
`uuid4` filename — never the client-supplied name, unlike
`apis/documents.py`'s weaker `{uuid}_{original filename}` pattern (that
one gets away with it only because it's admin-gated).

Wired `ChatRequest.attachment_url` through `chat()`: appended a
`[Attached file: <url>]` marker to both the persisted `ChatMessage` and
the model-facing text, and taught `SYSTEM_PROMPT` what that marker means
(acknowledge it, but be upfront that the model can't see its contents —
this was still true at this point; vision analysis came in the next
pass). Also widened `_maybe_capture_lead`'s gate so a present attachment
alone counts as a lead signal, alongside an email-shaped message or a
known account email.

Verified end-to-end with a real upload → chat turn → `CrmEntry` with
`attachment_url` set, plus explicit negative tests: a `.exe` upload
rejected with a clear message, a 9MB upload rejected for size. Browser
extension wasn't connected this session (a recurring gap — see the CTE
entries above), so the new `chat-panel.tsx` composer UI (paperclip
button, pending-attachment chip, image/file-chip rendering in
`chat-message-bubble.tsx`) was verified via `tsc`/`eslint`
plus confirming `/chat` compiles and renders 200 in the dev server logs,
not a live click-through.

---

### 2026-08-08 — chat attachments, second pass: per-conversation storage + automatic vision/document analysis + owner deep-scan tool

Follow-up ask, same day: organize uploads by conversation (not one flat
directory), and have the AI actually *read* the attachment — extract
name/phone/email/intent automatically so the chatbot stops asking for
information already visible in an attached photo, while still letting
the owner request a deeper, custom-instruction scan later (e.g. pulling
a policy number off an insurance claim photo).

Extracted the upload/analysis logic out of `apis/chat.py` into a new
shared module, `backend/chat_attachments.py` — needed by both the
automatic per-turn path (`apis/chat.py`) and the new owner-triggered
scan endpoint (`apis/agent.py`), and better to have one place own the
safe-path resolution than risk the two copies drifting. Storage layout
changed from `CHAT_UPLOAD_DIR/<uuid4><ext>` to
`CHAT_UPLOAD_DIR/<conversation_id>/<uuid4><ext>`, where
`conversation_id` is the caller's account email if logged in, otherwise
their client-generated `session_id` — verified both cases produce the
expected folder structure via a direct upload + `ls` in the container.

**Analysis**: reused `generate_landing_page`'s exact vision-call shape
(OpenAI-compatible `/v1/chat/completions` against Ollama, an image
content part) for photos; PDFs go through `ingest.parse_document` (the
same parser RAG ingestion uses) into the plain chat provider instead,
since no vision model here can read a PDF directly. Two callers, two
failure postures by design: `extract_lead_info` (automatic, runs on
every attached turn) swallows every failure — a visitor's reply must
never be blocked by a flaky vision call — while `scan_with_instructions`
(owner-triggered, an explicit ask) raises, since silently doing nothing
would just look broken to an admin who asked for it.

Verified with a real vision call end-to-end: uploaded a contentless
1×1 test image (deliberately no readable info, to test graceful
degradation) and confirmed the pipeline ran without error and the
assistant correctly said it couldn't see the file's contents (no
analysis facts were extracted, so `SYSTEM_PROMPT`'s "nothing extracted"
branch fired). Then sent a claim message *with* an email but nothing
else, confirmed the `CrmEntry` captured correctly with `category:
"claim"`. Hit `qwen3.6` as the plain chat model timing out again on a
3-model-call turn (vision + reply + lead-extraction all in one request)
— confirmed this isn't a one-off from the earlier entry above, it's a
real, repeatable ceiling; temporarily ran with `gemma4` for chat/
lead-extraction and `qwen3.6` for vision only, which completed in ~70s
instead of timing out at 120s.

**Owner deep scan**: `POST /agent/crm/entries/{id}/scan` (admin/owner)
lets the owner ask a freeform question about an already-captured entry's
attachment, appending the answer to a new `CrmEntry.analysis_notes`
column (timestamped, accumulating). Surfaced as owner-agent's first tool
needing a path parameter (`scan_crm_attachment`, `{crm_id}` in its
`ToolSpec.path`) — `owner-agent/tools.py`'s `execute_tool` gained a small
generic `{param}`-substitution step rather than a one-off special case.
Verified through the *real* agent loop, not just curled directly: typed
"scan the attachment on CRM entry 10 and tell me what color it is,"
watched the model pick the right tool, call it with `{"crm_id": 10,
"instructions": "..."}`, and correctly report back the (correct, given
the test image) "no primary colors, image is black" answer.

**Security check, done deliberately, not an afterthought**: since
`resolve_local_path` is the one place a client-supplied string
(`ChatRequest.attachment_url`, never re-verified against what upload
actually returned) turns into a real filesystem read, tried an explicit
path-traversal payload (`.../uploads/../../../../etc/passwd`) against
both the scan endpoint and a manually-crafted `CrmEntry.attachment_url`
— rejected cleanly as "file not found," confirming the prefix-match +
two-segment + `resolve()`-containment check actually holds under a real
attempt, not just in theory.

New `CrmEntry` columns (`contact_name`, `contact_phone`,
`analysis_notes`) via two Alembic migrations, both applied and verified
against the running DB. `CrmPanel` grew a name/phone display and a
collapsed "Deep-scan notes" block. All test data (temp uploads, temp
CRM entries) cleaned up after each verification pass.

---

### 2026-08-08 — CRM entry deletion, orphaned-upload cleanup, and public-endpoint rate limiting

Follow-up to a self-review: asked "what's missing" after the attachment-
analysis work above, flagged (among other things) that captured leads
had no delete path short of a direct DB query, uploaded files that never
became a lead just accumulated forever, and the public `/api/chat`/
`/api/chat/upload`/`/api/auth/login` routes had zero abuse protection.
The user picked these two to fix.

**Deletion + cleanup**: `DELETE /agent/crm/entries/{id}` removes an
entry and (best-effort) its attached file together — deleting the DB row
while leaving the file to rot would just be a slower version of the
orphan problem cleanup exists to solve. `chat_attachments.
cleanup_orphaned_uploads` scans the whole upload tree; a file counts as
"referenced" (and is left alone) if either a `CrmEntry.attachment_url`
or a persisted `ChatMessage.content`'s `[Attached file: ...]` marker
points at it — two DB queries total, not one per file — and only
removes what's unreferenced *and* older than `older_than_hours` (default
24h), so a slow typer's in-flight upload is never deleted mid-
conversation. Verified three ways in one pass: an orphaned file survived
a `dry_run` and got removed (including its now-empty conversation
folder) on a real run; a file a real `CrmEntry` pointed at was correctly
left alone by the same scan; deleting that `CrmEntry` afterward then did
remove its file. Both capabilities also reachable as new owner-agent
tools (`crm_delete_entry`, `cleanup_chat_uploads`) — the former needed
`ToolSpec.method`'s `Literal` widened to include `DELETE` and
`execute_tool` taught to treat a `204 No Content` response as
`{"ok": true}` instead of failing to parse an empty body as JSON.
Verified through the real agent loop: "delete CRM entry 12, it's spam"
correctly resolved to `crm_delete_entry` and reported back.

**Rate limiting**: new `backend/rate_limit.py`, deliberately in-memory/
single-process rather than reaching for slowapi+Redis — this app runs as
one uvicorn worker in one container, so there's no multi-process state
to share, and standing up Redis for just this would be new infra this
project otherwise avoids adding speculatively. Scoped narrowly to the
three genuinely public, no-auth routes (`/api/chat`, `/api/chat/upload`,
`/api/auth/login`) rather than the whole API, since every other route
already sits behind `require_role`.

**Real bug caught before it shipped**: initially wired
`app.add_middleware(RateLimitMiddleware)` *after* the existing
`CORSMiddleware` call in `main.py`. Traced Starlette's actual middleware-
stack construction (`Router.build_middleware_stack` — `user_middleware`
is built via `insert(0, ...)`, then wrapped in *reversed* order) rather
than guessing, and confirmed that ordering makes the *most recently
added* middleware the *outermost* layer. That meant `RateLimitMiddleware`
would've ended up outside `CORSMiddleware`, so a 429 short-circuited by
the rate limiter would skip CORS entirely and the browser would report
an opaque CORS failure instead of a readable 429. Fixed by adding
`RateLimitMiddleware` *before* `CORSMiddleware` in `main.py` instead.
Verified live: tripped the login limiter with 11 rapid requests (10/15min
limit), confirmed the 11th came back 429 with `Retry-After` *and*
`access-control-allow-origin` present — the fix actually holds, not just
reasoned through.

Testing the login limiter live meant the author was locked out of their
own test account for the remainder of the 15-minute window — recovered
by restarting the `backend` container (in-memory state, so a restart is
a legitimate, harmless reset, not a workaround).

---

### 2026-08-08 — security audit: JWT_SECRET running on its public default, Postgres exposed to `0.0.0.0`

User asked "现在docker和backend安全吗" (is docker/backend secure now) —
answered with an actual audit against the running config, not a generic
answer: read `docker-compose.yml`, `backend/auth.py`,
`backend/apis/auth.py`, all three Dockerfiles, and `requirements.txt`
directly rather than reasoning from memory.

Found the backend was **actually running** with `JWT_SECRET`'s insecure
literal default (`dev-only-insecure-secret-change-me`) — confirmed via
`docker compose exec backend printenv JWT_SECRET`, not assumed from the
`.env.example` comment. Since that exact string is committed to this
repo's own source, anyone who's read the code can forge a valid
`role: owner` JWT and get full admin access with zero credentials —
the single most severe, concrete (not hypothetical) finding. Separately,
`docker-compose.yml` bound Postgres's `5432` to `0.0.0.0`, with
hardcoded `my_user`/`my_password` credentials — a mapping the app itself
never uses (backend/owner-agent reach Postgres over Docker's internal
network), existing only to let a local DB client connect, and one that
would let anyone on the same network connect directly and bypass every
RBAC/JWT check in the app entirely.

Also verified: no raw SQL string interpolation anywhere in `backend/`
(SQLAlchemy ORM throughout, so SQL injection isn't a live concern); login
returns a generic "Invalid email or password" regardless of whether the
account exists (no enumeration via message content, though a timing
side-channel exists — `verify_password`'s bcrypt call is skipped
entirely when the user doesn't exist, so a nonexistent-email attempt
returns measurably faster; noted as low-severity, not fixed); all three
Dockerfiles run as root (no `USER` directive); `requirements.txt` pins
no upper bounds.

**Fixed, with the user's go-ahead**: generated a real random
`JWT_SECRET` (`secrets.token_hex(32)`) into the local (gitignored) `.env`
— `.env.example` deliberately keeps the insecure literal visible as a
placeholder/warning, not something to actually run with. Rebound
Postgres's port mapping to `127.0.0.1:5432:5432` in `docker-compose.yml`.
Applied both via `docker compose up -d` (recreates `postgres-db`,
`backend`, `owner-agent` — data untouched, same named `pgdata` volume);
verified the new secret was actually live (`printenv` again) and that
existing data survived (`SELECT count(*)` on `users`/`crm_entries`
matched pre-recreate counts). Root-in-container and the unpinned
dependencies were flagged but left unfixed — lower urgency, and the
Dockerfile change needs more care (file-permission implications of
adding a non-root `USER`).

### 2026-08-09 — dashboard's agent console showed a raw 403 for a stale (JWT_SECRET-rotated) session instead of detecting and explaining it

User reported (screenshot) `/dashboard` showing "Owner" in the header
while every agent-console panel rendered a red `ErrorMessage` card
verbatim from the backend: `Something went wrong / Requires one of
roles: ['admin', 'owner']`. Root cause traced directly to the prior
session's `JWT_SECRET` rotation (immediately above): the browser's
`localStorage` still held a token signed with the *old* secret.
`frontend/src/lib/auth.ts`'s `isTokenExpired()` only decodes the token's
own `exp` claim client-side — it never verifies the signature — so the
stale token still looked "not expired" and the header kept showing
`owner@example.com` / Owner. `backend/apis/deps.py:44-52`, however, does
verify the signature; a bad one makes `decode_access_token` return
`None`, which `get_current_user` silently treats as the anonymous `user`
role (by design, so the public chatbot still works logged-out) — so
every `require_role(admin, owner)` route 403'd with that raw detail
string, which every panel's `catch` block (`err instanceof ApiError ?
err.message : ...`) piped straight into `ErrorMessage`'s `description`
unchanged.

User's ask was two-fold: (1) the frontend should detect this on its own
on every page load, not just fail loudly when a panel happens to call
the backend; (2) whatever the UI shows on a real permission problem
should be plain language, never a raw backend exception string.

**Fix** (`frontend/src/components/modules/agent-console-section.tsx`):
added a verification effect that fires once per mount whenever the
*cached* role claims `admin`/`owner` — it calls the already-existing but
previously-unused-by-the-frontend `GET /api/auth/me`
(`backend/apis/auth.py`, returns 200 + the real role for a token that
verifies, 401 "Not authenticated" otherwise) before ever rendering a
gated panel. A `verifying` boolean (seeded `true` at mount whenever the
cached role isn't plain `user`, via `useState(() => role !== "user")`)
gates rendering behind a `LoadingSpinner` ("Checking your session…")
until that check resolves — so no panel ever fires its own
privileged request against a token that's already known to be dead. On
a confirmed-401 response specifically (not on a network/backend-down
error — that's left alone, since a transient failure shouldn't log a
real session out), it calls `clearAuth()` (already existed,
`lib/auth.ts`) and flips a `sessionExpired` flag that swaps the existing
locked `EmptyState`'s copy from "Admin/owner access required" (never
logged in / genuinely wrong role) to "Your session has expired — log in
again" (was logged in, token no longer verifies) — both plain-language,
neither is backend-exception text. This only touches the one section
that was actually reported broken; the same raw-`err.message`-into-
`ErrorMessage` pattern still exists in every other panel's own
load/mutate error paths (`DocumentManager`, `CrmPanel`, etc.) for
non-RBAC failures (upload failed, delete failed, ...) — left as-is,
those weren't the reported problem and a stale/invalid *own* login
session was the only scenario a 403 with that literal detail string
could actually happen from, everywhere else genuinely needs the backend
detail on-screen (e.g. "Invalid email or password" is already plain
language on its own).

Hit one lint failure applying this: `react-hooks/set-state-in-effect`
rejected an unconditional `setVerifying(true)` at the top of the effect
body before the async call — the existing codebase idiom (confirmed by
re-reading `DocumentManager`'s own fetch-on-mount effect) is to only
call `setState` from inside a `.then`/`.catch`/`.finally` callback, never
synchronously in the effect body itself, and to seed the "loading"-shaped
initial value via `useState`'s lazy initializer instead. Rewrote to
match; `npx eslint`/`npx tsc --noEmit` both clean afterward.

**Verification gap**: same as every CTE-era finding in this file — the
Chrome browser extension was not connected this session either
(`tabs_context_mcp` returned "Browser extension is not connected"), so
this was not clicked through live. Verified instead via direct backend
calls: logged in for a real token (`POST /api/auth/login`,
`owner@example.com`), confirmed `GET /api/auth/me` returns `200
{"email":"owner@example.com","role":"owner"}` for it and a clean `401
{"detail":"Not authenticated"}` for the same token with a character
appended (simulates a bad signature, the same failure shape a rotated
`JWT_SECRET` produces) — i.e. confirmed the exact signal the new
frontend check depends on actually behaves as assumed. `tsc --noEmit`
and `eslint` both ran clean against the running `frontend` container; the
dev server's own hot-reload log showed no compile errors after the edit.
Treat as needing a real click-through (open `/dashboard` with a
deliberately stale token in `localStorage`, confirm the spinner then the
friendly locked-state copy appear, never the raw 403 text) before
considering this fully settled.

### 2026-08-19 — embedding gets its own custom endpoint, ComfyUI checkpoint/custom-workflow pickers, `[object Object]` fix, dashboard reorganized into an accordion

A session driven by the user actually running this project against
their own real local llama.cpp/ComfyUI setup and hitting real friction —
several genuine bugs found this way, not hypothetical ones.

**`[object Object]` save error in the model settings panel.** User
reported the dashboard's "Save" button failing with an unreadable
`[object Object]` message. Root cause: `frontend/src/lib/api.ts`'s
`apiFetch` assumed a non-2xx response's `detail` field was always a
plain string (`(errorBody as { detail?: string })?.detail ?? ...`) —
true for every `HTTPException(..., detail="...")` in this backend, but
FastAPI's own Pydantic request-body validation (a 422) sends `detail` as
an *array* of `{loc, msg, type}` objects instead. That array got passed
straight through as `ApiError.message` (typed `string` but not actually
one at runtime) and stringified to `"[object Object]"` wherever a
component displayed it. Fixed with a new `extractErrorMessage(errorBody,
fallback)` that handles both shapes, joining a validation-error array's
`msg` fields into one readable string. Verified via curl: a
deliberately-incomplete `PUT /agent/settings` payload reproduces the
exact 422 array shape, confirming the diagnosis before writing the fix.
Caught one real slip while fixing it: `eslint` flagged the new function
as unused on the first pass — it had been defined but never actually
wired into the `throw new ApiError(...)` call site.

**Embedding needed its own custom endpoint, separate from chat/vision's
shared one.** Built earlier this project as "chat, vision, and embedding
all share one `custom_base_url`" (a confirmed design decision). User then
set up a real dedicated embedding server (`nomic-embed-text-v1.5.f16`,
via a new `llama-embed.ps1` launcher script written this session) on a
different port than their existing chat/vision router — llama.cpp's
`--embedding` mode is a process-level flag, incompatible with serving a
chat model from the same router instance, so this wasn't a config
mistake, it's a fundamental llama.cpp constraint. Confirmed with the user
(`AskUserQuestion`) before reversing the earlier shared-endpoint design:
gave embedding its own `AppSettings.embedding_base_url`/
`embedding_api_key`, its own `CustomEndpointBlock` in the frontend, its
own live-queried model list. New migration `b8e1c4f2a5d7`.

Real diagnostic trail while chasing this: user's router (port 8080,
started via `llama-oneclick.ps1`) actually *listed*
`nomic-embed-text-v1.5.f16` in `/v1/models` (it scans the whole `models/`
folder recursively, no capability filter for embedding the way it has
one for vision), which looked like it should work — but a direct `curl
-X POST http://127.0.0.1:8080/v1/embeddings` against it returned `501
"This server does not support embeddings. Start it with --embeddings"`.
Confirmed the *dedicated* embedding process (8081, started with
`--embedding --pooling mean`) actually returns real 768-dim vectors for
the same model id. Non-router single-model llama-server reports its
model "id" as the literal file path passed to `--model` (e.g.
`D:\AI_Models\llm\llama-cpp\models\nomic-embed-text-v1.5.f16.gguf`), not
a short friendly name the way router mode does — not a bug, just a real
difference between the two launch modes worth knowing before assuming
something's broken.

After the split shipped, user reported "Re-embed all documents" still
failing with "All connection attempts failed" even with the dedicated
8081 server confirmed reachable. Root cause turned out to be simpler than
a code bug: `GET /agent/settings` showed `embedding_provider: "ollama"`
still persisted — the user had picked "custom" + clicked "Test
connection" (which only *probes*, never persists) but never actually
clicked the panel's main "Save" button before navigating to Document
Manager. Re-embed was therefore still trying to reach Ollama (not
running on this machine at all), unrelated to the working 8081 endpoint.
No code fix needed — just walked the user through Save-then-re-embed.

**`llama-embed.ps1` crashed with PowerShell parser errors** ("string is
missing the terminator", "missing closing '}'") the first time the user
actually ran it. Root cause: the script (written earlier this session)
had Chinese comments/strings, and Windows PowerShell 5.1 didn't round-
trip the file's encoding cleanly through whatever codepage the console
used, corrupting quote characters mid-string. User's explicit
instruction afterward: never write non-English text into any file,
Chinese is for conversation only. Rewrote the whole script in plain
ASCII/English; verified clean via
`[System.Management.Automation.Language.Parser]::ParseFile(...)` rather
than just eyeballing it. Also wrote `start_embed.bat` (double-clicking a
bare `.ps1` opens Notepad, doesn't run it — same pattern
`start_qwen3.8.bat` already used for the chat/vision launcher) and
`start_all.bat` (opens both servers in two *separate* windows via
`start`, not chained in one script — `llama-oneclick.ps1` is a
long-running foreground process that never returns, so sequential
execution in one window would just hang after the first; separate
windows also mean one crashing doesn't take the other down). Saved as a
`feedback_language` memory update with this concrete failure as the
reinforcing example, since it's now a real crash risk, not just a style
preference.

**ComfyUI image generation gained two more layers of owner-configurability**,
after the user described wanting something like LocalAI.io's
"download/configure/swap different SD models" flexibility (their own
words: "这只是我的构思，可能不成熟" — floated as a rough idea, not a
fully-formed spec, so this was scoped down via `AskUserQuestion` before
building):
1. **Checkpoint file picker within the existing fixed workflow** —
   `AppSettings.image_comfyui_unet`/`_clip`/`_vae`, live-queried from
   ComfyUI's own `GET /object_info/{node_class}` (new
   `apis/api.py::list_comfyui_loader_options`). Confirmed via curl this
   actually reflects installed files (the user's ComfyUI reported one
   unet, several real clip/vae options). New migration `c4d9f1a3e6b8`.
2. **An entirely custom, owner-pasted ComfyUI workflow** — user's actual
   ask turned out to be bigger than a checkpoint picker: "custom 自己的
   8188，使用已经配置好的工作流" (use their own already-configured
   ComfyUI workflow, any architecture, not just this app's fixed one).
   Landed as `AppSettings.image_comfyui_workflow` (ComfyUI's own "Save
   API Format" JSON export, pasted verbatim) +
   `image_comfyui_prompt_node`/`_field` (where to splice the generation
   prompt in). Scoped to prompt-text-only for v1 (no seed/size node
   mapping) per explicit user confirmation. `update_settings` validates
   the JSON parses, the named node exists, and has the named input field
   at *save* time; `ComfyUIImageProvider.generate()` re-validates at
   generation time as defense-in-depth. New migration `d7f2a8c1b4e9`.
   Verified end-to-end by feeding the project's own
   `comfy/image/image_z_image_turbo.json` back in as a "custom" workflow
   (node `57:27`, field `text`) — saved cleanly, `generate_poster`
   produced a real new image through the custom-workflow code path, and
   a deliberately-wrong node id (`"99"`) correctly 400'd at save time
   instead of failing later.

**`page-generator-panel.tsx` had a stale hardcoded "qwen3.6"/"36B model"
label** — leftover from before vision generation became provider-
agnostic, same class of bug as the earlier `/api/chat` SYSTEM_PROMPT
"running via Ollama" fix. User caught it by pasting the panel's actual
rendered copy. Fixed by fetching `GET /agent/settings` on mount and
building the label from whatever `vision_provider`/`vision_model` is
actually configured, with a generic fallback phrase if that fetch fails
or hasn't resolved yet. Grepped the rest of `frontend/src/` and
`backend/` for the same stale-model-name pattern afterward — nothing
else user-facing left, the remaining hits are an env-var default and
code comments.

**Dashboard reorganized into a collapsible accordion.** Eight panels
stacked flat (Model settings, Document manager, GEO page, Poster, Page
generator, Saved pages, CRM, Report, Owner agent) had become hard to
navigate as each grew — `ModelSettingsPanel` alone now has 4 pickers +
2 custom endpoints + a checkpoint picker + a custom-workflow textarea.
Confirmed accordion-vs-tabs with the user first (`AskUserQuestion`,
accordion won for letting more than one group stay open at once). New
`frontend/src/components/ui/accordion.tsx` — hand-written, not
`npx shadcn add`, since `@base-ui/react` (already a dependency for
`select.tsx` etc.) already ships an `accordion` submodule, no new
package needed. Four groups: AI & knowledge base / Content generation /
CRM & reporting / Owner agent (owner-only), `multiple` open allowed,
starts fully collapsed.

**Verified generate_landing_page end-to-end for the first time this
session** with a real (synthetic, PIL-drawn) mockup image — a 5-region
page (header/hero/features/CTA/footer) through the currently-configured
`Qwen3.8_Uncensored` vision model. Result was a strong match: correct
headline/subheadline/both CTA labels in the hero, plausible icons/
descriptions the model invented for 3 sparse feature labels, header/
footer correctly fell back to generic `container` blocks (no dedicated
section type for either). Saved to a throwaway slug, hit a `.next` dev-
cache 404 on first render (this project's single most-recurring class of
bug — a Server Component fetch to the backend from inside the frontend
container worked fine when replicated by hand via `docker compose exec
frontend node -e "fetch(...)"`, but the actual route kept 404ing until
`docker compose restart frontend`), then confirmed the real generated
copy ("Build Faster With Acme", "Sign Up Free", ...) in the rendered
HTML. Deleted the test slug afterward — no leftover test data.

**Chrome browser extension still never connected**, consistent with
every prior session — `tabs_context_mcp` returned "Browser extension is
not connected" again. Every verification above went through
curl/`tsc`/`eslint`/direct backend calls instead, same posture as every
other UI change this project has shipped without a live click-through.

### 2026-08-19 (continued) — local resource coordination between chat/vision and ComfyUI

User's stated goal: build this as a real MVP capability ("这样这个mvp才
会比较完善有卖点" — so this MVP would be more complete, have a selling
point), not just personal convenience — should work on their own
memory-constrained GPU machine and generalize to a visitor with no GPU
at all.

Before designing anything, spent the first part of this session
gathering real facts rather than assuming. User's own screenshots: Task
Manager showed system RAM at 95% (29.8/31.4GB) with 76% disk I/O
(consistent with paging), while GPU *compute* utilization read only 5%
— their own read of this was "GPU isn't stressed." Resource Monitor's
top RAM consumer by Commit was `python.exe` at 48GB (confirmed by the
user to be ComfyUI, launched via `python main.py`), but its Working Set
was only 1.4GB — Commit and Working Set diverge a lot for a PyTorch
process, so this alone didn't pin down the real physical-memory culprit.

Queried the user's actual running services directly (all via curl) to
find out what's really available, rather than guessing:
- `llama-server.exe --help` (chat/vision router, port 8080) revealed
  real, already-existing flags: `--models-max` (default 4, router
  auto-evicts beyond this), `--models-autoload` (default enabled),
  `--sleep-idle-seconds` (default -1/disabled).
- `GET http://127.0.0.1:8080/v1/models` showed each model carries a live
  `status.value` (`"loaded"`/`"unloaded"`) — the router already tracks
  this.
- Probed for an explicit unload endpoint by trying several plausible
  paths; `POST /models/unload` (bare, not under `/v1`) returned a
  *different* error shape (`"model is not found"`) than the definitely-
  nonexistent paths (`"File Not Found"`), confirming the route was real.
  Confirmed the exact payload shape by actually calling it —
  `{"model": "Qwen3.8_Uncensored"}` → `{"success": true}` — a real,
  live side effect on the user's running system (immediately verified
  it flipped to `"unloaded"` via `/v1/models`; not destructive, just an
  eviction the router reloads on its own next request).
- `GET http://127.0.0.1:8188/system_stats` (ComfyUI) confirmed live
  per-device `ram_free`/`vram_free` reporting. Its GPU device entry was
  the real surprise: an RTX 5090 Laptop GPU with 25.65GB total VRAM, but
  only 4.16GB free (~84% used) — directly contradicting the user's
  "GPU isn't stressed" read, which was based on compute % (5%), not
  memory occupancy. VRAM can be fully occupied by an idle, loaded model
  while compute utilization sits near zero — worth surfacing back to
  the user as a real correction to their mental model.
- `POST http://127.0.0.1:8188/free` with a no-op body
  (`{"unload_models": false, "free_memory": false}`) confirmed the route
  exists (200) without actually freeing anything, before committing to
  a design around it.

This reconnaissance directly reshaped the design that got built. The
original ask ("LLM and agent both need to step aside for SD, then get
resources back") sounded like it needed a from-scratch scheduler; the
actual gap turned out to be much narrower — llama.cpp and ComfyUI both
already have real memory-release primitives, nothing was calling them at
the right moments, and nothing was deciding *whether* to (unconditional
unload-before-every-generation would cost a real reload delay on the
next chat turn — this session's own earlier measurement was 159s cold
for the user's 27B model).

Built `backend/resource_broker.py` — `maybe_release_llm_memory(db,
comfyui_base_url)` (checks ComfyUI's own free-memory numbers first, only
unloads the chat/vision model if actually below a configurable headroom;
`AppSettings.resource_coordination_headroom_mb`, default 4096MB) and
`release_comfyui_memory(base_url)` (always called after a ComfyUI job,
no threshold — freeing has no reload-latency downside). Wired into
`generate_poster` (before) and `ComfyUIImageProvider.generate()`'s
`finally` (after, so every caller benefits, not just `generate_poster`).
Both swallow every failure — this is an optimization, never allowed to
break a real generation. Gated behind `AppSettings.
resource_coordination_enabled` (off by default) — zero cost for anyone
not running local processes (cloud-only OpenAI/Anthropic setups).
New migration adding both `AppSettings` columns.

Verified end-to-end against the user's actual live setup, not mocked:
(1) force-loaded the chat model via a real chat-completion call,
confirmed `"loaded"` via `/v1/models`; (2) enabled coordination with a
deliberately huge headroom (999999MB, guaranteed "tight"), called
`generate_poster` (real 200, real new image), confirmed the model
flipped back to `"unloaded"` and ComfyUI's `/system_stats` showed VRAM
free jump from ~4GB to ~23GB after the job; (3) re-loaded the model,
lowered headroom to a realistic 512MB (easily cleared by the now-freed
memory), called `generate_poster` again, confirmed the model correctly
*stayed loaded* — the skip-when-not-tight path working as designed,
avoiding an unnecessary reload cost. Left the feature enabled at the
resting default (4096MB) rather than reverting to disabled, since it's
a real, tested improvement for the user's actual constrained setup.

**Follow-up, same day**: user pushed back on the v1 scope cut ("true
concurrent-request contention... isn't handled") the moment it was
raised — their own framing: an interrupted visitor chat is a real UX
problem for a product whose whole point is capturing leads through the
chatbot, and they'd prioritize protecting that over the owner's own
poster-generation convenience. Agreed and closed the gap: added
`resource_broker.has_active_chat_requests()`, backed by a plain
module-level counter (`chat_request_started`/`chat_request_finished`,
same single-uvicorn-worker assumption `rate_limit.py`'s in-memory
limiter already documents — no cross-process coordination needed).
`apis/chat.py`'s whole `/api/chat` handler body (attachment analysis
through the final `return`) now runs inside `try/finally` holding this
counter for the entire turn, not just the main reply call, since one
turn can trigger up to 3 chat/vision router calls.
`maybe_release_llm_memory` now refuses outright whenever the counter is
nonzero, before even checking the memory-pressure threshold.

Verified with a real concurrency test, not just unit-level reasoning:
force-loaded the model, launched a real `/api/chat` call in the
background (a genuine multi-second local-LLM round trip), and — while it
was still in flight — fired `generate_poster` with the headroom forced
impossibly high (999999MB, guaranteed "tight"). The model stayed
`"loaded"` through that call, confirming the guard actually held under a
real overlapping request rather than just in isolated calls. Once the
background chat's own response came back (confirmed a real 200 with
actual reply content), immediately reran `generate_poster` with the same
settings — this time the model correctly flipped to `"unloaded"`,
confirming the counter cleanly returned to 0 and didn't get stuck. Left
explicitly unclosed: a visitor's *next* message landing just after an
unload-and-reload cycle has already started (the counter was 0 at the
moment `maybe_release_llm_memory` checked, then a new turn arrives
mid-reload) — narrowing that further needs real request queueing, sized
as a separate, bigger piece of work if it's ever needed.

### 2026-08-19 (continued) — owner-agent gets a queryable DB action-log and a generate_landing_page tool

Picked up two items straight off the "still open" list from earlier this
session: the JSONL-only action log, and `generate_landing_page` never
having been wired into owner-agent's tool allowlist.

**DB action-log**: added `OwnerAgentRun` (`backend/models.py`) — one row
per completed run (command, final_answer, stopped_reason, the full step
trace as JSONB, owner_email, created_at), new migration `f3c8d2a5e6b1`.
Deliberately additive, not a replacement: `owner-agent/logging_.py`'s
per-step `logs/runs.jsonl` write stays exactly as it was — owner-agent is
still DB-less by design (see its own main.py docstring), so that file
remains its only durable record if the new backend call ever fails.
`main.py`'s `/run` handler now also calls a new `POST
/agent/owner-agent/runs` once per completed run (best-effort — a logging
failure never fails the response the owner is waiting on);
`owner_email` comes off the same forwarded bearer token every tool call
already carries, not a client-supplied field. `GET
/agent/owner-agent/runs` (paginated via `limit`, newest-first) is what
actually makes this queryable. `OwnerAgentPanel` renders the result as a
collapsed "Recent runs" list under the live-run UI, refetched after every
new run.

**`generate_landing_page` as a tool**: the original exclusion reason
("takes an image upload, doesn't fit a text-command tool") was real, but
the actual fix turned out narrower than a redesign — asking a
text-generation model to reproduce a whole image as base64 inside its own
JSON tool-call args is neither reliable nor something it should ever be
asked to do, so the tool takes a **URL** to an already-uploaded image
instead. The owner uploads a design image via the dashboard's media
library (or CTE's Upload tab, which already existed) first, gets a URL
back, then references it in their command to owner-agent.

Implementation: refactored `apis/agent.py`'s `generate_landing_page` route
— extracted the actual vision-call/parse/validate logic into a shared
`_generate_landing_page_sections(db, image_b64, notes)` helper — then
added a sibling route, `POST /agent/landing-page/generate-from-url`,
which resolves the given URL back to a real local file via a new
`apis/media.py::resolve_media_local_path` (deliberately mirrors
`chat_attachments.resolve_local_path`'s exact paranoid shape: exact
prefix match, exactly one path segment, a `resolve()`-based containment
check before ever touching disk — copied the pattern rather than
inventing a new one), reads the bytes, base64-encodes, and calls the same
shared helper. `owner-agent/tools.py` gained the `generate_landing_page`
tool pointing at this new route — genuinely just another plain-JSON-args
tool, no special-casing needed in `execute_tool`, since the model only
ever has to produce a URL string and an optional notes string, never
image bytes. Also gave `ToolSpec` a per-tool `timeout` field (this tool
sets 620s) — the shared 200s default (sized for poster generation) would
have cut off a slow vision+JSON generation mid-call, since backend itself
already budgets up to 600s for that single call.

Verified end-to-end, not just per-piece: uploaded a real PNG to the media
library (`POST /agent/media/upload`), called
`generate-from-url` directly first (200, real generated sections,
isolating backend correctness before trusting the LLM to pick the right
tool) — then ran the actual thing through `owner-agent`'s real `/run`
with the natural-language command "Generate a landing page from this
design image: <url>". The model correctly chose `generate_landing_page`
(not any other tool), correctly extracted the URL into `args`, got back
real generated sections, and — reading its own tool's description
faithfully — closed with a final answer explicitly noting the result
wasn't saved/published yet and telling the owner to review it in the Page
generator panel. Confirmed the DB write actually happened too: `GET
/agent/owner-agent/runs` returned exactly one row, correct owner email,
correct step count (2: the tool call + the final answer), correct
command text.

### 2026-08-19 (continued) — Dockerfiles run as non-root, requirements.txt pinned

Closed the last two items from the running security-audit list. Both
looked mechanical going in; both surfaced a real bug on the first
attempt, exactly the "needs care around file-permission implications"
warning this was flagged with earlier in the project.

**`requirements.txt` pinning**: straightforward — pulled exact currently-
installed versions via `pip freeze` inside the running `backend`/
`owner-agent` containers (not guessed upper bounds) and rewrote both
files from `>=`/unconstrained to `==`. Rebuilt both images to confirm a
fresh install with the pinned file still resolves cleanly.

**Non-root Dockerfiles**: added `appuser` (uid/gid 1000) to `backend`/
`owner-agent`'s `python:3.11-slim` images (`groupadd`/`useradd`, `chown
-R` before `USER` switches) and switched `frontend` to `node:22-slim`'s
already-built-in `node` user. Rebuilt all three, recreated containers.

Two real breakages found immediately, neither hypothetical:

1. **`frontend` crashed on first boot**: `next dev` threw `EACCES:
   permission denied, mkdir '/app/.next/dev'`. Root cause: `.next` is
   listed in `frontend/.dockerignore` (Next only ever creates it at
   runtime, never present in the built image), so the Dockerfile's
   `chown -R node:node /app` had nothing at that path to act on — when
   Docker created the fresh anonymous volume for `/app/.next` (see
   docker-compose.yml), it seeded it from the image with whatever was
   there, which was nothing, so the volume came up as an empty,
   root-owned directory by Docker's own default. Fixed by adding
   `mkdir -p /app/.next` immediately before the `chown` line, giving both
   the chown and the volume-seed something real to work with. Verified
   via `docker compose run --rm --entrypoint sh frontend -c "ls -la
   /app/.next"` before the fix (root-owned) and after
   (`node`-owned), then a real `docker compose up -d --renew-anon-volumes
   frontend` + `curl /dashboard` (200, no crash) to confirm.
2. **`backend` couldn't write to any of its upload directories**:
   `touch /app/storage/documents/.write_test` → `Permission denied`.
   Root cause: unlike `frontend`'s anonymous volumes, `backend`'s entire
   `/app` (including `storage/`) is a straight bind mount from the host
   (`./backend:/app`) — the Dockerfile's build-time `mkdir`/`chown` are
   completely moot here, since the bind mount shadows the image's `/app`
   entirely at container start. The actual `documents`/`media`/
   `chat_uploads` subdirectories already existed on disk from real
   uploads earlier this project (mode `755`, root-owned — created back
   when the container ran as root). A one-time `docker compose exec -u
   root backend chown -R appuser:appuser /app/storage` fixed it; this is
   a migration concern for *this existing checkout*, not an ongoing code
   issue (anything `appuser` creates from now on is appuser-owned
   automatically). `owner-agent`'s `./owner-agent/logs:/app/logs` bind
   mount, by contrast, was already writable with no extra step needed —
   confirms this needs checking per-directory, not assumed uniform across
   every bind mount.

Verified both fixes with real writes, not just `whoami`/`id`/`touch`: a
genuine `POST /agent/documents/ingest` (chunked, embedded, ended up
`status: "ready"`, deleted afterward — no leftover test data) through
the now-non-root `backend`, and `next dev` actually serving `/dashboard`/
`/chat` (`200`) through the now-non-root `frontend`. Also re-ran the
full regression sweep after recreating all three containers — chat
completion, owner-agent health, `/agent/settings`, both frontend
routes — all green, nothing else broke from the rebuild.

**Committed for the first time in a while** — `a2218be`, 62 files, the
full accumulated backlog (this session's work plus the prior session's
owner-agent/rate-limiting/chat-attachments/CRM work that had never been
committed). Deliberately left 3 untracked items out:
`ai-mvp-project-plan.pdf` (confirmed via `git log` that a prior commit,
`cc27ff4`, had deliberately *removed* this exact file from tracking —
re-adding it would reverse that decision; also turned out to be an
empty 1-page placeholder PDF, not real content), a personal
`Video Project (10mb).mp4`, and a 51MB `materials/` folder of local
test/reference assets (sample PDFs, design screenshots, wix template
dumps).

### 2026-08-19 (continued) — owner-configurable structured data collection (intent schemas), validated against insurance

User laid out a genuinely large vision: a framework (not an insurance-
specific feature) where an owner defines what information the public
chatbot needs to collect for a given kind of request, and the bot
collects it conversationally without ever re-asking for something
already given — generalizing across verticals (insurance, real estate, a
clinic, a restaurant, a law firm, personal e-commerce, ...) purely by
what the owner configures, not by writing new code per industry. Also
touched on RAG-based recommendation ("suggest the right policy") and
URL-based document auto-embed as part of the same bigger picture.

Rather than immediately building the whole vision, walked through what
already existed (RAG document embedding — real, already verified this
session; the chat's automatic lead-capture classification — real, but a
fixed 4-category enum with no way to define custom fields; no dedup or
merge logic at all in `_maybe_capture_lead`, which today always inserts
a brand-new `CrmEntry` even mid-conversation) versus what was genuinely
new, then used `AskUserQuestion` to pin down three foundational decisions
before designing anything: (1) owner defines collection rules via a
**structured form** (field name/type/required/scenario), not free text
for the model to interpret; (2) dedup is **scoped to the current chat
session only**, not cross-session by visitor identity, but *within* that
scope must look up an already-created record **by its own id** and
compare against what's still missing, not re-derive from scratch each
turn; (3) validate against **insurance** first (the vertical described in
the most detail) before generalizing further. Recommendation and
URL-based auto-embed were explicitly scoped OUT of this round — separate
concerns layered on already-working RAG, not required to prove the
collection mechanism itself.

**Design**: two new tables, `IntentSchema` (key/label/description — an
owner-defined "kind of request") and `IntentField` (field_key/label/
field_type/required/prompt_hint/sort_order, cascade-deleted with its
schema). `CrmEntry` gained three nullable columns:
`intent_schema_id` (which schema this row is an instance of),
`collected_fields` (JSONB, `{field_key: value}`), and `chat_session_id`
(FK to the already-existing `ChatSession.id` — the join key that makes
same-session lookup possible without inventing a new identity concept,
since every `/api/chat` turn with a `session_id` already resolves/creates
one). New admin/owner router `backend/apis/intent_schemas.py`
(list/create/update-whole-schema/delete, mirrors `apis/documents.py`'s
gating pattern) plus a new `IntentSchemaPanel` dashboard component
(structured form: key/label/description + a repeatable field-row editor)
added to the "CRM & reporting" accordion group above `CrmPanel`.

**The real behavior change is in `apis/chat.py`**. Read `_maybe_capture_lead`
and `_lead_extraction_system_prompt` in full before touching anything —
confirmed the exact gap: today's flow always INSERTs, never looks up or
updates. Rewrote both:
- `_lead_extraction_system_prompt` now builds its classification options
  *from the owner's configured schemas* (each schema's key/label/
  description becomes a category, its fields become extractable targets)
  when any exist, falling back to the original fixed
  appointment/quote/claim/inquiry four byte-for-byte when the owner
  hasn't configured any.
- New `_find_active_entry(db, chat_session_id)` — the most recent
  `CrmEntry` matching `(chat_session_id, intent_schema_id IS NOT NULL)`.
  When found, its `collected_fields` feed BOTH the extraction prompt (so
  the model only reports newly-found values, told explicitly not to
  null out anything it doesn't have new info for) AND — this took a
  second pass, the first draft only wired it into the extraction call —
  the main reply's own context via a new `_in_progress_context_block`
  (mirroring `_build_visitor_context`'s existing pattern), because the
  classification call alone updating `collected_fields` silently
  wouldn't stop the assistant's own conversational reply from re-asking
  for something it already had. `SYSTEM_PROMPT` gained a clause teaching
  the model what a `(In-progress ...)` context line means.
- On a hit against the same `(session, schema)`, `_maybe_capture_lead`
  now `dict`-merges new field values into the existing row and commits —
  no second INSERT. On a miss, or when no schemas are configured at all,
  behavior is unchanged: a fresh `CrmEntry`.
- **A real, deliberate tradeoff, flagged rather than hidden**: the
  original narrow gate (`_LEAD_EMAIL_RE`/known email/attachment — most
  turns aren't leads, so most turns skip the extra LLM call) doesn't work
  for multi-turn structured collection (e.g. "what's your policy number"
  with no email anywhere yet) — extraction now runs on *every* turn once
  the owner has configured at least one schema. Zero added cost for an
  owner who hasn't touched the feature.
- Also caught and fixed along the way: `CrmEntryResponse`
  (`apis/agent.py`, backs `GET/POST /agent/crm/entries`) didn't expose
  the two new columns at all — the API would have silently hidden
  `collected_fields` from the dashboard even though the DB write was
  correct, not discovered until checking why the CRM panel had nothing
  to render.

**Verified end-to-end against the real chat pipeline, not unit-level
reasoning**: (1) regression — sent a plain appointment-shaped message
with zero schemas configured, confirmed the exact same `category:
"appointment"` capture as before this feature existed, one row, deleted
after; (2) created two real schemas via the API
(`insurance_claim`: policy_number/incident_date/incident_description;
`insurance_application`: full_name/date_of_birth/desired_policy_type);
(3) a real 3-turn `/api/chat` conversation (same `session_id`
throughout) dribbling out a claim: turn 1 gave only an email (reply
correctly asked for policy/incident details, not generic questions) →
turn 2 gave the policy number (reply acknowledged it and asked only for
the remaining two fields, did NOT re-ask for the email) → turn 3 gave
the incident date/description (reply recognized everything was now
collected and gave a clean confirmation summary instead of continuing to
ask questions). `GET /agent/crm/entries` after each turn confirmed
**exactly one row** throughout (same `crm_id`), `collected_fields`
accumulating `policy_number` → `+incident_date` → `+incident_description`
across the three calls, never a second partial row. Deleted the test
entry afterward, kept the two schemas as a working example in the
dashboard for the user to explore.

### 2026-08-19 (continued) — owner-agent-generated review queues

Immediate follow-on to the intent-schema work above. User confirmed the
schema side (dashboard form) was sufficient as-is, then described the
next layer in real detail: rather than a hand-built "Policy" entity with
a fixed approval workflow, **owner-agent itself should generate the
review/approval queue** from a plain-language request — "I want to
generate a user list from CRM insurance applications, see who's
interested, record it for me to approve" — figuring out the right
statuses (defaulting sensibly, e.g. approved/rejected/pending, if the
owner doesn't specify) and letting the owner/admin click through entries
and change status. Explicit framing: "因为每一个owner的需求都不一样,
所以我们主要做一个框架,让agent完成custom的部分" (every owner's needs
differ, so build a framework and let the agent handle the custom part).

Before designing, confirmed one real architectural constraint directly
with the user rather than assuming: owner-agent's `/run` loop can't
pause mid-execution for a genuine back-and-forth — it runs autonomously
to a turn limit and returns one final answer (see agent_loop.py's
existing turn-budget design). So "the agent asks the owner to confirm
what's missing" (as the user originally described it) can't literally
block and wait; confirmed the accepted shape instead: apply a sensible
default, state the assumption plainly in the final answer, and the owner
sends a follow-up command to adjust — no new human-in-the-loop pause/
resume machinery needed. This also directly served the user's other
stated goal ("不想给owner agent太大的工作量" — don't want to give
owner-agent too much workload): a single deterministic upsert call is
much simpler and more reliable for a tool-calling model than a genuinely
interactive multi-turn negotiation would have been.

**Design**: new `IntentView` model (`intent_schema_id`, `name`,
`description`, `status_options: JSONB`) — one row per schema in
practice, enforced by upsert-by-`schema_key` semantics in the API
(`POST /agent/intent-views`) rather than a DB constraint, specifically
so a follow-up owner-agent command adjusts the same queue instead of
needing to track a numeric id across separate `/run` calls. New
owner-agent tools: `list_intent_schemas` (so the model checks what
schemas actually exist before guessing a `schema_key` — added
specifically to prevent exactly the kind of mismatch a blind guess could
produce) and `manage_review_queue` (the upsert call itself).
`CrmStatusUpdateRequest.status` (`apis/agent.py`) widened from
`Literal["new","contacted","closed"]` to plain `str` — the DB column was
already an unconstrained `String(16)`, so the `Literal` was purely an
API-level relic that would have rejected a queue's own custom statuses
like `"approved"`. New frontend `ReviewQueuePanel`, its own top-level
accordion group ("Review queues," not folded into "CRM & reporting" —
the user explicitly asked for this to live somewhere distinct) —
deliberately no dashboard form to create/edit a queue's own definition,
since that's the one piece meant to stay agent-driven per the confirmed
workflow. Email/SMS notification on status change is explicitly
deferred by the user ("邮件应该有template,晚点再做这部分") — no
template system, no sending infra, no stub/dead code for it either.

**A real regression surfaced immediately on the first live test** — the
very first `POST /run` for "I want to review insurance applications..."
came back 500. Backend traceback pointed at `owner-agent/logging_.py`'s
`log_step`: `PermissionError: [Errno 13] Permission denied:
'logs/runs.jsonl'`. Root cause: the non-root Dockerfile switch earlier
today only actually verified that a *fresh* file could be written into
`/app/logs` (a `touch .write_test` succeeded, since creating a new file
only needs the directory to be writable) — but `runs.jsonl` itself
already existed on disk from before the switch to `appuser`, still owned
by `root` with mode `644` (owner-write only). Appending to an *existing*
file needs write permission on the file itself, not just the directory
containing it — a real gap in the earlier verification, not something
the earlier test was wrong about, just incomplete (it happened to test
the empty/non-existent-file case, not the pre-existing-file case).
Fixed identically to the `backend/storage/` case from earlier: `docker
compose exec -u root owner-agent chown -R appuser:appuser /app/logs`,
confirmed with a real `>>` append, then reverted the one-line test
append so the log file stayed clean (removed via `head -n -1` rather
than leaving junk in a real audit log).

**Re-ran the exact same command after the fix — worked exactly as
designed**: the model called `list_intent_schemas` first (unprompted
beyond the tool's own description), correctly disambiguated
`insurance_application` from `insurance_claim` based on the owner's
wording, called `manage_review_queue` with the three default statuses
since none were specified, and closed with a final answer explicitly
naming the default and inviting a follow-up to change it — matching the
confirmed design point-for-point. Verified the upsert semantics
separately too (direct API calls, not just the agent path): called
`POST /agent/intent-views` twice for the same `schema_key` with
different `status_options`, confirmed one row throughout (same `id`,
same `created_at`), not two. Then a real chat turn giving name/DOB/
desired-policy-type all at once correctly populated all three
`collected_fields` in a single shot (nothing left missing, so the
model's reply moved on to other helpful questions instead of asking
about fields it already had), and `PATCH .../status` with `"approved"`
— which would have 422'd under the old `Literal` — succeeded cleanly.
Deleted the test CRM entry afterward; kept the "Insurance Applications"
review queue and both intent schemas as working examples in the
dashboard.

---

## 2026-09-08 — CTE "AI fill content" / "AI adjust layout", and a run of
real bugs caught against the user's own live local setup

This entry preserves the full narrative behind the condensed "CTE" /
"AI provider is swappable" sections of the current `AGENTS.md` — read
that file first; come here only for the blow-by-blow root-cause story
behind any one of these fixes.

### The ask: make CTE "smarter"

The user's own framing: once a layout is arranged in CTE, they wanted to
tell an AI what they want and have it fill in text/CSS/images for that
already-decided layout — "就像ai生成网页一样，但是用的是用户确认好的布局" (like
AI generating a webpage, but using the layout the user already
confirmed). Three scope questions were put to the user via
`AskUserQuestion` before building anything:

1. **Image handling** — the user's own answer, verbatim: generation is
   slow/resource-heavy, so each image should get its own generate
   button, only appearing after text generation, and if more than one
   image needs generating there should be a real queue with the ability
   to jump the queue and see a list.
2. **Trigger granularity** — whole-page at once (the recommended,
   user-confirmed option), not a per-section prompt.
3. **Apply mode** — directly into the current live editing state (the
   recommended, user-confirmed option), matching how every other CTE
   edit already behaves ("apply immediately, Save is a separate,
   explicit step").

### Building "AI fill content"

Read the full existing schema (`frontend/src/lib/theme.ts`, its Pydantic
mirror in `backend/apis/agent.py`), the CTE editing machinery
(`lib/cte.ts`'s path-based `setByPath`/`getByPath`, `CteEditorPopover`'s
draft-state-then-live-apply pattern), and the existing image-generation
call shape (`ImageFieldEditor`'s "Generate" tab, `lib/poster.ts`'s
`generatePoster`) before writing anything, to make sure the new pieces
reused exactly what already existed rather than inventing parallel
mechanisms.

Landed as: `frontend/src/lib/page-ai-fill.ts`'s `collectFillableFields`
recursively walks the CURRENT `sections` tree (including
`ContainerBlock.children` at any depth) and extracts a flat manifest of
`{path, kind: "text"|"text-list"|"image", label, current_value}` for
every content-bearing field it can identify by section/block type —
deliberately excluding anything structural (`layout`, `width`,
`columns`), functional (`href`, product bindings), or already-real-data
(`MapBlock.query`, an actual address). `backend/apis/agent.py`'s new
`POST /agent/pages/ai-fill-content` takes that manifest + the owner's
prompt, optionally grounds it in real ingested company-material
documents (reusing `_gather_ready_document_text`, the same helper
`generate_geo_page` already uses), and asks `resolve_chat_provider` for a
value per field — text fields get real copy, `text-list` fields (badges)
get a `"|"`-joined short list, image fields get a short
image-generation-prompt suggestion, never an actual image. Every path
the model echoes back is re-validated against the exact requested set
before being trusted — a hallucinated/mangled path can never reach
`setByPath`, matching this schema's existing "code guarantees structure,
the LLM only supplies content" discipline (`_coerce_sections`'s own
posture).

Applying the result: text/text-list values write straight into the live,
unsaved `sections` state the instant the response lands (`onApplyText`/
`onApplyTextList` in `cte-editor-panel.tsx`, both just thin
`setByPath` wrappers reusing handlers already built for every other CTE
edit) — a `RichText`-object field (one that already carries an owner-set
color/size/weight) keeps that styling; only `content` is replaced
(`page-ai-fill.ts`'s `richTextOf` extracts the style once at collection
time, `handleAiApplyText` merges it back in on apply). Image fields never
get auto-generated: each populates one row in `AiContentAssistant`'s own
Sheet (a new floating "✨ AI fill content" button, gated on edit mode),
appearing only once the text pass has completed — exactly the ordering
the user asked for. Clicking a row's "Generate" enqueues it (never
generates inline) into a real client-side queue
(`queue`/`processingPath` state, one job in flight at a time — ComfyUI/
most local image providers have no business running two generations at
once, same reasoning `resource_broker.py` already documents elsewhere in
this app) that reuses the exact `POST /agent/poster/generate` call
`ImageFieldEditor`'s own Generate tab already makes. A still-queued (not
yet running) row can be bumped to the front ("Generate next" — the
requested "插队") or cancelled; the row list itself is the requested
"列表". A finished job's URL applies into that image field's live editing
state via `handleAiApplyImage` — which first reads the field's CURRENT
`alt` text via `lib/cte.ts`'s newly-exported `getByPath` before
overwriting, since `setByPath` replaces the whole value at a path and a
`ThemeImage` is `{url, alt}`, not a bare string; skipping that read would
have silently blanked every image's alt text on generation.

Deliberately scoped OUT of this round, a real narrowing decision, not an
oversight: per-field color/style generation ("还有CSS" from the user's
original ask). Letting the model independently pick a color per text
field risks a visually incoherent page (no shared palette reasoning
across fields) and doubles the response contract's complexity for a
first pass — `accent_color` and per-field `RichText` styling both still
work exactly as before, by hand, via CTE's existing style editors.

**Initial verification gap, then closed live**: this was built with no
Docker environment running. Once the user brought Docker up and reported
the trigger button wasn't visible, the actual cause was confirmed
directly rather than guessed: the button IS correctly gated on edit mode
(matches every other CTE editing affordance — `Editable`,
`ArrayItemToolbar`, `InsertGap` all work the same way), and the user
simply hadn't toggled the Switch on. Confirmed via the running backend's
own `/openapi.json` (`POST /api/agent/pages/ai-fill-content` registered)
and a clean `docker compose logs frontend` (no compile errors), with the
frontend container's own start timestamp checked against the files'
mtimes to rule out a stale-bundle explanation first.

### Real regression #1: the blanket `h-full` CSS fix

Once the button was reachable, the user ran it for real and reported the
underlying page still had a visible defect independent of AI-fill: a
`layout: "row"` container's two colored child panels (a short one-line
heading panel next to a taller paragraph panel) rendered visibly
different heights, even in plain preview (not just edit mode) — "白色短，
绿色长" in the user's own words, from a real screenshot.

Root-caused correctly on the first pass: `align: "stretch"` (this
schema's own default) already stretches each child's *invisible*
flex-item wrapper (`BlockRenderer`'s `WIDTH_CLASS`-sized div) to match
the row's tallest sibling — but the *visible* `ContainerBlock` div
rendered inside that wrapper (the one that actually paints
`background_color`) had no height of its own, so the colored box stayed
exactly as tall as its own content regardless. The "equal height"
behavior `align: stretch` implies never actually reached anything a
visitor could see.

**First fix**: add `h-full` unconditionally to `ContainerBlock`'s own
div. CSS-spec-correct (a stretched flex item's height counts as
"definite" for percentage-height resolution in descendants, so
`height: 100%` correctly resolves against it, and is a harmless no-op
everywhere else — a top-level section, a `column`/`grid` layout, a `row`
with non-`stretch` `align`) — and it did visibly equalize the two
colored panels.

**The user caught a real regression from it within one screenshot**:
this exact `ContainerBlock` component is ALSO used, elsewhere on the
SAME page, as a full-bleed `background_image` + `min_height: "lg"`
banner — a person-in-a-field photo filling a 28rem band, with two SHORT
colored text panels meant to overlay only its top portion, leaving most
of the photo visible below/around them. Confirmed by fetching the
actual saved page JSON (`GET /api/pages/home`) rather than continuing to
reason from screenshots alone — this settled it precisely as a
deliberate design, not an accident. `h-full` applied to those SAME two
panels too (they're the exact same component), and since the banner's
own resolved height was 28rem (from `min_height`, taller than either
panel's own content), both panels stretched to fill that entire 28rem —
completely covering the background photo. The user's own words: "h-full
改的方向错了...所以现在h-full就完全失去了原来设计的效果" (the h-full change is
the wrong direction... it completely lost the original design's
effect).

**Reverted**, not special-cased. Confirmed directly with the user
(`AskUserQuestion`) that there is no single CSS rule correct for every
container here — "should this container's children fill 100% of the
available height" is a genuine per-container design decision (yes for
two equal-height product cards; no for a short caption overlaying a tall
photo), never a bug with one universally-right answer. This is exactly
what motivated building "Ask AI to adjust this container's layout" as a
targeted, owner-triggered, per-container action instead of attempting a
second global rule.

### "Ask AI to adjust this container's layout"

Two scope questions put to the user directly (`AskUserQuestion`) after
the regression above; both times the user picked the more conservative
of the two options offered:

1. How should "AI understands and adjusts layout on its own" actually be
   wired in — folded into the whole-page AI-fill pass, or a separate,
   local, per-area action? **User: local area only, to start.**
2. How much structural freedom should the AI have when adjusting a
   layout — style knobs only, or full freedom to restructure children
   (including adding nested containers)? **User: style knobs only** —
   explicitly acknowledged in the question's own option description that
   this would NOT be able to fix the exact banner-panel-height case that
   motivated the feature (that needs a nested row), and the user chose
   it anyway, knowingly trading full coverage for lower risk.

Landed as a small block at the top of `CteEditorPopover`'s existing
`block-container` form (the SAME popover a container's pencil badge
already opens for manual editing) — an optional instruction `Textarea` +
"Suggest layout" button. `backend/apis/agent.py`'s new `POST
/agent/pages/ai-adjust-layout` takes this ONE container's current style
fields (`layout`/`gap`/`padding`/`margin`/`align`/`justify`/
`min_height`, plus whether it has a background image/color and its
`full_bleed` flag) and a one-level, NON-recursive summary of each direct
child (`frontend/src/lib/layout-adjust.ts`'s `summarizeChild` — kind +
up to ~100 chars of content, e.g. an image's alt text or a text block's
own content, never the child's full object) and asks
`resolve_chat_provider` for a complete new set of values for those same
fields (always all of them, even ones left unchanged — this sidesteps
any ambiguity between "the model didn't mention this field" and "the
model wants it unset," since `justify`/`min_height` are both naturally
nullable and an explicit `null` in the response is unambiguous). The
system prompt explicitly teaches the model the exact failure mode found
in the regression above (`"align": "stretch"` + a tall `min_height` +
`has_background_image: true` → children cover the photo entirely) and
instructs it to say so honestly in a required `reasoning` string when
the actual ask needs restructuring these fields can't express, rather
than picking a value that only looks like it helped.

The response applies straight into the SAME popover's existing draft
state (`setCLayout`/`setCGap`/`setCPadding`/`setCMargin`/`setCAlign`/
`setCJustify`/`setCMinHeight`) — since that state already live-applies
into the page via the popover's own pre-existing `onSave(computeValue())`
effect, this needed zero new apply-plumbing, just reusing setters that
already existed for manual editing.

`columns` was deliberately left out of what the AI can adjust — not
because it doesn't conceptually fit, but because `CteEditorPopover`'s own
manual form has never exposed `columns` as an editable field at all
(only meaningful for `layout: "grid"`); giving the AI control over a
field the manual UI doesn't manage would have been new plumbing outside
this feature's actual scope.

### Real bug #2: a `width` child overflowing its own row, edit-mode only

A third screenshot, correctly called out by the user as "依然没有修" (still
not fixed) — right after the height-equalization work above, since
neither of the first two fixes was actually this bug. This time,
diagnosed by reading the real page JSON and the actual flex CSS rather
than guessing again from the image, before writing anything.

The row (a full-bleed banner with two `width: "1/2"` colored children)
showed its GREEN child visibly spilling outside the row's own right edge
in edit mode — not in plain preview. Root cause: `block-renderer.tsx`'s
`WIDTH_CLASS` gave every fixed-ratio width (`"1/2"`, `"1/3"`, etc.) both
`shrink-0` AND `grow-0`. In plain preview, two `"1/2"` children sum to
exactly 100% of the row — nothing ever needs to shrink, so `shrink-0`
was a harmless no-op there. But `BlockRenderer` only ever renders
`InsertGap` "+"s as EXTRA flex items in that same row while `cte.active`
(edit mode) — one before the first child, one between, one after — each
also `shrink-0`. With the row's real total requested width now
50%+50%+(3 gaps' own width), genuinely over 100%, and EVERY item in that
row (including the gaps) refusing to shrink, the excess had nowhere to
go but overflow past the row's own box. This is the actual mechanism
behind the user's own much-earlier diagnosis, several messages back
("因为元素增多而撑出了父元素框" — because more elements got added, it pushed
outside the parent's frame) — correct as a description, just not yet
traced to its real cause until this pass.

Fixed by dropping `shrink-0` (keeping `grow-0`) from every fixed-ratio
`WIDTH_CLASS` entry. Safe for the published/preview case (there's never
anything to shrink there regardless of whether `shrink-0` is present);
in edit mode it lets the browser's normal flex algorithm proportionally
compress the real content slightly to make room for the insert-gap "+"s
instead of overflowing past the container — a small, temporary,
edit-only visual compression, never reflected in what's actually
saved/published.

### Real bug #3 and #4: two z-index ordering mistakes

A fourth screenshot — this one diagnosed correctly by the USER directly,
not from image-guessing: "z-index的问题，当'edit mode'的时候，hover会让block的
工具栏出现，然而这个出现会挡住'edit mode'这个switch，edit mode switch应该高于hover
的工具栏" (a z-index problem — in edit mode, hovering reveals a block's own
toolbar, and that toolbar covers the "Edit mode" switch; the switch
should outrank the hover toolbar).

Confirmed by reading the actual z-index values: `CteEditorPanel`'s
sticky "Edit mode" toolbar was `z-30`; a section's own hover-revealed
move/delete/edit toolbar (`cte-editor-panel.tsx`, the per-section
group) was `z-40` — deliberately raised above the sticky bar back on
2026-08-06, specifically so that badge wouldn't visually disappear UNDER
the sticky bar when the two happened to occupy the same screen position
(see that block's own doc comment from that date). Nobody had
reconsidered the reverse case: whenever that now-higher-z-index badge is
actually visible (on hover, most visibly for the very first section,
rendered right underneath the sticky bar), it now painted OVER the
sticky bar's own controls, including the Edit-mode `Switch` itself.

Fixed by raising the sticky bar to `z-[45]` — caught, before shipping,
that Tailwind's default z-index scale has no `z-45` utility at all (only
0/10/20/30/40/50/auto), so a bare `z-45` class would have been a silent
no-op leaving the bug fully unfixed; bracket/arbitrary syntax
(`z-[45]`) was needed. Placed above the section toolbar's `z-40` (and
`ArrayItemToolbar`'s `z-20`), still below `Sheet`'s own `z-50`
(shadcn/ui) so a field-editor popover keeps outranking everything in
this preview.

The user then flagged, proactively and correctly, that the SAME class of
bug likely also affected `SiteHeader` — it was ALSO `z-40`, an exact tie
with the section's hover toolbar. CSS resolves an exact z-index tie by
DOM order (the later-rendered element wins), and that toolbar renders
later in the tree than the header, so on a tie it could paint over the
global header too whenever the two visually coincided. Fixed by raising
`SiteHeader` to `z-50` — ties only with `Sheet`'s own `z-50` now, and
correctly loses that particular tie (`Sheet` is portalled near the end
of `<body>`, so it still wins and correctly covers the header while a
field-editor popover is open, the actually-wanted behavior for a
modal-style panel). Final z-index order for `/editor`: `Sheet` (50) ≈
`SiteHeader` (50, loses the DOM-order tie to `Sheet`) >
`CteEditorPanel`'s sticky toolbar (`z-[45]`) > section-level hover
toolbar (`z-40`) > `ArrayItemToolbar` (`z-20`).

### Real bug #5: `AiContentAssistant`'s own state getting wiped

Reported directly by the user, in plain language: after "AI fill
content" finished generating text and images successfully, closing the
Sheet to go look at the result, then reopening it, showed everything
gone — "这UX很差" (this UX is bad).

Root cause: `AiContentAssistant` was conditionally rendered on
`editModeOn` (`{editModeOn ? <AiContentAssistant .../> : null}` in
`cte-editor-panel.tsx`). Toggling edit mode OFF to preview the
just-generated result — the natural way to check it without leaving
`/editor` entirely — unmounted the whole component, silently discarding
every bit of its own React state: the image-generation queue, each
job's status/result, the text pass's `reasoning`. The applied page
CONTENT survived fine (that lives in the PARENT `CteEditorPanel`'s own
`sections` state, never touched by this), but the assistant's own
progress/history did not. This is the exact same class of mistake
`ChatBubbleWidget` already had to fix for its own open/closed toggle
(documented in its own catalog entry: "stays mounted while visually
'closed'... so ChatPanel's message history survives closing/
reopening") — just not applied here the first time around.

Fixed by always mounting `AiContentAssistant` regardless of
`editModeOn`, and passing a new `active` prop instead: the trigger
button only renders when `active`, and the Sheet's own visibility is a
derived `open={open && active}` rather than the underlying `open` state
itself. **A first attempt used a `useEffect` that called
`setOpen(false)` when `active` went false — `eslint`'s
`react-hooks/set-state-in-effect` rule correctly flagged this
immediately** ("Calling setState synchronously within an effect can
trigger cascading renders"), so it was replaced with the derived-value
approach instead, which needs no effect at all and cannot touch `open`
in a way that would lose state.

### Real bug #6: `update_settings`'s "only if changing" guard had a gap

Surfaced directly while the user was actually trying to fix their own
local model setup mid-session (their `custom` chat endpoint on port 8080
had gone briefly unreachable, then came back; their SEPARATE embedding
endpoint on port 8081 stayed down throughout). Every attempt to save
model settings — even ones that had nothing to do with embedding — 400'd
with `"Couldn't reach the custom embedding endpoint..."`.

`apis/model_settings.py`'s `update_settings` already had a documented
"only live-revalidates a capability that's actually changing" principle
(built 2026-08-18, see that date's own entry above) — but tracing the
actual code (not just the docstring) showed the guard only covered the
NON-`custom` branches (`elif chat_changed`/`elif vision_changed`/
`elif embedding_changed`, each checking a picked model against a live
Ollama/cloud list). The `if req.xxx_provider == "custom":` branches
(validating a picked model against THAT endpoint's own live model list)
had no such guard at all — `needs_custom_chatvision`/
`needs_custom_embedding` were computed purely from
`req.xxx_provider == "custom"`, with no "unless already saved and
unchanged" escape hatch. With chat/vision/embedding all configured as
`custom` (a real, common local setup — one llama.cpp endpoint for
chat+vision, a second for embedding), saving ANY settings change always
re-probed EVERY configured custom endpoint, and a single unreachable one
blocked the entire save — directly contradicting the user's own stated
requirement: "我希望是每一个组件都是独立的...除了llm必须要有，其他都是optional" (I want
every component independent... except the LLM/chat, which must be
present; everything else is optional).

Fixed by extending the exact same changed-guard already used for the
non-custom branches to the custom ones: `needs_custom_chatvision`/
`needs_custom_embedding` now additionally require `chat_changed`/
`vision_changed`/`embedding_changed` (comparing effective
provider+model against what's already saved) OR a newly-added
`custom_endpoint_changed`/`embedding_endpoint_changed` (comparing the
raw URL itself — added specifically to catch a URL-only change that
re-picks the identical model name, which the provider+model comparison
alone would have missed). The three membership-check blocks
(`if req.chat_model not in custom_model_ids: raise ...`) were similarly
gated so they only enforce when a live re-probe actually happened; an
unchanged `custom` pick is now trusted as-is.

**Verified live, against the real, still-partially-broken setup this was
found in — not just reasoned about**: logged in as `owner@example.com`,
fetched the real current settings (`GET /agent/settings`), PUT the
EXACT same JSON back while the embedding endpoint (port 8081) remained
genuinely unreachable — correctly returned `200` (would have 400'd
before this fix). Then, to confirm the fix didn't just remove validation
entirely, deliberately changed `embedding_model` to a bogus value under
the same broken endpoint — correctly still returned `400` with the
expected "Couldn't reach the custom embedding endpoint" message. `pytest`
(6 fast tests) also re-run clean after the change.

### Real bug #7: custom-endpoint vision detection missed a signal

The user asked directly: "qwen3.8是一个vision模型，为什么我们系统识别不出来" (Qwen3.8
is a vision model, why doesn't our system recognize it as one). Rather
than guess, fetched the actual raw `GET /v1/models` response from the
user's own `llama-server` (`http://host.docker.internal:8080/v1/models`)
and read it directly.

Found: this particular `llama-server` build responds with BOTH an
OpenAI-shaped `data` array (what `providers/custom.py`'s
`list_custom_models` was already reading, checking
`architecture.input_modalities` for `"image"`) AND an Ollama-shaped
`models` array in the exact same response. On this server, the `data`
array entries carried no `architecture` field at all (only a `meta`
block with vocab/context-size stats), so the existing check always fell
through to `vision: False` — but the `models` array explicitly reported
`"capabilities": ["completion", "multimodal"]` for the identical model,
a real, positive signal the code simply never looked at.

Fixed by also checking that second array, matched by id/name: a model
now counts as vision-capable if EITHER the OpenAI-shaped
`architecture.input_modalities` check OR the Ollama-shaped
`"multimodal"` capability says so; `vision` only defaults to `False` when
NEITHER signal is present at all (still conservative for a server like
vLLM/LM Studio that might report neither). **Verified live, twice**:
first a direct call to `providers.custom.list_custom_models(
'http://127.0.0.1:8080/v1', None)` inside the backend container, which
returned `[('...Qwen3.8-27B-Uncensored...', True)]`; then the real
public surface, `GET /agent/models`, whose `vision_models` list now
correctly shows that exact model with `vision: true, selectable: true`.

### Documentation pass

At the end of this session, on the user's own explicit "整理一下文档" (tidy
up the docs) request: the CTE section of `AGENTS.md` had grown, over the
course of this session's real back-and-forth debugging, into several
long sequential "here's another bug the user found" narrative blocks —
appropriate while actively fixing things in real time, but exactly the
kind of content the root `AGENTS.md`'s own stated policy says belongs
here in `HISTORY.md` instead ("put any bug story/verification narrative
worth preserving into HISTORY.md instead of bloating this file"). This
entire `HISTORY.md` section is that narrative, moved here in full;
`AGENTS.md`'s own CTE section was condensed back down to current-state
facts (what each feature does, its confirmed scope, and a one-line
pointer to this entry for any of the bug stories) as part of the same
pass.
