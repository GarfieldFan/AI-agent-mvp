# AI Employee — frontend

Next.js 16 (App Router) + TypeScript frontend for the AI Employee project
— see the [root README](../README.md) for what this project is and why.

This is one piece of a multi-service Docker Compose stack, not meant to
be run standalone in a normal workflow — from the project root:

```bash
docker compose up
```

Frontend runs on `http://localhost:3000` with hot reload against the
bind-mounted `src/`.

If you do need to run it outside Docker (e.g. for a quick isolated check):

```bash
npm install
npm run dev
```

You'll need `NEXT_PUBLIC_API_URL` pointing at a running backend (see the
root `.env.example`) — most of this app's real functionality depends on
the FastAPI backend + Postgres, which this alone won't give you.

## Documentation

- **`AGENTS.md`** — current-state component/lib catalog: what exists
  under `src/components/` and `src/lib/`, one line each, organized by
  directory. Check here before building something new.
- **`HISTORY.md`** — the full development log behind every entry in
  `AGENTS.md`: redesign rationale, bug root-causes, verification detail.
  Read on demand (grep for a component name), not top-to-bottom.

## Stack notes

- Next.js **16** with React 19 — meaningfully different from most
  training-data-era Next.js knowledge; see `AGENTS.md`'s gotchas section.
- shadcn/ui, `base-nova` style (`@base-ui/react`, not Radix).
- Tailwind CSS.
- `recharts` for the one chart in the admin console.
