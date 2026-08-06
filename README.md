# AI Employee — AI-native small-business site MVP

A resume/portfolio project: a small business website that ships with its
own AI employee. A public visitor gets a RAG-grounded chatbot; an
admin/owner gets a design-to-page generator, a poster generator, a
click-to-edit page builder, a CRM lead log, and a chat-volume report —
all gated behind real role-based access control.

This is a local-first demo (`docker compose up`), not a deployed
product. The interesting parts are architectural: an AI-vendor
abstraction that isn't just a config flag, and a privilege boundary
designed so the public-facing AI surface can never reach a privileged
action, even under prompt injection.

## Demo

[![Watch the walkthrough on YouTube](https://img.youtube.com/vi/dWj7zUT_sXU/maxresdefault.jpg)](https://youtu.be/dWj7zUT_sXU)

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

REST only — chat is a single non-streaming call today. "Agent console"
is the deliberate name, not "AI agent": every capability behind it
(CRM, ComfyUI poster generation, page generation) is a deterministic
pipeline call today, not an LLM tool-calling loop — see "Why it's
architecturally interesting" below.

## What it does

- **Public chatbot** (`/chat`) — general conversation, grounded in
  whatever documents an admin has uploaded (RAG over pgvector), with
  visible source citations when it draws on a real document.
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
- **Poster generator** — prompt → image (ComfyUI) → optional text
  overlay, in one pipeline call.
- **CRM lead capture + chat-volume reporting** — a real (if minimal)
  internal CRM record store, and a chart of chat sessions/messages over
  time, both backed by data this project actually persists.

## Why it's architecturally interesting

- **The AI vendor is swappable, not hardcoded.** Chat and embedding
  generation sit behind a provider interface (`backend/providers/`) with
  real implementations for Ollama, OpenAI, Anthropic, and Gemini —
  picking a different vendor is a config change, not a rewrite. (Only
  Ollama is actually configured in this demo; the others are real code
  gated behind an unset API key, not stubs.)
- **The privileged "agent console" is a separate trust boundary from the
  public chatbot**, not a role check bolted onto one endpoint. The
  public chat path has no tool access at all; every admin-only capability
  is a deterministic pipeline call, gated by RBAC, with a documented
  principle for isolating any *future* capability that does grow into
  real agentic tool use into its own sandboxed worker — before it's
  built, not after.
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
- **Infra**: fully Dockerized (`docker-compose.yml`) — backend, frontend,
  and Postgres/pgvector each in their own container, hot-reloading in
  dev.
- **Image generation**: ComfyUI, wrapped by a small backend API.

## Running it locally

```bash
cp .env.example .env        # adjust HOST/ports/ComfyUI path for your machine
docker compose up
```

- Frontend: `http://localhost:3000`
- Backend docs: `http://localhost:8000/docs`
- Three seeded demo accounts (password `0000` for all, shown on `/login`):
  `owner@example.com`, `admin@example.com`, `user@example.com`.
- Chat/vision generation need a local Ollama instance reachable from the
  containers (see `AGENTS.md`'s known-gotchas section — Ollama must bind
  to all interfaces, not just loopback).

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
LLM-driven, and the "agent execution isolation" principle above is
designed but not yet built (nothing in the project today actually needs
it — see `AGENTS.md`).
