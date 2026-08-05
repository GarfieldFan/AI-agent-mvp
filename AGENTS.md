<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reusable component catalog

Check here before building a new component — most cross-page needs
(loading/empty/error states, layout chrome, RBAC role display, RAG source
citations) already have one. Keep this catalog in sync when you add,
rename, or change the API of anything under `src/components/`.

Import alias: `@/components/...` (see `components.json` / `tsconfig.json`).

## `src/components/ui/` — shadcn/ui primitives

Generated via `npx shadcn@latest add <name>`, style `base-nova`
(`@base-ui/react` under the hood, **not Radix** — see the gotcha below).
Standard shadcn API/props unless noted. Installed: `avatar`, `badge`,
`button`, `card`, `dropdown-menu`, `input`, `label`, `scroll-area`,
`select`, `separator`, `sheet`, `skeleton`, `sonner` (toaster), `switch`
(added 2026-08-05 for CTE's edit-mode toggle, see below), `tabs`,
`textarea`, `tooltip`. Add more with the same command rather than
hand-rolling — check here first if you think one's missing, it might just
not be listed yet.

**base-ui gotcha**: composition uses a `render` prop, not `asChild`:
`<Button render={<Link href="/x" />}>Text</Button>`. See `select.tsx` /
`sheet.tsx` / `tooltip.tsx` for more `render` usage examples.

**base-ui gotcha 2**: `Button` defaults to `nativeButton={true}`, which
assumes the element it renders as is a real `<button>`. When `render`
points at something else — `<Link>`, a plain `<a>` — it renders an
`<a>` instead and Base UI logs a dev-only warning ("expected a native
`<button>`... impacts forms and accessibility") because `<a>` doesn't get
button semantics (Space-to-activate, form submission, etc.) for free. Pass
`nativeButton={false}` whenever `render` isn't a `<button>`:
`<Button nativeButton={false} render={<Link href="/x" />}>Text</Button>`.

## `src/components/layout/` — page chrome

| Component | Purpose |
|---|---|
| `SiteHeader` | Sticky top nav: logo, desktop nav links (from `src/config/nav.ts`), `ModeToggle`, `MobileNav` trigger. Rendered once in `src/app/layout.tsx`. |
| `SiteFooter` | Footer sitemap (same nav config) + tagline. Rendered once in root layout. |
| `MobileNav` | Client component; `Sheet`-based nav drawer for small screens, reuses `NavLink`. |
| `NavLink` | Client component; single nav link that highlights itself via `usePathname()`. Takes plain `href`/`title` strings, **not** a whole `NavItem` — a `NavItem.icon` is a function and can't cross the Server→Client prop boundary (see the root `AGENTS.md` gotcha). |
| `Container` | `mx-auto max-w-6xl px-4…` wrapper — use for any section's horizontal rhythm instead of repeating the classes. |
| `PageHeader` | Title + description + optional right-aligned actions slot, used at the top of every module page. |

Nav items themselves are defined once in `src/config/nav.ts` (`primaryNav:
NavItem[]`) — edit there to add/remove/reorder a route in both the header
and footer at once.

## `src/components/common/` — cross-module UI

| Component | Purpose |
|---|---|
| `LoadingSpinner` | Inline `Loader2` spin + label. Drop into a button/card/section while an `apiFetch` call is in flight. |
| `EmptyState` | "Nothing here yet" card (icon + title + description + optional action). Also doubles as an RBAC-locked-out state (`CteEditorPanel`, `AgentConsoleSection`) and a "nothing saved to this slug yet" state (`CteEditorPanel`) — `/editor` used to be its "not built yet" placeholder too, before the real CTE editor landed 2026-08-04, see below. |
| `ErrorMessage` | Failed-request card with an optional `onRetry` callback. Pairs with `ApiError` from `src/lib/api.ts`. |
| `RoleBadge` | Renders an RBAC `Role` (`owner`/`admin`/`user`) as a colored `Badge`. **Display only** — the backend re-checks the role on every request regardless of what this shows. |
| `SourceCitationList` | Renders `RagSource[]` as hoverable citation chips (`[1] filename.pdf` + excerpt tooltip) — the "answers are traceable" UI, rendered inline under RAG-grounded chat replies in `ChatMessageBubble` (see `chat/` below; used to back a standalone `/knowledge` page, merged into `/chat` 2026-08-04). |
| `ModuleCard` | Landing-page grid tile: icon + title + description + optional "Planned" badge, links to the module route. |
| `AuthStatus` | Header widget (replaced `DevRoleSwitcher`, 2026-08-04): "Log in" link when logged out; email + `RoleBadge` + logout button when logged in. Reads `lib/auth.ts`'s `useAuth()` — display only, same caveat as `RoleBadge`. |
| `FileDropzone` | Drag-and-drop file picker with click-to-browse fallback, image preview via a local blob URL. First built to replace `PageGeneratorPanel`'s plain `<input type="file">` (fiddly to use); generic enough to reuse for any other file upload (poster generation, document ingest, ...). `previewUrl` is derived from `file` via `useMemo`, not its own `useState`+`useEffect` pair — that was the original shape and it tripped the `react-hooks/set-state-in-effect` rule; the effect now only ever handles the `URL.revokeObjectURL` cleanup, never a `setState` call. |

## `src/components/modules/` — feature-specific, not generic

These are built for one module each and aren't meant to be reused
elsewhere, but are worth knowing about before extending that module:

- `model-settings-panel.tsx` — `/dashboard`'s AI model picker card
  (admin/owner only, rendered above `DocumentManager`). Two independent
  `Select` dropdowns (chat model, vision model) built from
  `lib/models.ts`'s `listModels()` (Ollama options queried live with real
  capabilities; cloud provider options shown but `selectable: false`
  until configured/implemented — see that file's doc comment) +
  `getModelSettings()` (current pick). Each `SelectItem` shows an `Eye`
  icon when the model has vision capability and a "Not configured" badge
  when it isn't currently usable; disabled options stay visible (not
  hidden) so the roadmap — what cloud vision support would look like once
  it exists — stays visible rather than disappearing. Saving
  (`updateModelSettings`) is global and immediate: it changes what every
  visitor's `/chat` message and every future `generate_landing_page` call
  uses, not just this admin session.
- `document-manager.tsx` — `/dashboard`'s document-management card
  (admin/owner only, rendered above `PageGeneratorPanel` in
  `agent-console-section.tsx`). `FileDropzone` upload → base64 →
  `lib/documents.ts`'s `ingestDocument`; lists existing documents
  (`GET /api/agent/documents`) with a status `Badge` (`pending` outline /
  `processing` secondary / `ready` default / `error` destructive,
  `error_message` shown when present) and a per-row delete button. This
  is the FE half of the RAG pipeline described in the root `AGENTS.md`'s
  provider-swap section — upload here, ask at `/chat` (no more standalone
  `/knowledge` page, merged 2026-08-04).
- `chat/chat-panel.tsx` — `/chat` page's message list + composer. Drives a
  **scripted** local conversation (see the `TODO(Phase 3)` comment) that
  demonstrates the full radio → checkbox → select → free-text flow before
  a real backend exists. Once that flow completes, free-text turns go to
  the real `POST /api/chat` (`lib/chat.ts`'s `sendChatMessage`), which is
  RAG-grounded as of 2026-08-04 — a reply can carry `sources`, rendered by
  `ChatMessageBubble` via `SourceCitationList` (see above). `sources` is
  `[]` for a plain conversational reply, not just when nothing's been
  uploaded — retrieval always runs server-side, irrelevant matches are
  dropped before they reach the frontend.
- `chat/chat-message-bubble.tsx` — one message bubble; renders a
  `ChatControlRenderer` under assistant messages that carry a `control`.
- `chat/chat-control-renderer.tsx` — turns a `ChatControl` (`{ type: "text"
  | "radio" | "checkbox" | "select", options? }`) into the matching
  interactive widget and calls `onSubmit(value)` when the user responds.
  This is the piece that makes the backend's structured JSON responses
  drive the UI, per the project plan's chatbot module spec.
- `login-form.tsx` — the real login form (`/login` route): email +
  password, `POST /api/auth/login`, stores the result via `lib/auth.ts`'s
  `setAuth()` and redirects to `/dashboard`. Also displays the three
  seeded demo accounts (see root `AGENTS.md` — password `0000` for
  all three) so anyone running the demo can log in immediately.
- `agent-console-section.tsx` — `/dashboard`'s role-gated capability grid.
  Reads `useAuth()`; `user` (including anyone not logged in) sees a locked
  `EmptyState`, `admin`/`owner` see cards mirroring `backend/apis/agent.py`'s
  remaining stub routes (CRM/report only now — poster joined
  generate_landing_page/document-ingest as real, see below), each with a
  "Try it" button (small sample payload) so you can see the RBAC gate
  itself — 403 as `user`, 501 as `admin`/`owner`. Renders
  `ModelSettingsPanel`, `DocumentManager`, `PosterGeneratorPanel`, then
  `PageGeneratorPanel` below the grid, in that order — anything needing
  real input (a document, a prompt, an image) got pulled out of the
  generic sample-payload card grid rather than leaving a "Try it" that
  burns real time/GPU on garbage data.
- `poster-generator-panel.tsx` — the real UI for `generate_poster`
  (2026-08-04): a prompt textarea + optional overlay-text input +
  "Generate" button, calling `lib/poster.ts`'s `generatePoster`. Checks
  `lib/integrations.ts`'s `getIntegrations()` once on mount and disables
  "Generate" with an explanation if ComfyUI isn't reachable — this is
  where the "gray out + explain" plumbing originally built for the poster
  *stub* card (see `lib/integrations.ts` below) ended up living once the
  stub became real and got pulled out of the generic grid; nothing else
  in that grid needs it, so it didn't stay there. Renders the resulting
  image via a plain `<img>` once generation finishes (budget up to a few
  minutes — same order of magnitude as `generate_landing_page`).
- `page-generator-panel.tsx` — the real upload UI for
  `generate_landing_page`: `FileDropzone` (design image) + optional notes +
  "Generate" button, calls the endpoint via `apiFetch`, and renders the
  result live through `SectionRenderer` in a "Preview (not published)"
  box. This is where you actually test the vision pipeline end-to-end —
  see the root `AGENTS.md` for how to reach it (log in as admin/owner →
  `/dashboard`). Also renders `SavePageForm` (defined in the same file)
  once a result exists — slug input (autocompletes existing slugs via a
  `<datalist>`) + optional note + Save, calling `lib/pages.ts`'s
  `savePageVersion`. Saving to slug `"home"` publishes to `/`; anything
  else publishes to `/p/[slug]` — see `lib/pages.ts` and the root
  `AGENTS.md`'s page-storage section for the full picture (this is no
  longer preview-only, as of 2026-08-04).
- `page-manager.tsx` — companion to the save form: lists every saved page
  (`GET /api/agent/pages`), expands to a version history per page, and a
  one-click Restore per historical version (copies that version's content
  into a *new* version on top — never destroys history). Also has a
  **Delete** button per page (added 2026-08-05, `deletePage` in
  `lib/pages.ts` → `DELETE /agent/pages/{slug}`) — unlike everything else
  in this component, deleting a page removes every version with no undo,
  gated behind a native `window.confirm()` rather than a full dialog
  component (this is the only destructive action in this admin tool, not
  worth a new UI pattern for). Rendered alongside `PageGeneratorPanel` in
  `agent-console-section.tsx`.
- `cte-editor-panel.tsx` — the real `/editor` UI (2026-08-04, replaced the
  GrapesJS-shaped placeholder — see the root `AGENTS.md`'s Phase 4 entry
  for why GrapesJS itself was dropped in favor of a lightweight,
  schema-native editor). Admin/owner-gated like `AgentConsoleSection`;
  loads an *existing* slug (`getPublicPage`) — no blank-page authoring
  path, generation is still `PageGeneratorPanel`'s job — then renders it
  through the same `SectionRenderer` every public route uses, wrapped in a
  `CteProvider` (`components/theme/cte/`, see below). An **"Edit mode"
  `Switch`** (added 2026-08-05, off by default) drives `CteProvider`'s
  `active` prop directly — a freshly-loaded page looks exactly like the
  live site until you flip it on, which is also what makes the click-to-
  edit badges discoverable without relying on hover (see `Editable`'s doc
  comment for why hover was dropped). A badge click opens
  `CteEditorPopover` (now a `Sheet`, not a positioned popover — see
  below); saving a field patches local `sections` state via `lib/cte.ts`'s
  `setByPath` and marks the page dirty; "Save as new version" calls the
  same `savePageVersion` the save form above does — CTE edits are just
  another page version, no backend changes were needed for the editing
  mechanism itself (the image editor's Upload/Generate/Library tabs are a
  separate story — see `ImageFieldEditor` below).

## `src/components/theme/` — LLM-generated page rendering

Renders a `PageSection[]` (see `lib/theme.ts`) — the output shape for both
the hand-authored default template (`src/config/default-theme.ts`) and
`backend/apis/agent.py`'s `generate_landing_page`, a **real** vision-LLM
call as of 2026-08-03, reachable from the browser via
`page-generator-panel.tsx` (see above). The vision LLM's job is to pick
which of these section types apply to a design image and fill in their
content — never to emit raw HTML/CSS — so a generated page can't inject
arbitrary markup and always stays visually consistent with the rest of
the site.

| Component | Purpose |
|---|---|
| `SectionRenderer` | Takes `sections: PageSection[]` and an optional `accentColor` (hex), switches on `section.type`, renders the matching component below. When `accentColor` is set, wraps output in a `div` overriding the `--primary` CSS custom property, scoped to that render — retints buttons/badges/icons without allowing arbitrary generated CSS (doesn't recompute `--primary-foreground` contrast — a rough approximation on purpose). Add a `case` here whenever a new section type is added to `lib/theme.ts`. |
| `HeroSection` | Headline/subheadline/eyebrow badge + CTA buttons. Renders two-column (text + `ThemeImageBox`) when `image` is present, single-column text-only otherwise. |
| `FeatureGridSection` | Heading + a responsive grid, or (`layout: "split"`) heading/subheading in a left column beside a 2-column item grid in a right column (capped at 2 cols regardless of `columns` — a split grid only gets ~2/3 of the container width). Items without an `image` render via the existing `ModuleCard` (keeps its hover-arrow/"Planned"-pill polish); items *with* an `image` render via this file's own `FeatureCardWithImage` instead — `ModuleCard` isn't touched/extended, since it's also used by hand-authored nav content that has no need for photo support. |
| `CarouselSection` | Swiper-based image carousel ("走马灯"). Client component (`"use client"`) — Swiper needs the DOM. Slides render through `ThemeImageBox`, not a raw `<img>` — see below. |
| `ThemeImageBox` | Renders a `ThemeImage`: a real `<img>` if `url` isn't `"#"`/empty, otherwise a deterministic (hash-seeded, not random — avoids an SSR/CSR hydration mismatch) gradient placeholder captioned with `alt`. This is the one place "no image" gets turned into something presentable — used by `HeroSection`, `FeatureGridSection`'s image cards, `CarouselSection`, and `TextBlockSection`. Uses a plain `<img>` for real URLs, not `next/image`, since generated content's image host isn't known ahead of time (no `remotePatterns` to configure against). |
| `TextBlockSection` | Icon + heading + body paragraph, optionally centered. Three mutually-aware layouts: plain (default), side-by-side with `image`/`image_position` (mirrors `HeroSection`'s image layout), or full-bleed `background_image` with a dark scrim behind the text (takes priority over `image` if somehow both are set). |
| `CtaBannerSection` | Closing call-to-action banner (heading + body + buttons). Not used by the current default template. |
| `BadgeListSection` | Heading + a row of badges (e.g. the tech-stack list). |
| `icon-registry.ts` | `resolveIcon(key)` maps a schema icon string (e.g. `"shield-check"`) to a real Lucide component, with a safe fallback for unknown/hallucinated keys. `ThemeIcon` (also here) is the component to actually render one — use it instead of `resolveIcon(...)` + a raw JSX tag, which trips the `react-hooks/static-components` lint rule (see its doc comment for why). |

### `src/components/theme/cte/` — click-to-edit (CTE)

Added 2026-08-04, **redesigned 2026-08-05** off real usage feedback (see
the root `AGENTS.md`'s Phase 4 entry for the full before/after writeup) —
a lightweight, schema-native click-to-edit layer, deliberately **not**
GrapesJS. Inserted directly into the section components above (around
their headline/body/image/item/CTA output), not a separate editor-only
rendering path — every public route pays zero cost for this existing,
since it's all gated behind a context default of `active: false`.

| Component | Purpose |
|---|---|
| `CteProvider` / `useCte()` | React Context. `CteProvider` now takes `active` as an explicit prop (2026-08-05 — previously always `true` whenever mounted) driven by `CteEditorPanel`'s "Edit mode" `Switch`, off by default. Every public route (`/`, `/about`, `/p/[slug]`) renders `SectionRenderer` with no provider above it at all, so `useCte()`'s default (`active: false`) keeps them byte-for-byte the same as before this feature existed either way. |
| `Editable` | Wraps one logical, independently-editable piece of content — a headline, an image, a whole feature-grid item, a CTA button — with a click-to-edit affordance. When `useCte().active` is false: a pure `<>{children}</>` passthrough if no `className` was given (text fields), or `children` wrapped in the same element with just `className` applied (block fields) — **not** a bare passthrough for those, see the 2026-08-05 bugfix note below. **Redesigned 2026-08-05**: renders a small pencil-icon `<button>` as a DOM **sibling** of `children` (inline right after the text for `fieldType === "text"`/`"cta"` — corner badges would overlap small content like a button label — pinned to an *inset* corner, `top-2 right-2`, for image/feature-item/badge-list) instead of the whole block being one big hover-revealed click target — see the component's own doc comment for the concrete bugs this fixed: mobile has no hover; a click on stacked/overlapping content like `TextBlockSection`'s `background_image` could only ever resolve to whichever element was on top; a corner badge with *negative* offsets got clipped by any wrapped content that also set `overflow-hidden`; and — the more serious one — the original inactive-path bare passthrough silently dropped essential layout `className` (aspect ratio, `overflow-hidden`, `rounded-2xl`) on every image, everywhere edit mode was off, i.e. by default on every real page. The sibling-not-descendant relationship is also why a badge inside a `<Link>` (feature cards, CTA buttons) never triggers that link's navigation. |
| `CteEditorPopover` | The field editor — **redesigned 2026-08-05 from a `position: fixed` popover positioned via `getBoundingClientRect()` to a `Sheet`** (shadcn/base-ui, already used by `MobileNav`). The old approach could push off-screen near the bottom of a long page and, being `position: fixed`, couldn't be scrolled back into view afterward; a `Sheet` always renders at a fixed screen edge regardless of click position. Branches on `fieldType` (`"text"` / `"image"` / `"feature-item"` / `"badge-list"` / `"cta"`, the last added 2026-08-05). Also reads `selection.mode` (`"edit"` default / `"create"`, see `lib/cte.ts` — added same day alongside `AddItemButton` below): the title/save-button label switch to "Add", and an optional `onDelete` prop (only passed for existing feature-item/cta selections, see `CteEditorPanel`) renders a Delete button in the footer, gated behind a `window.confirm()`. Kept its filename despite no longer being a popover. |
| `AddItemButton` | Added 2026-08-05. A dashed "+" tile/pill rendered after the last item in an array field (feature-grid items, CTA buttons) — self-gates on `useCte().active` so call sites don't need their own check. Clicking it opens `CteEditorPopover` in `mode: "create"` with a blank/default item prefilled; saving appends rather than replaces (see `lib/cte.ts`'s `appendByPath`). Deliberately scoped to *items within an already-existing array field* — whole-section insert/reorder/delete was discussed and explicitly declined (see the root `AGENTS.md`'s CTE section) to keep CTE "touch up what's there," not a general page builder. |
| `ImageFieldEditor` | Added 2026-08-05. The "image" fieldType's actual editor, also reused inside `CteEditorPopover`'s feature-item form when that item has an image — 4 tabs: **URL** (paste one directly, the original/only option before this), **Upload** (`FileDropzone` → base64 → `lib/media.ts`'s `uploadMedia`), **Generate** (a prompt → `lib/poster.ts`'s `generatePoster` with empty overlay text — reuses `PosterGeneratorPanel`'s exact backend call, no new generation endpoint), **Library** (`lib/media.ts`'s `listMedia`, a grid of ComfyUI-output + previously-uploaded images to pick from, fetched lazily on first switching to that tab). Every tab just calls the same `onChange(image: ThemeImage)` — nothing here saves on its own, `CteEditorPopover`'s Save button commits whatever the draft ends up being, same as every other field type. |

`lib/cte.ts` (not a component, but the piece that makes the above work):
`setByPath(sections, path, value)`, a hand-rolled lodash-`_.set`-shaped
immutable updater — dot-separated paths mixing array indices and object
keys (e.g. `"1.items.2.image.url"`, `"0.ctas.1"`). Always returns a new
top-level array/object so a plain `setSections(prev => setByPath(prev,
...))` in `CteEditorPanel` triggers a normal React re-render; sibling
arrays/objects keep their old references (verified via standalone unit
tests, not just eyeballed) so unrelated parts of the tree don't
unnecessarily re-render either. `CteSelection` (also here) dropped its
`rect: DOMRect` field in the 2026-08-05 redesign — the `Sheet` doesn't
need click-position data the old positioned popover did, and gained an
optional `mode?: "edit" | "create"` the same day (see `AddItemButton`
above). Also added same day: `appendByPath(sections, arrayPath, value)`
(pushes onto the array at `arrayPath`, treating a missing array as
empty) and `removeByPath(sections, itemPath)` (splices out the element
at `itemPath`) — both reuse `setByPath`'s internal `setRecursive` plus a
small `getByPath` reader, rather than duplicating the path-walking logic.

**Explicit scope cuts that still stand, decided while building**:
padding/margin editing (named in the original project plan alongside
GrapesJS) is still **not** built — the `PageSection` schema has no
spacing fields today, and adding free-form CSS controls would cut
against the same "no raw generated CSS" principle `accentColor` was
deliberately scoped around (see `SectionRenderer`'s row above).
`CarouselSection` slides still aren't editable — lower value for the
added surface, left for later if ever needed.

## `src/lib/`

- `api.ts` — `apiFetch<T>(path, options)`: fetch wrapper for the FastAPI
  backend. Resolves the base URL — **`NEXT_PUBLIC_API_URL` in the browser,
  `INTERNAL_API_URL` on the server** (Server Components run inside the
  frontend container, where the browser-facing URL doesn't reach the
  backend — see the root `AGENTS.md`'s gotcha on this, it's a real trap),
  JSON-serializes `body`, attaches `Authorization: Bearer <token>`
  automatically from `lib/auth.ts`'s stored session (override via the
  `token` option only if you genuinely need a different one for one call),
  defaults `cache: "no-store"` (Next's Server Component fetch cache held
  onto a stale result here even under `force-dynamic` — override per-call
  if a page genuinely wants caching), throws `ApiError` on non-2xx. Route
  every module's backend calls through this.
- `auth.ts` — real session state (backend/apis/auth.py), replaced the old
  `dev-role.ts` placeholder 2026-08-04. `getAuthToken()` / `getAuthState()`
  / `setAuth()` / `clearAuth()` (localStorage-backed) + `useAuth()`
  (reactive, via `useSyncExternalStore` — same pattern `dev-role.ts` used).
  The JWT itself is the real source of truth for RBAC (the backend
  re-verifies it every request); what's cached here is purely so the UI
  knows what to show without an extra round trip — never trust
  `role`/`email` read from here for anything privileged.
  **Gotcha hit and fixed same day**: unlike `dev-role.ts` (whose snapshot
  was a plain string, fine to recompute every call), `AuthState` is an
  *object* — `useSyncExternalStore`'s `getSnapshot` must return the same
  reference when nothing's changed, or React throws "the result of
  getSnapshot should be cached" (an actual infinite-render-loop risk, not
  just a lint nag). Fixed by caching the parsed object keyed on the raw
  localStorage string (`cachedRaw`/`cachedState` module vars in `auth.ts`)
  — same raw value in, same object reference back out. Any future
  `useSyncExternalStore` snapshot that returns an object/array (not a
  primitive) needs this same caching, not just a fresh computation per call.
- `types.ts` — shared domain types: `Role`, `RagSource`, `ChatMessage`,
  `ChatControl`, `ChatOption`. `RagSource` is real as of 2026-08-04
  (snake_case `document_id`/`chunk_id`/`document_title`, matching
  `backend/apis/chat.py`'s `ChatSource` wire format exactly — no camelCase
  aliasing, same convention as `GeneratedPage.accent_color`) — it started
  life as the standalone `/knowledge` page's citation shape
  (`RagQueryResponse`, now gone) and is now `ChatMessage.sources?`, the
  chatbot's citation shape, after the 2026-08-04 RAG-into-chat merge (see
  the root `AGENTS.md`). The old placeholder `User`/`IngestedDocument`
  types are gone too — auth's real shape is `AuthState` in `lib/auth.ts`,
  document management's real shape is `DocumentSummary` in
  `lib/documents.ts`.
- `chat.ts` — client for `backend/apis/chat.py`: `sendChatMessage(message,
  history)` returns `{reply, sources}`, `sources` being `RagSource[]`
  (`[]` for a plain conversational reply — retrieval always runs
  server-side, but irrelevant matches never reach the frontend). No RBAC —
  this is the one public, tool-free path described in the root
  `AGENTS.md`'s RBAC architecture note. Also has `getChatSessionId()`
  (2026-08-04): a `crypto.randomUUID()` cached in `localStorage`, sent as
  `session_id` on every call so the backend can log turns for
  market-research review — see the root `AGENTS.md`'s "Visitor
  conversation persistence" section. Purely a grouping key, not auth.
- `models.ts` — client for `backend/apis/model_settings.py` (admin/owner
  only): `listModels()` (`{chat_models, vision_models}`, each a
  `ModelOption` — `provider`, `model`, `vision`, `configured`,
  `selectable`, `note`), `getModelSettings()` / `updateModelSettings()`
  (the current/new global pick, `{chat_provider, chat_model,
  vision_provider, vision_model}`). Not to be confused with `theme.ts`
  (page-section schema types) — this is purely about *which LLM* answers,
  not what it outputs.
- `integrations.ts` — client for `backend/apis/agent.py`'s
  `GET /agent/integrations` (admin/owner only): `getIntegrations()`
  returns `{comfyui: {available, detail}}`, a live reachability check.
  Originally used to gray out the poster *stub* card in
  `agent-console-section.tsx`; now consumed by `poster-generator-panel.tsx`
  instead, since `generate_poster` went real 2026-08-04 and moved out of
  that generic grid — see both entries above. Deliberately narrow (one
  service); don't grow this into a general health-check client without a
  second real capability that needs one.
- `poster.ts` — client for `backend/apis/agent.py`'s `generate_poster`
  (admin/owner only, real as of 2026-08-04): `generatePoster(prompt,
  overlayText)` returns `{image_url}`. Slow (ComfyUI txt2img + optional
  text-overlay compositing) — same "budget minutes, not seconds" caveat
  as `generate_landing_page`. Also called from `ImageFieldEditor`'s
  "Generate" tab (see `components/theme/cte/` below, added 2026-08-05)
  with an empty `overlayText` — plain generation, no overlay — rather
  than giving CTE its own duplicate generation client/endpoint.
- `documents.ts` — client for `backend/apis/documents.py` (admin/owner
  only): `ingestDocument(filename, contentType, contentBase64)`,
  `listDocuments()`, `deleteDocument(id)`. `DocumentSummary` includes
  `status` (`pending`/`processing`/`ready`/`error`), `error_message`, and
  `chunk_count` — ingestion is synchronous-but-fire-and-forget from the
  caller's perspective (the POST returns after parse/chunk/embed
  completes or fails; `document-manager.tsx` just refetches the list
  after to pick up the final status).
- `utils.ts` — `cn()` (clsx + tailwind-merge), shadcn-generated.
- `theme.ts` — `PageSection` union (`HeroSection`, `FeatureGridSection`,
  `CarouselSection`, `TextBlockSection`, `CtaBannerSection`,
  `BadgeListSection`) for LLM-generated/data-driven pages, plus
  `GeneratedPage` (`{ sections, accent_color? }` — the shape
  `generate_landing_page` actually returns; note `accent_color` is
  snake_case to match the backend wire format, no camelCase aliasing
  anywhere in this API) — see `components/theme/` above. `HeroSection` and
  `FeatureItem` both have an optional `image?: ThemeImage` (photo takes
  priority over `icon` on a feature item); `TextBlockSection` additionally
  has `image`/`image_position` (side-by-side) and `background_image`
  (full-bleed, mutually exclusive with `image`); `FeatureGridSection` has
  `layout?: "stacked" | "split"`. **Must stay in sync with the
  mirrored Pydantic models in `backend/apis/agent.py`** (`HeroSection`,
  `FeatureGridSection`, etc. there too) — adding a section type or field
  means updating both sides.
- `pages.ts` — client for `backend/apis/pages.py`: `savePageVersion`,
  `listPages`, `listPageVersions`, `restorePageVersion` (all admin/owner —
  go through the usual `apiFetch`/RBAC path), and `getPublicPage(slug)`
  (public, no RBAC — returns `GeneratedPage | null`, `null` on a 404
  rather than throwing, so callers can fall back to a default template
  without a try/catch at every call site).
- `file.ts` — `fileToBase64(file)`: reads a `File` as a base64 data URI
  (FileReader-based, browser-only). Used by `PageGeneratorPanel`'s and
  `ImageFieldEditor`'s (see above) image uploads.
- `cte.ts` — powers the click-to-edit layer (`components/theme/cte/`, see
  above): `setByPath(sections, path, value)`, plus the shared
  `EditableFieldType` (`"text" | "image" | "feature-item" | "badge-list" |
  "cta"`, the last added 2026-08-05) / `CteSelection` types. No backend
  client here — CTE field edits round-trip through the existing `pages.ts`
  functions above, this file is purely local state manipulation.
- `media.ts` — client for `backend/apis/media.py` (admin/owner only,
  added 2026-08-05): `listMedia()` and `uploadMedia(filename,
  contentBase64)`, backing `ImageFieldEditor`'s Library and Upload tabs
  (see `components/theme/cte/` above). "Generate" doesn't have a client
  here — it reuses `poster.ts`'s `generatePoster` directly rather than
  duplicating a call to the same underlying endpoint.
- `slug.ts` — `slugify(input)`: normalizes free-typed text into a
  URL-safe page slug (lowercase, whitespace/underscores → hyphens, strips
  anything else, collapses stray hyphens). Added 2026-08-05 after a real
  slug field accepted "Summer Promo!" verbatim instead of turning it into
  `summer-promo`. Applied right before a slug is actually used (Load/
  Save), not on every keystroke — used by both `CteEditorPanel` and
  `PageGeneratorPanel`'s `SavePageForm`.

## `src/config/`

- `nav.ts` — `primaryNav: NavItem[]`, single source of truth for primary
  navigation, consumed by `SiteHeader`, `MobileNav`, and `SiteFooter`.
- `default-theme.ts` — `DEFAULT_HOME_SECTIONS` / `DEFAULT_ABOUT_SECTIONS:
  PageSection[]`, hand-authored fallback content `app/page.tsx` /
  `app/about/page.tsx` each render **only when nothing's been saved to
  that slug yet** (see `lib/pages.ts` and the root `AGENTS.md`'s
  page-storage section — this stopped being purely hypothetical on
  2026-08-04, it's now a real fallback path exercised on every request).
  `DEFAULT_ABOUT_SECTIONS` (added 2026-08-04) carries over the About
  page's original hand-written JSX copy verbatim, converted into the
  section schema — see the Routes entry for `/about` below.

## Routes

- `/` (`app/page.tsx`) and `/p/[slug]` (`app/p/[slug]/page.tsx`) are both
  `export const dynamic = "force-dynamic"` — **not statically
  prerendered**, deliberately, since they fetch a page's current content
  from the backend on every request (so a save shows up immediately, no
  rebuild). `/p/[slug]` 404s via `notFound()` if the slug has no saved
  version; `/` falls back to `DEFAULT_HOME_SECTIONS` instead, since the
  homepage should never have nothing to show.
- `/about` (`app/about/page.tsx`) joined `/` and `/p/[slug]` as
  `dynamic = "force-dynamic"` on 2026-08-04 — converted from hand-written
  JSX to the same `getPublicPage("about")` + `SectionRenderer` +
  `DEFAULT_ABOUT_SECTIONS` (`config/default-theme.ts`) fallback pattern as
  `/`, so it can now be generated/saved/rolled-back through the same
  admin pipeline (`PageGeneratorPanel`'s `SavePageForm` autocompletes the
  `"about"` slug) instead of needing a code change to update. No content
  changed in this conversion — `DEFAULT_ABOUT_SECTIONS` carries the old
  JSX's copy over verbatim as the fallback shown until something's
  actually saved to that slug.
- Every other route (`/chat`, `/dashboard`, `/editor`, `/login`) is still
  statically prerendered — no reason for those to be dynamic, they don't
  depend on saved-page content. `/knowledge` used to be in this list —
  removed 2026-08-04 when its RAG Q&A merged into `/chat` (see the root
  `AGENTS.md`).
- **A brand-new route file may 404 until the dev server restarts** —
  Turbopack dev mode doesn't always pick up a freshly-created `page.tsx`
  the way it hot-reloads edits to existing ones. Hit this adding
  `app/login/page.tsx`; `docker compose restart frontend` fixed it. The
  reverse also happened, 2026-08-04: **deleting** `app/knowledge/page.tsx`
  kept serving 200s from the stale route table until a restart — same
  fix, same underlying cause (Turbopack's route discovery isn't purely
  file-system-live), just triggered by removal instead of addition. See
  the root `AGENTS.md`'s gotchas for how this differs from the deeper
  `.next` cache-corruption issue (that one needs `--renew-anon-volumes`,
  a plain restart won't fix it).

## Theming

`theme-provider.tsx` (wraps `next-themes`) + `mode-toggle.tsx` (light/dark
toggle button) are wired into the root layout. Dark mode works via the
`.dark` class + CSS variables already defined in `globals.css` — no extra
setup needed to use `dark:` variants anywhere.

