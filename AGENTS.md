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
        +------------------+------------------+
        |                  |                  |
+-------v------+   +-------v------+   +-------v-------+
| AI Providers |   |     RAG      |   | Agent console |
+-------+------+   +-------+------+   +-------+-------+
        |                  |                  |
  Ollama / OpenAI    pgvector DB +      deterministic
  Anthropic /           Documents      pipelines only —
    Gemini                              no LLM tool-
                                       calling/agent loop
                                        yet (CRM, ComfyUI
                                         poster gen, page
                                              gen)
```

REST only (no WebSocket — chat is a single non-streaming call today, see
Phase 3 below). "Agent console" is the deliberate name, not "AI Agent" —
see "Architecture decisions" below for why that distinction matters.

```
ai-employee/
├── ai-mvp-project-plan.pdf   the plan (source of truth for scope/rationale)
├── HISTORY.md                 full chronological development log — read on demand, not by default
├── docker-compose.yml        backend + frontend + postgres-db services
├── .env / .env.example       host/ports/ComfyUI config — see "Configuration" below
├── backend/                  FastAPI (Python) — see backend/main.py
│   ├── db.py                  SQLAlchemy engine/session (DATABASE_URL), Base, get_db dependency
│   ├── models.py               User / Page / PageVersion / Document / DocumentChunk / AppSettings / ChatSession / ChatMessage / CrmEntry ORM models
│   ├── auth.py                 password hashing (bcrypt) + JWT sign/verify (PyJWT)
│   ├── seed.py                 creates the 3 demo accounts — run manually after migrating
│   ├── ingest.py                RAG doc parsing (pdf/docx/md/txt) + chunking — pure functions, no I/O
│   ├── retrieval.py              RAG retrieval: embed -> pgvector search -> scored chunks (no router — called from apis/chat.py)
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
└── frontend/                 Next.js (TypeScript) — see frontend/AGENTS.md + frontend/HISTORY.md
    └── src/components/...    reusable component catalog lives there
```

All three services (`backend`, `frontend`, `postgres-db`) run via
`docker-compose up` — backend on :8000, frontend on :3000, Postgres+pgvector
on :5432. Both `backend/` and `frontend/` are bind-mounted with hot
reload; `frontend/node_modules` and `frontend/.next` are anonymous volumes
so the container's Linux-native `node_modules` isn't shadowed by the
host's Windows one (see `frontend/Dockerfile`).

**Git**: the project root has its own git repo (separate from
`frontend/`'s own nested repo, a `create-next-app` scaffolding artifact)
— a rollback needs `git reset --hard` in both places if ever needed, not
just one.

## Configuration: root `.env`

`HOST`, `BACKEND_PORT`, `FRONTEND_PORT`, `COMFYUI_HOST`, `COMFYUI_PORT`,
`COMFYUI_HOST_OUTPUT_DIR` — copy `.env.example` to `.env` and adjust for
your machine; `docker-compose.yml` composes these into the actual URLs/
port-mappings/bind-mounts via `${VAR}` substitution, which
`backend/apis/api.py` reads via `os.environ.get(...)` with defaults
matching what used to be hardcoded. Nothing here is fixed on purpose —
ComfyUI could be swapped for a different SD backend, host/ports differ
per machine — same "swappable, not hardcoded" principle as the AI
providers below.

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

**Agent execution must eventually be isolated from the API process —
principle only, not built.** Every real `apis/agent.py` capability today
is a **deterministic, non-agentic pipeline call** (no LLM tool-selection,
no agent loop) — none of them are the kind of real, arbitrary tool access
this principle is guarding against yet. The rule for *when* that changes:
any future handler that does grow into an actual agent loop calling
arbitrary tools must NOT run inside the same container/process as the
public-facing `backend` service — it belongs in a separate, narrowly-
scoped worker (own container, tight tool allowlist, no personal-account
access, action logging). This is Phase 6 (unstarted, see below) — build
the worker *before* implementing any handler that actually needs it.
Explicitly NOT to be wired to the user's personal openclaw instance
(`ws://127.0.0.1:18789`, broad personal-account access) — a future scoped
worker could reuse openclaw's runtime under a separate restricted
identity, but never the personal instance directly.

**AI provider is swappable — a deliberate second differentiator, not a
RAG implementation detail.** `backend/providers/`: `ChatProvider`/
`EmbeddingProvider` protocols (`providers/base.py`), real implementations
per vendor (`ollama.py`, `openai.py`, `anthropic.py`, `gemini.py`), one
selection point (`providers/registry.py`, env-var or per-request
override via the owner-facing model picker — see below). `backend/
retrieval.py` and `backend/apis/chat.py` are built against the protocols,
never against Ollama directly. **Only Ollama actually works today** —
OpenAI/Anthropic/Gemini are real API-call implementations, not stubs,
but raise a clean `ProviderNotConfigured` 503 until their API key env var
is set (none are, by design — no paid keys provided).
- `ChatProvider` swaps freely, per-call, no side effects on stored data.
- `EmbeddingProvider` does **not** swap freely once documents are
  ingested — different providers produce different vector dimensions
  (nomic-embed-text: 768, OpenAI: 1536, Gemini: 768), and pgvector can't
  compare vectors from different embedding spaces. `DocumentChunk.
  embedding` is a fixed `Vector(768)` for exactly this reason; switching
  `EMBEDDING_PROVIDER` after ingestion means re-embedding every chunk,
  not a config flip. No `AnthropicEmbeddingProvider` exists — Anthropic
  has no embeddings API, a vendor gap, not an oversight.
