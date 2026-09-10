# AI Employee — AI-native small-business site MVP

A small business website that ships with its own AI employee. A public
visitor gets a RAG-grounded chatbot that can capture leads or file a
structured request from a conversation (with file attachments), browse
and order from a real product catalog, and manage their own
cart/checkout — no separate contact form or storefront UI needed. An
admin/owner gets a design-to-page generator, a poster generator, a
click-to-edit page builder, a CRM with owner-defined structured intake
forms and agent-generated review queues, chat-volume reporting, and a
natural-language **owner agent** that can actually call tools on the
owner's behalf — all gated behind real role-based access control.

This started as a local-first demo (`docker compose up`) and now also
ships real deployment automation for a single real server (see
`deploy/`). The interesting parts are architectural: every AI capability
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
  conversation looks like a real appointment/quote/claim request — or,
  for a request the owner has defined a custom intake form for (an
  insurance claim, a project inquiry, ...), collects exactly those
  fields conversationally across multiple turns without re-asking for
  anything already given.
- **Product catalog + ordering** — a visitor can browse, ask the chatbot
  what's available, add to cart, and check out (real Stripe payment, or a
  zero-config test mode — see below) entirely through chat or the
  storefront pages (`/search`, `/products/[id]`, `/cart`, `/checkout`).
  Product search/cart resolution is deterministic SQL, not
  an LLM guessing a product ID out of a prompt-stuffed catalog. Supports
  per-line customization notes and a dine-in "kitchen ticket" workflow
  (staff mark a line served; a served line locks against further changes
  from the customer's own cart).
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
- **CRM + review queues + chat-volume reporting** — captured leads
  (category/status, contact info, attached files, owner-triggered
  deep-scan notes), owner-defined structured intake forms for anything
  beyond the built-in categories, agent-generated review queues to
  triage them, and a chart of chat sessions/messages over time — all
  backed by data this project actually persists and paginates.
- **Owner agent** (owner-role only) — type a natural-language command
  ("generate a poster of X and log it as a CRM entry"), and a real LLM
  tool-calling loop decides which of a fixed tool allowlist to call, in
  what order, chaining results turn-to-turn. Every step (tool, args,
  result) is shown, not just the final answer. A higher-stakes change
  (a new intake schema, a batch of catalog products) is always drafted
  for the owner to review and explicitly apply, never written directly.
- **Payments, notifications, maps, and GEO/SEO** — a swappable payment
  gate (Stripe embedded checkout or a zero-config test mode), an
  email/SMS gate (Mailgun/Twilio or test mode), a map-embed gate (Google
  Maps or a plain redirect link), and a structured business-profile +
  JSON-LD/`robots.txt`/`sitemap.xml`/`llms.txt` pass aimed at both search
  engines and AI systems reading on a visitor's behalf.
- **Accounts** — password login plus optional Google/Facebook/X OAuth for
  the public `user` tier (admin/owner stay password-only, a deliberate
  trust-boundary decision), a self-service "my account" view, and
  owner-facing user/role management.
- **Bot verification + prompt-injection defense** — Cloudflare Turnstile
  gating the fully-public write endpoints (never a page view, so it can't
  affect SEO/GEO), and a fixed instruction layer the chatbot's system
  prompt can't be talked out of, backed by deterministic guardrails on
  what a classification call is allowed to write to the database
  regardless of what it returns.

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
  tool. Its only I/O is a fixed tool allowlist of HTTP calls onto the
  main backend's own REST API, forwarding the caller's real bearer token
  on every call so the backend's own RBAC independently re-authorizes
  every action — a compromised or misbehaving agent loop still can't do
  anything the calling owner couldn't already do directly.
- **AI-generated page content is always a typed schema, never HTML.** A
  vision LLM can only choose from and fill in a fixed set of section/
  block types; it can't inject arbitrary markup or drift from the site's
  design system.
- **The agent proposes, the owner applies — for anything a mistake would
  actually cost.** `owner-agent` can draft a new intake schema or a
  batch of catalog products, but never writes either directly; a review
  queue's status labels, by contrast, apply immediately, since adjusting
  them later is cheap. The line between "propose" and "apply-directly"
  tracks real reversibility, not a blanket policy.
- **Deterministic code decides what an LLM shouldn't have to.** Product
  search/cart resolution, review-queue/CRM filtering and pagination, and
  order totals are all plain SQL/Python — an LLM only ever extracts
  intent from free text, never computes a total or picks a database row
  out of a catalog stuffed into its own prompt.

## Tech stack

- **Backend**: FastAPI (Python), SQLAlchemy + Alembic, Postgres with
  `pgvector` for RAG, real JWT auth (bcrypt + PyJWT, no third-party
  identity provider).
- **Frontend**: Next.js 16 (App Router) + TypeScript, Tailwind, shadcn/ui
  (`base-nova`/Base UI), recharts.
- **`owner-agent`**: a separate FastAPI service — the isolated LLM
  tool-calling worker described above.
- **Infra**: fully Dockerized (`docker-compose.yml`) — backend, frontend,
  owner-agent, Postgres/pgvector, and a bundled Ollama each in their own
  container, hot-reloading in dev. Real deployment automation for a
  single server (with an optional domain + automatic HTTPS) lives in
  `deploy/`.
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
- Chat/vision/embedding generation each need a real model connected —
  the bundled `ollama` container works out of the box (use `/setup` or
  the Dashboard's Model settings to pull a model into it), or point the
  owner-facing model picker at your own self-hosted OpenAI-compatible
  server (llama.cpp, vLLM, ...) or a cloud provider (OpenAI, Anthropic,
  Gemini) with a real API key.

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
judgment, not a finished product. Known, deliberate gaps: no
multi-tenancy (one deployment is one business, not a hosted SaaS serving
many owners), chat is a single non-streaming call by design (a
visibility-gated short-polling loop stands in for push updates on the
admin dashboard instead of a websocket, given the single-worker
deployment), payment is Stripe-or-test-mode only (no other processor),
and no in-browser click-through testing has been done (every change is
verified via type-checking, linting, automated tests, and direct backend
calls instead — see `AGENTS.md`). A broad red-team + stress-test pass has
been run against the public API surface (RBAC, IDOR, JWT tampering,
file-upload/path-traversal abuse, prompt injection, rate limiting, DB
connection-pool exhaustion under load — see `AGENTS.md`'s "Rate
limiting" section for the one real finding and its fix), but
`owner-agent`'s own tool-calling loop hasn't had a dedicated adversarial
pass of its own yet.
