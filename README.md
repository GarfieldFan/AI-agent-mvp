# AI Employee — AI-native small-business site MVP

A resume/portfolio project: a small business website that ships with its
own AI employee. A public visitor gets a RAG-grounded chatbot that can
capture leads from a conversation (with file attachments); an
admin/owner gets a design-to-page generator, a poster generator, a
click-to-edit page builder, a CRM, chat-volume reporting, and a
natural-language **owner agent** that can actually call tools on the
owner's behalf — all gated behind real role-based access control.

This is a local-first demo (`docker compose up`), not a deployed
product. The interesting parts are architectural: every AI capability
(chat, vision, embeddings, image generation) sits behind a swappable
provider abstraction, not a config flag bolted onto one vendor; and the
one component that does get real LLM tool-calling access runs as a
separate, isolated service with its own auth check and a fixed tool
allowlist — not bolted into the same process as the public-facing API.

## Demo

https://github.com/user-attachments/assets/592c82f9-5d35-4fb9-a723-8e9b2595b4d5

## Architecture

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
  Ollama / custom     pgvector DB +      deterministic         isolated LLM
  llama.cpp / OpenAI /   Documents      pipelines only —      tool-calling
  Anthropic / Gemini                    no LLM tool-           loop, own
                                        selection here        container/port,
                                                              owner-only, calls
                                                              agent console's
                                                               REST endpoints
```

REST only — chat is a single non-streaming call today. "Agent console"
is a deliberately different thing from `owner-agent`: every capability
behind the console (CRM, ComfyUI poster generation, page generation) is
a deterministic pipeline call, never an LLM choosing which tool to run.
`owner-agent` is the one place in this project an LLM actually picks
from a tool allowlist — and it's a genuinely separate service (own
container, own port), not another router bolted onto the public
`backend` — see "Why it's architecturally interesting" below.

## What it does

- **Public chatbot** (`/chat`) — general conversation, grounded in
  whatever documents an admin has uploaded (RAG over pgvector), with
  visible source citations when it draws on a real document. Can accept
  a file attachment (photo/PDF) mid-conversation, auto-analyzes it, and
  captures a structured CRM lead (category, contact info) when the
  conversation looks like a real appointment/quote/claim request.
- **Design → landing page** — upload a screenshot of a design, a vision
  LLM turns it into a real page built from a typed JSON section schema
  (never raw HTML), rendered through the site's own React components.
- **Click-to-edit page builder** (`/editor`) — click any piece of a
  published page to edit its content and style in place; move, delete,
  and insert sections, list items, and nested layout blocks directly in
  the live preview.
- **GEO/SEO profile page** — a company-profile page auto-generated from
  the same ingested documents, aimed at search engines and AI systems
  reading on a visitor's behalf, not at humans.
- **Poster generator** — prompt → image → optional text overlay.
  ComfyUI by default (with an owner-configurable checkpoint, or an
  entirely custom pasted ComfyUI workflow for a different SD setup), or
  a cloud provider (DALL·E, Imagen) instead.
- **CRM + chat-volume reporting** — captured leads (category/status,
  contact info, attached files, owner-triggered deep-scan notes) and a
  chart of chat sessions/messages over time, both backed by data this
  project actually persists.
- **Owner agent** (owner-role only) — type a natural-language command
  ("generate a poster of X and log it as a CRM entry"), and a real LLM
  tool-calling loop decides which of a fixed 8-tool allowlist to call,
  in what order, chaining results turn-to-turn. Every step (tool, args,
  result) is shown, not just the final answer.

## Why it's architecturally interesting

- **Every AI capability is swappable, not hardcoded to one vendor.**
  Chat, vision, embeddings, and image generation each sit behind their
  own provider interface (`backend/providers/`), with real
  implementations for Ollama, any self-hosted OpenAI-compatible endpoint
  (llama.cpp, vLLM, ...), OpenAI, Anthropic, and Gemini (ComfyUI/DALL·E/
  Imagen for images) — picking a different vendor per capability is an
  owner-facing dashboard setting, not a rewrite. Switching the embedding
  provider safely invalidates and re-embeds the vector store rather than
  silently mixing incompatible vector spaces.
- **The privileged "agent console" is a separate trust boundary from the
  public chatbot**, not a role check bolted onto one endpoint. The
  public chat path has no tool access at all; every admin-only console
  capability is a deterministic pipeline call, gated by RBAC.
- **The one real LLM tool-calling loop is isolated by construction, not
  by policy.** `owner-agent` is its own service — own container, own
  port, its own independent JWT check requiring the `owner` role
  specifically (stricter than the console's admin-or-owner gate), no
  database connection, no filesystem access, no arbitrary-URL fetch
  tool. Its only I/O is a fixed 8-tool allowlist of HTTP calls onto the
  main backend's own REST API, forwarding the caller's real bearer token
  on every call so the backend's own RBAC independently re-authorizes
  every action — a compromised or misbehaving agent loop still can't do
  anything the calling owner couldn't already do directly.
- **AI-generated page content is always a typed schema, never HTML.** A
  vision LLM can only choose from and fill in a fixed set of section/
  block types; it can't inject arbitrary markup or drift from the site's
  design system.

## Tech stack

- **Backend**: FastAPI (Python), SQLAlchemy + Alembic, Postgres with
  `pgvector` for RAG, real JWT auth (bcrypt + PyJWT, no third-party
  identity provider).
- **Frontend**: Next.js 16 (App Router) + TypeScript, Tailwind, shadcn/ui
  (`base-nova`/Base UI), recharts.
- **`owner-agent`**: a separate FastAPI service — the isolated LLM
  tool-calling worker described above.
- **Infra**: fully Dockerized (`docker-compose.yml`) — backend, frontend,
  owner-agent, and Postgres/pgvector each in their own container,
  hot-reloading in dev.
- **Image generation**: ComfyUI by default, wrapped by a small backend
  API; OpenAI/Gemini available as alternatives.

## Running it locally

```bash
cp .env.example .env        # adjust HOST/ports/ComfyUI path for your machine
docker compose up
```

- Frontend: `http://localhost:3000`
- Backend docs: `http://localhost:8000/docs`
- Three seeded demo accounts (password `0000` for all, shown on `/login`):
  `owner@example.com`, `admin@example.com`, `user@example.com`.
- Chat/vision/embedding generation each need a real backend reachable
  from the containers — a local Ollama instance (see `AGENTS.md`'s
  known-gotchas section: Ollama must bind to all interfaces, not just
  loopback) or a self-hosted OpenAI-compatible server (llama.cpp, vLLM,
  ...) configured via the owner-facing model picker.

## Documentation

This repo keeps two tiers of documentation, both written for whoever
(human or AI) picks this project up next:

- **`AGENTS.md`** — a short, current-state architecture/decisions
  reference. Read this first.
- **`HISTORY.md`** — the full development log: every bug found, every
  design decision debated, with the real reasoning and verification
  behind it. Read on demand, not top-to-bottom.

`frontend/` has its own matching pair (`frontend/AGENTS.md` /
`frontend/HISTORY.md`) for the component/lib catalog.

## Scope notes

This is explicitly an MVP built to demonstrate specific engineering
judgment, not a finished product. Known, deliberate gaps: no real cloud
deployment (local Docker only, by design), chat is a single non-streaming
call, the chatbot's step-by-step intake flow is scripted rather than
LLM-driven, `owner-agent` hasn't been through a red-team pass and its
action log is a local JSONL file rather than a queryable store, and no
in-browser click-through testing has been done (every change is verified
via type-checking, linting, and direct backend calls instead — see
`AGENTS.md`).