- **Owner-facing model picker** (`ModelSettingsPanel`, `/dashboard`):
  `GET /agent/models` lists what's actually usable (Ollama queried live
  via `ollama show`'s `capabilities`, cloud entries `selectable: false`
  until their key is set), `GET/PUT /agent/settings` persists the pick
  globally (`AppSettings` singleton row, id always 1) — applies to every
  visitor immediately, survives a restart. **Chat model selection is
  fully real across every configured provider.** **Vision model
  selection is Ollama-only in practice** — `generate_landing_page` sends
  an image straight to Ollama's chat endpoint; no provider here exposes a
  cloud image-input chat call yet, so cloud vision entries show in the
  UI (roadmap visibility) but are always non-selectable.

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
- **`generate_poster`** — deterministic ComfyUI txt2img + optional text
  overlay, composing `apis/api.py`'s existing functions directly (no
  self-HTTP round-trip).
- **`generate_geo_page`** — same schema-generation pipeline as
  `generate_landing_page`, but text input (concatenated RAG document
  content, not an image) via `resolve_chat_provider` — auto-saves to the
  fixed slug `"seo"`. A GEO (Generative Engine Optimization) company-
  profile page for AI/search systems to read, not a human landing page.
- **CRM entry capture** (`POST`/`GET /agent/crm/entries`) — stores a
  captured lead/inquiry in this project's own `CrmEntry` table (Postgres,
  not a third-party push — no CRM vendor account exists to integrate
  with; swapping in a real vendor call later doesn't change this shape).
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
(`Vector(768)`, fixed to match Ollama's nomic-embed-text — see the
provider note above). `DocumentManager` (frontend, `/dashboard`) is the
admin-facing upload/list/delete UI.

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
  abstracted, RAG-merged. **Not done**: streaming (SSE/WebSocket — single
  non-streaming call today); real LLM-driven intent recognition (the
  frontend's category→tags→channel→free-text flow is a **scripted local
  sequence**, not LLM-driven — it demonstrates the `{type, options}`
  structured-control contract, nothing more).
- **Phase 4 — CTE editor**: done, extensively. See "CTE" above.
- **Phase 5 — Visual polish**: page generation/schema done (see "Page
  schema" above). **Not done**: GSAP/ScrollTrigger (not started); Swiper
  carousel section (built, unused, no content feeds it, not CTE-
  editable).
- **Phase 6 — Agent security layer**: **not started at all**, beyond the
  isolation *principle* (see "Architecture decisions" above). No worker/
  container, no openclaw permission-boundary docs, no agent action
  logging, no red-team pass. This is the largest remaining piece of the
  original plan.
- **Backend, independent of phases**: Dockerized services, ComfyUI
  wrapper (`apis/api.py`), RBAC framework — all done. `apis/agent.py` is
  now fully real (see "Agent console capabilities" above). Not done:
  online-AI fallback for chat (falls back to nothing today if the
  configured provider is unavailable, just a clean error).

## Known gotchas worth remembering

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

## Suggested next step

Out of scope by explicit decision — don't suggest: real Firebase Auth or
an actual cloud/EC2 deploy (Phase 1's scope decision).

**2026-08-06, end of a long session**: the user paused CTE feature work
("MVP应该够用够展示了" — good enough to demo) and picked up the CRM/report
work instead (now done, see "Agent console capabilities" above). A CTE
`width`/`height` editing proposal was discussed and deliberately shelved
mid-conversation — not rejected, a ready-to-pick-up candidate (expose the
existing `BlockWidth` enum on all 4 block types + `ContainerBlock.
min_height`, both already-existing fields with no CTE editor UI yet).

Reasonable candidates, roughly by how directly they'd increase
demo-readiness vs. add new scope:
- **A real in-browser click-through of everything built in CTE parts
  1-13 and the CRM/report panels** — the single biggest verification
  gap. No working Chrome extension connection existed this whole
  session; everything was verified via `tsc`/`eslint`/curl/backend
  checks plus the user's own screenshots.
- A `/dashboard` viewer for the chat sessions/messages already being
  persisted (session list + per-session transcript) — deliberately
  deferred out of the persistence work to keep that change small.
- Whether qwen3.6 can reliably generate the Container/Block schema's
  deeper nesting patterns from a real design image — tested a few
  rounds, still genuinely open; everything CTE now supports editing at
  the nested-container level was hand-authored via curl, never generated
  by the model on its own.
- Phase 6 (agent security layer) — entirely unstarted, the largest
  remaining piece of the original plan, and the one most different in
  kind from the CTE/generation work this session focused on.
- Smaller unstarted items: chat streaming, real LLM-driven intent
  recognition, GSAP/ScrollTrigger, Swiper carousel content.

Ask the user which, if anything, to pick back up.
