# frontend — full development history

**This is the archive, not the entry point.** Frozen as a full copy of
`frontend/AGENTS.md` on 2026-08-06, at the point that file was split in
two to save context: `frontend/AGENTS.md` is now a short, current-state
component/lib index (read it first); this file is the complete
chronological detail everything there was condensed from — redesign
rationale, exact bug root-causes, verification steps.

**Read this only when the lean catalog doesn't answer your question** —
grep for the component/file name, don't read top-to-bottom.

---

Everything below is the original, unedited catalog, preserved as-is from
before the split.

---

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reusable component catalog (original, pre-split)

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
- `geo-page-panel.tsx` — added 2026-08-05, rendered right after
  `document-manager.tsx` since it consumes what's ingested there. A
  single auto-generated company-profile page for search engines/AI
  systems (GEO — see the root `AGENTS.md`'s dedicated section), backed by
  `lib/geo-page.ts`'s `generateGeoPage()` (`POST /agent/geo-page/generate`
  — no request body, no slug picker, there's exactly one of these at the
  fixed `GEO_PAGE_SLUG`). Generate/Regenerate button + a `SectionRenderer`
  preview; Edit links to `/editor` (already lists this slug once
  generated — no dedicated deep-link was built); Delete reuses
  `lib/pages.ts`'s `deletePage` behind `window.confirm()`. Status/preview
  on mount reuse `getPublicPage`/`listPageVersions` unchanged — no new
  read endpoints needed for this panel at all.
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
- `agent-console-section.tsx` — `/dashboard`'s role-gated capability
  section. Reads `useAuth()`; `user` (including anyone not logged in)
  sees a locked `EmptyState`, `admin`/`owner` see every real capability:
  `ModelSettingsPanel`, `DocumentManager`, `GeoPagePanel`,
  `PosterGeneratorPanel`, `PageGeneratorPanel` + `PageManager`,
  `CrmPanel`, `ReportPanel`, in that order. **2026-08-06**: the generic
  sample-payload "Reserved capability" card grid (`AgentCapabilityCard`,
  a "Try it" button hitting a still-501 endpoint to demonstrate the RBAC
  gate) is gone — CRM and report, its last two occupants, are both real
  now, so there was nothing left to reserve a placeholder grid for. Every
  `backend/apis/agent.py` route this component ever surfaces is real as
  of this point.
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
- `crm-panel.tsx` — added 2026-08-06, the real UI for `create_crm_entry`/
  `list_crm_entries` (`backend/apis/agent.py`, stores leads in this
  project's own DB — see root `AGENTS.md`'s CRM entry for why there's no
  third-party push). A capture form (email/summary/comma-separated tags)
  plus a list of everything captured so far, `lib/crm.ts`'s
  `pushCrmEntry`/`listCrmEntries`.
- `report-panel.tsx` — added 2026-08-06, the real UI for
  `generate_report` (`backend/apis/agent.py`). A start/end date picker
  (defaults to the last 7 days) plus a real line chart (chat sessions +
  messages per day) via **recharts** (newly added dependency — see the
  root AGENTS.md's npm-dependency-needs-`--build` gotcha), built directly
  on recharts' own primitives since no shadcn chart wrapper existed in
  this codebase for a single chart to justify adding one. `lib/
  reports.ts`'s `generateChatVolumeReport`. Scoped to chat volume only —
  "RAG query trends" (the original stub's other mentioned report type)
  isn't computable from data this project actually persists.
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
  longer preview-only, as of 2026-08-04). **Section locking + manual
  reorder/delete, added 2026-08-05**: the preview renders each section
  individually (`LockableSectionPreview`) with a hover-revealed toolbar —
  Lock/Unlock, Move up/down, Delete (behind `window.confirm`).
  Regenerating merges the new result with any locked sections preserved
  from the old one via `mergeLockedSections` — purely client-side, no
  backend change. Each preview item is a `PreviewItem = { id, section }`
  (client-only `crypto.randomUUID()`, not from the schema) used as the
  React key and as what locking is tracked by (`Set<string>`, not array
  index) — this is what lets a lock/animation follow a section's content
  through a move or regenerate instead of its position. Move/delete are
  animated via `framer-motion` (`motion.div layout` for reposition,
  `AnimatePresence` for the delete exit) — added as a new dependency,
  see the root `AGENTS.md`'s npm-dependency gotcha if `--renew-anon-
  volumes` is ever needed after a fresh container. See the root
  `AGENTS.md`'s Phase 5 entries for the full rationale, including why
  automatic content-aware matching (vs. these manual tools) was
  considered and deliberately not built.
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
| `HeroSection` | Headline/subheadline/eyebrow badge + CTA buttons. Renders two-column (text + `ThemeImageBox`) when `image` is present, single-column text-only otherwise. `background_color?: string` (plain hex) applies as inline `style`, falling back to the default `bg-muted/30` class when unset — a compact "banner" padding (`py-10 sm:py-14`, vs the normal `py-20 sm:py-28`) kicks in specifically when `background_color` is set and `image` isn't. A colored banner paired with a separate photo is typically two sections (this hero + a `full_bleed` container) — see the root `AGENTS.md`'s block-schema section for why. **`headline`/`subheadline` are `string \| RichText`** (added 2026-08-06, see `rich-text.tsx` below) — CTE can now override color/size/weight per-instance via the `"rich-text"` fieldType; a plain string (every existing page, every vision-LLM generation) renders exactly as before. CTA buttons' colors (`ThemeCta.background_color`/`text_color`/`border_color`, same day) apply via `theme-cta-style.ts`'s `themeCtaStyle()`. |
| `FeatureGridSection` | Heading + a responsive item row, or (`layout: "split"`) heading/subheading/optional `body`+`cta` in a left column beside a fixed 2-column item grid in a right column (capped at 2 cols regardless of `columns`, plain CSS Grid). The "stacked" (default) item row is `flex flex-wrap` + per-item `grow`/`basis-*` (`ITEM_BASIS_CLASS`), not CSS Grid — Grid can't redistribute a short last row's leftover space across fixed column tracks; flex-wrap's per-line `grow` fixes that while keeping the same per-row height behavior (root `AGENTS.md` has the full bug writeup). **`item_style?: "card" | "plain" | "list"`** (default `"card"`, added 2026-08-05 — not every repeated-item design is a card): `"card"` is the original behavior — items without an `image` render via `ModuleCard`, items with `image_style: "avatar"` render via `FeatureCardAvatar` (small circular photo), other items with an `image` render via `FeatureCardWithImage`. `"plain"` keeps the same grid/row arrangement but drops all card chrome (no border/background/rounded) — `PlainFeatureItem`, image position via `item_image_position?: "top" | "bottom"`. `"list"` ignores `columns`/`layout`'s grid entirely — `ListFeatureItem`s render as one full-width `divide-y` column of rows (small square photo left, text right). `heading`/`subheading`/`body` are `string \| RichText` (2026-08-06), same as `HeroSection`. |
| `CarouselSection` | Swiper-based image carousel ("走马灯"). Client component (`"use client"`) — Swiper needs the DOM. Slides render through `ThemeImageBox`, not a raw `<img>` — see below. |
| `ThemeImageBox` | Renders a `ThemeImage`: a real `<img>` if `url` isn't `"#"`/empty, otherwise a deterministic (hash-seeded, not random — avoids an SSR/CSR hydration mismatch) gradient placeholder captioned with `alt`. This is the one place "no image" gets turned into something presentable — used by `HeroSection`, `FeatureGridSection`'s image cards, `CarouselSection`, and `TextBlockSection`. Uses a plain `<img>` for real URLs, not `next/image`, since generated content's image host isn't known ahead of time (no `remotePatterns` to configure against). |
| `TextBlockSection` | Icon + heading + body paragraph, optionally centered. Three mutually-aware layouts: plain (default), side-by-side with `image`/`image_position` (mirrors `HeroSection`'s image layout), or full-bleed `background_image` with a dark scrim behind the text (takes priority over `image` if somehow both are set). `heading`/`body` are `string \| RichText` (2026-08-06). |
| `CtaBannerSection` | Closing call-to-action banner (heading + body + buttons). Not used by the current default template. `heading`/`body` are `string \| RichText`; CTA colors via `themeCtaStyle()` (2026-08-06). |
| `BadgeListSection` | Heading + a row of badges (e.g. the tech-stack list). `heading` is `string \| RichText` (2026-08-06) — the badges themselves are still plain strings, not individually styled. |
| `rich-text.tsx` | Added 2026-08-06, **`richTextClassName` replaced by `richTextStyle` the same day after a real bug**: a Tailwind-class override lost to any default class scoped to a responsive breakpoint (`HeroSection`'s `sm:text-5xl` kept winning over a plain `text-lg` override at normal desktop widths) — found from real user testing on the single most obvious field to test (a hero headline). `resolveRichText(value: string \| RichText): RichText` still normalizes either shape to the object form; `richTextStyle(rt)` now returns `color`/`fontSize` (rem, matching Tailwind's own default scale)/`fontWeight` (numeric) as a plain inline `style` object instead — inline styles always beat any class regardless of media query, so this can't lose to a responsive variant by construction, not just for the one case that got caught. |
| `theme-cta-style.ts` | Added 2026-08-06. `themeCtaStyle(cta: ThemeCta): CSSProperties \| undefined` — `background_color`/`text_color`/`border_color` as inline style on top of `variant`'s fixed palette (normal CSS specificity means inline wins, no extra logic needed); `undefined` when none are set, so an unstyled CTA renders unchanged. Used by `HeroSection`, `CtaBannerSection`, `FeatureGridSection`'s `cta` field. |
| `icon-registry.ts` | `resolveIcon(key)` maps a schema icon string (e.g. `"shield-check"`) to a real Lucide component, with a safe fallback for unknown/hallucinated keys. `ThemeIcon` (also here) is the component to actually render one — use it instead of `resolveIcon(...)` + a raw JSX tag, which trips the `react-hooks/static-components` lint rule (see its doc comment for why). |
| `container-block.tsx`'s `ContainerBlock` (`"container"`) | Added 2026-08-05 — see `components/theme/blocks/` below for the full block-primitive system this belongs to. A top-level `container` section renders the same `ContainerBlock` component nested blocks use, wrapped in the standard `Container` (page-width) layout wrapper `SectionRenderer` itself owns for this one case. |

### `src/components/theme/blocks/` — generic block primitives

Added 2026-08-05 — a small, fixed set of composable primitives
(`ImageBlock`, `TextContentBlock`, `ButtonBlock`, `ContainerBlock`, see
`lib/theme.ts`'s `Block` union), distinct from the fixed-shape composite
sections in the table above. Built for one concrete gap: a source design
with a row split into two 50/50 columns, each with its own padding
around a photo+caption, has no composite section shape that matches it —
`ContainerBlock` (`layout: "row" | "column" | "grid"`, holding a
`children: Block[]` that can include more containers) exists to express
layouts like that as plain nesting instead of a special case. Explicitly
**not** a general page-builder block library — no input/textarea/
select-type blocks (the chatbot handles interactive needs elsewhere), no
free-form CSS anywhere (every style knob is a constrained enum or a
plain hex color string, same controlled pattern `accentColor` already
uses). CTE (click-to-edit) support for these — insert/edit via
`Editable`/`AddItemButton` — hasn't been built yet; see the root
`AGENTS.md`'s entry for the deliberate staging (schema/renderers first,
CTE only after real vision-LLM generation quality is confirmed usable).

| Component | Purpose |
|---|---|
| `BlockRenderer` | `{ blocks: Block[], arrayPath: string, itemClassName? }` — dispatches on `block.type`, mutually recursive with `ContainerBlock` (below), which calls back into this for its own `children`. This is the one genuinely tree-shaped renderer in the whole theme system — every other section stays flat. `itemClassName` (a `(block: Block) => string | undefined` function, changed 2026-08-05 from a single static string) wraps each rendered block in a `div` with that block's own computed class *only when the function returns one* (no extra DOM otherwise) — used by `ContainerBlock`'s `"row"` layout to size each direct child from *that child's own* `width` field. **`arrayPath` (added 2026-08-06)**: each block's own CTE-editable path is `${arrayPath}.${index}`, letting a block at any nesting depth be addressed with the same dot-path scheme (`lib/cte.ts`'s `setByPath`) every other editable field already uses — no separate addressing mechanism needed, verified to round-trip correctly two levels deep. |
| `ContainerBlock` | Row/column/grid layout holding other blocks. `layout: "row"`/`"column"` use flexbox (`items-*` from `align`, `justify-*` from **`justify?: "start"\|"center"\|"end"\|"between"`**, added 2026-08-06 — `align`'s main-axis counterpart, only meaningful for row/column, ignored for grid); `"grid"` uses the same `COLUMN_CLASS`-lookup pattern `FeatureGridSection` uses for `columns`. `background_color`/`border_color` apply as inline `style` (plain hex, not a Tailwind class — these are AI/CTE-picked values, not part of the fixed design-token set); `background_image` covers the container's own box behind its children via `ThemeImageBox` in an absolutely-positioned, negative-z-index layer (not to be confused with `full_bleed` below — this one only fills *this container's own* box, it doesn't affect the page-width constraint). Reused as both a top-level `PageSection` (`SectionRenderer`'s `"container"` case) and a nested `Block` — identical component, identical shape, either way. **`full_bleed?: boolean`** (top-level sections only): `SectionRenderer` renders the `ContainerBlock` with no page-width wrapper at all when set. **`width?: BlockWidth`** applies when *this* container is itself a row child. **`min_height?: "sm"\|"md"\|"lg"\|"xl"\|"screen"`**: otherwise a container's height is purely content-driven, which collapses a `background_image` container far shorter than intended when its children are just a couple of lines of text. **`margin?: "none"\|"sm"\|"md"\|"lg"`** (added 2026-08-06, `MARGIN_CLASS` — same fixed-stop scale as `padding`, outside the border instead of inside). A `layout: "column"` container with both `background_image` and `min_height` set auto-anchors its children to the bottom (`justify-end`) *unless* an explicit `justify` is set, which always wins. **Now wrapped in `Editable` (`fieldType: "block-container"`, `path` prop required)** — the whole object (content + every style field above) is editable via CTE; see the root `AGENTS.md`'s CTE style-editing entry. |
| `ImageBlock` | A `ThemeImageBox` with controlled `aspect_ratio` (square/video/portrait/auto) and `rounded` (none/sm/lg/full) knobs, each mapped to a Tailwind class via a lookup table — same pattern as every other enum prop in this theme system. Wrapped in `Editable` (`fieldType: "block-image"`, `path` prop required) since 2026-08-06. |
| `TextContentBlock` | A single atomic run of text with `size`/`weight`/`align` enum props and an optional plain-hex `color`. Named `TextContentBlock`, not `TextBlock`, specifically to avoid colliding with the existing (unrelated, fixed-shape) `TextBlockSection` above — same underlying `"text"` schema discriminant either way, just a distinct TS/component symbol name. Wrapped in `Editable` (`fieldType: "block-text"`, `path` prop required) since 2026-08-06 — uses the inline badge style (like `"text"`/`"cta"`), not the corner style the other three block types use. |
| `ButtonBlock` | A `Button` + `Link` with AI/CTE-controlled `background_color`/`text_color`/`border_color` (plain hex, applied as inline `style`) instead of `ThemeCta`'s fixed variant palette. `border_color` set with no `background_color` renders as an outline-style button — there's no separate "filled but also has a colored border" state. Wrapped in `Editable` (`fieldType: "block-button"`, `path` prop required) since 2026-08-06. **`rounded`/`size`/`border_width`** (same day, shared with `ThemeCta` via `theme-cta-style.ts`'s `themeButtonClassName()`) round out the "common button params" set — every shadcn `Button` already carries a base 1px border regardless of variant, so `border_width` only matters for something heavier than that. |

All four block types share an optional **`width?: BlockWidth`** (`"auto" | "1/4" | "1/3" | "1/2" | "2/3" | "3/4" | "full"`, added 2026-08-05, `lib/theme.ts`) — only meaningful on a direct child of a `layout: "row"` `ContainerBlock`; ignored inside `"column"`/`"grid"`. `"auto"` (the default) splits the row evenly among every `"auto"` sibling, the schema's original behavior, unchanged. A deliberately small, fixed set of stops rather than an arbitrary fraction/percentage — see the root `AGENTS.md`'s CTE/block-schema section for why (the user's own framing: the exact ratio matters far less than the model reliably noticing *some* columns are uneven and picking a reasonable stop).

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
| `CteProvider` / `useCte()` | React Context. `CteProvider` now takes `active` as an explicit prop (2026-08-05 — previously always `true` whenever mounted) driven by `CteEditorPanel`'s "Edit mode" `Switch`, off by default. Every public route (`/`, `/about`, `/p/[slug]`) renders `SectionRenderer` with no provider above it at all, so `useCte()`'s default (`active: false`) keeps them byte-for-byte the same as before this feature existed either way. **2026-08-06 (CTE part 8)**: gained `move`/`remove`/`insertAt` alongside `select` — generic path-based structural editing (backed by `lib/cte.ts`'s `moveByPath`/`removeByPath`/`insertByPath`) reachable from any nested renderer without prop-drilling; every provider besides `CteEditorPanel`'s defaults these to no-ops. |
| `Editable` | Wraps one logical, independently-editable piece of content — a headline, an image, a whole feature-grid item, a CTA button — with a click-to-edit affordance. Inactive (`useCte().active === false`): renders `children` with `className`/`style` (added 2026-08-06 for `ContainerBlock`'s inline colors) still applied — never a bare passthrough for block fields, since that's often load-bearing layout (aspect ratio, background color). Active: a small pencil-icon `<button>` rendered as a DOM **sibling** of `children` (never nested inside it) — inline after the text for `"text"`/`"cta"`/`"block-text"` fields, pinned to an inset corner (`top-2 right-2`) for everything else (image/feature-item/badge-list/`block-container`/`block-image`/`block-button`). Sibling placement is deliberate: it's what lets the badge sit in a different screen position than stacked/overlapping content (e.g. `TextBlockSection`'s `background_image`), and why a badge inside a `<Link>` never triggers that link's navigation. Full before/after rationale (mobile has no hover, the dropped-`className` bug, clipped negative-offset badges): root `AGENTS.md`'s Phase 4 entry. **2026-08-06**: for `"rich-text"` fields, click reads the clicked element's `getComputedStyle()` (size/weight/color) via a new ref and passes it as `CteSelection.computedDefaults`, so the popover can show the field's actual current rendered value instead of a blank "Default" — see root `AGENTS.md`'s CTE part-7 entry. `"block-container"`'s badge is `bg-blue-600`, not the default `bg-primary` (CTE part 8) — distinguishes "edit the whole container" from an adjacent child's own badge, which previously shared the same color and was easy to mistake for each other. |
| `CteEditorPopover` | The field editor — a `Sheet` (shadcn/base-ui, not a positioned popover; kept its filename regardless), rendered with `showOverlay={false}` (added 2026-08-06, see `ui/sheet.tsx` below) so it always renders at a fixed screen edge without dimming/blurring the page behind it. Branches on `fieldType`: `"text"` (plain string, content-only — `eyebrow` and any field never widened to `RichText`), `"image"` / `"feature-item"` / `"badge-list"` / `"cta"` (content-only except `"cta"`, which gained `ColorField`s + `rounded`/`size`/`border_width` 2026-08-06), `"rich-text"` (content **and** color/size/weight — for the fixed sections' `RichText`-typed fields; a separate fieldType from plain `"text"` so style controls never appear for a field whose schema type can't hold them), and `"block-container"` / `"block-text"` / `"block-image"` / `"block-button"` (content and style together, for the generic Block system). **Live editing (2026-08-06)**: for `mode !== "create"` selections, a `useEffect` watching every field's draft state calls `onSave` on each change instead of waiting for a button click — `handleSave`'s old branching was extracted into a pure `computeValue()` so both the live effect and `mode: "create"`'s still-explicit "Add" button share one calculation. `mode: "create"` (`AddItemButton`) deliberately stays click-to-commit — it appends via `appendByPath`, and live-firing on every keystroke would append a fresh element on every change instead of refining one draft. A `skipFirstRun` ref swallows the effect's unavoidable mount-time firing so merely opening an editor doesn't mark the page dirty. The style-heavy forms are built on shared pieces defined in this file: `EnumField` (a generic labeled `<Select>` over any small fixed option set, with an optional "Default" entry that clears the field to `undefined`), `NumberField` (2026-08-06 — a bounded numeric input + "Reset to default," replacing `EnumField` for `RichText.size` specifically once its enum's range proved too narrow for a real headline), and `color-field.tsx`'s `ColorField` (native `<input type="color">` + hex text input + Clear). An optional `onDelete` prop (existing feature-item/cta selections only) renders a footer Delete button behind `window.confirm()`. |
| `AddItemButton` | Added 2026-08-05. A dashed "+" tile/pill rendered after the last item in an array field (feature-grid items, CTA buttons) — self-gates on `useCte().active` so call sites don't need their own check. Clicking it opens `CteEditorPopover` in `mode: "create"` with a blank/default item prefilled; saving appends rather than replaces (see `lib/cte.ts`'s `appendByPath`). Still the only *always-appends-at-the-end* insert path — `SectionInsertMenu`/`BlockInsertMenu` (below) handle insert-at-any-position for their respective arrays, added 2026-08-06 once whole-section/whole-block insert was reopened (see root `AGENTS.md`'s CTE part 7 — reverses Phase 4's original "declined on purpose" call). |
| `ArrayItemToolbar` | Added 2026-08-06 (CTE part 8, Tasks 2+3). Move-earlier/move-later/delete for one element of any array this schema treats as a reusable-component list — feature-item/cta arrays, `ContainerBlock.children`. `position: absolute; top-2 left-2` (the caller wraps the item in a `relative` element) — left corner specifically so it never collides with that item's own pencil badge (inline or `top-2 right-2`). Calls `useCte()`'s `move`/`remove` directly, no local state. |
| `SectionInsertMenu` | Added 2026-08-06 (CTE part 7, Task 1). The "+" picker for the top-level `sections` array — same `Sheet` component/visual language as `CteEditorPopover`, but shows a flat list of insertable section types (from `lib/section-registry.ts`'s `INSERTABLE_SECTION_TYPES`) instead of a value-editing form. Picking one calls `onInsert(def.createDefault())`; `CteEditorPanel` splices it in at whichever gap's `InsertGap` (below) was clicked. The registry's `container` default changed 2026-08-06 (part 8) from two pre-filled text columns to `children: []` — an empty row now surfaces its own "+" (via `BlockRenderer`, below) instead of placeholder content. |
| `BlockInsertMenu` | Added 2026-08-06 (CTE part 8, Task 3) — the `Block`-type analogue of `SectionInsertMenu`, picking from `lib/block-registry.ts`'s `INSERTABLE_BLOCK_TYPES` (image/text/button/container) instead of section types. Kept as a separate component/registry rather than generalizing the section ones — two call sites, two genuinely different type unions, not worth a shared abstraction. |
| `InsertGap` | Added 2026-08-06, originally local to `CteEditorPanel` (sections), pulled into its own file (`components/theme/cte/insert-gap.tsx`) the same day so `BlockRenderer` could reuse it for `ContainerBlock.children`. A thin, always-visible (not hover-revealed) `+` divider — deliberately not hover-gated, since this session already hit one real "I can't see the button" report from an unrelated z-index cause (see CTE part 6); an always-visible high-contrast badge (matching `Editable`'s pencil badge) avoids reopening that ambiguity for every new insert point this component adds. |
| `ImageFieldEditor` | Added 2026-08-05. The "image" fieldType's actual editor, also reused inside `CteEditorPopover`'s feature-item and `block-image`/`block-container`(background image) forms whenever one of those has an image — 4 tabs: **URL** (paste one directly, the original/only option before this), **Upload** (`FileDropzone` → base64 → `lib/media.ts`'s `uploadMedia`), **Generate** (a prompt → `lib/poster.ts`'s `generatePoster` with empty overlay text — reuses `PosterGeneratorPanel`'s exact backend call, no new generation endpoint), **Library** (`lib/media.ts`'s `listMedia`, a grid of ComfyUI-output + previously-uploaded images to pick from, fetched lazily on first switching to that tab). Every tab just calls the same `onChange(image: ThemeImage)` — nothing here saves on its own, `CteEditorPopover`'s Save button commits whatever the draft ends up being, same as every other field type. |

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
`CteSelection` gained `computedDefaults?: { size?, weight?, color? }`
2026-08-06 — see `Editable`'s entry above and root `AGENTS.md`'s CTE
part-7 entry.

`lib/section-registry.ts` (added 2026-08-06, CTE part 7): `SECTION_
REGISTRY`, one entry per `PageSection` type (`label`, `description`, an
`insertable` flag, `createDefault()`) — `INSERTABLE_SECTION_TYPES` is
the registry filtered on that flag, consumed by `SectionInsertMenu`
above. The `insertable` flag is a declarative single source of truth
(the user's own suggestion) for "can this type go in the + picker,"
rather than a hardcoded list baked into the picker component — `carousel`
is the one entry currently `false` (no CTE editing support for its
`slides` yet, so inserting one would be a dead end).

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
- `geo-page.ts` — added 2026-08-05, client for `backend/apis/agent.py`'s
  `POST /agent/geo-page/generate` (admin/owner only): `generateGeoPage()`,
  no arguments. Exports `GEO_PAGE_SLUG` (`"seo"`) so `geo-page-panel.tsx`
  and any other caller share the one fixed slug rather than each hardcoding
  the string separately. Reading/deleting the result go through
  `pages.ts`'s already-generic functions — this file only has the one
  generate call.
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
  `layout?: "stacked" | "split"`. Added 2026-08-05: `ImageBlock` /
  `TextContentBlock` / `ButtonBlock` / `ContainerBlock` (the generic block
  primitives — see `components/theme/blocks/` above), unioned together as
  `Block`; `ContainerBlock` is also folded into `PageSection` itself
  (`children: Block[]` makes it the one recursive/tree-shaped type in this
  file — everything else here is flat). **Must stay in sync with the
  mirrored Pydantic models in `backend/apis/agent.py`** (`HeroSection`,
  `FeatureGridSection`, etc. there too, including the new block types —
  `ContainerBlock`'s Pydantic mirror needs `model_rebuild()` after `Block`
  is defined, since it's a self-referential discriminated union) — adding
  a section type or field means updating both sides. Added 2026-08-06:
  `RichText = { content, color?, size?, weight? }` — every headline/
  heading/subheading/body field across the 5 fixed sections is now
  `string | RichText` (a plain string, the vision LLM's only output
  shape, means "default styling"; CTE-only feature, see
  `components/theme/rich-text.tsx` and the root `AGENTS.md`'s CTE
  style-editing part-2 entry). `ThemeCta` gained `background_color`/
  `text_color`/`border_color` the same day. `RichText.size` changed
  same-day (part 6) from a fixed 6-stop enum to a plain bounded pixel
  `number` (12-96) — the enum's top stop couldn't even reach a Hero
  headline's own default size; `TextContentBlock.size` (the Block
  primitive) kept its original enum, only `RichText`'s needed the wider
  range.
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
  "cta"`, plus `"rich-text"` and `"block-container" | "block-text" |
  "block-image" | "block-button"`, all added 2026-08-06 for style editing
  — `"rich-text"` for the fixed sections' `RichText`-typed fields,
  `"block-*"` for whole-Block content+style editing) / `CteSelection`
  types. No backend client here — CTE field edits
  round-trip through the existing `pages.ts` functions above, this file
  is purely local state manipulation. `setByPath`/`appendByPath`/
  `removeByPath` needed zero changes to support the new block paths —
  already generic dot-path traversal, confirmed to handle arbitrary
  nesting depth.
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

