<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reusable component catalog

Check here before building a new component — most cross-page needs
(loading/empty/error states, layout chrome, RBAC role display, RAG source
citations) already have one. Keep this catalog in sync when you add,
rename, or change the API of anything under `src/components/`.

**This is a current-state index, not a changelog** — one line per
component/helper: what it is, its key props/API, one clause of "why" only
if genuinely non-obvious. For the full story behind any entry (bug
postmortems, redesign history, exact verification steps), see
**`HISTORY.md`** — grep it for the component name, don't read it
top-to-bottom.

Import alias: `@/components/...` (see `components.json` / `tsconfig.json`).

## `src/components/ui/` — shadcn/ui primitives

Generated via `npx shadcn@latest add <name>`, style `base-nova`
(`@base-ui/react`, **not Radix**). Standard shadcn API/props unless
noted. Installed: `avatar`, `badge`, `button`, `card`, `dropdown-menu`,
`input`, `label`, `scroll-area`, `select`, `separator`, `sheet`,
`skeleton`, `sonner` (toaster), `switch`, `tabs`, `textarea`, `tooltip`.
Add more with the same command rather than hand-rolling.

**base-ui gotcha**: composition uses a `render` prop, not `asChild`:
`<Button render={<Link href="/x" />}>Text</Button>`.

**base-ui gotcha 2**: `Button` defaults to `nativeButton={true}`. Pass
`nativeButton={false}` whenever `render` isn't a `<button>` (e.g.
`<Link>`, a plain `<a>`) or Base UI logs a dev-only accessibility warning.

## `src/components/layout/` — page chrome

| Component | Purpose |
|---|---|
| `SiteHeader` | Sticky top nav: logo, desktop nav links (`src/config/nav.ts`), `ModeToggle`, `MobileNav` trigger. In root `layout.tsx`. |
| `SiteFooter` | Footer sitemap (same nav config) + tagline. |
| `MobileNav` | Client component; `Sheet`-based nav drawer for small screens. |
| `NavLink` | Client component; highlights itself via `usePathname()`. Takes plain `href`/`title` strings, not a whole `NavItem` (icon is a function — can't cross the Server→Client prop boundary, see root `AGENTS.md`'s RSC gotcha). |
| `Container` | `mx-auto max-w-6xl px-4…` wrapper — use for any section's horizontal rhythm. |
| `PageHeader` | Title + description + optional right-aligned actions slot. |

## `src/components/common/` — cross-module UI

| Component | Purpose |
|---|---|
| `LoadingSpinner` | Inline `Loader2` spin + label. |
| `EmptyState` | "Nothing here yet" card (icon + title + description + optional action). Also used as an RBAC-locked-out state. |
| `ErrorMessage` | Failed-request card with optional `onRetry`. Pairs with `ApiError` (`lib/api.ts`). |
| `RoleBadge` | Renders an RBAC `Role` as a colored `Badge`. Display only — backend re-checks every request. |
| `SourceCitationList` | Renders `RagSource[]` as hoverable citation chips (`[1] filename.pdf` + excerpt tooltip). Renders inline under RAG-grounded chat replies (`ChatMessageBubble`). |
| `ModuleCard` | Landing-page grid tile: icon + title + description + optional "Planned" badge. |
| `AuthStatus` | Header widget: "Log in" link when logged out; email + `RoleBadge` + logout when logged in. Reads `lib/auth.ts`'s `useAuth()`. Display only. |
| `FileDropzone` | Drag-and-drop file picker + click-to-browse + image preview (local blob URL via `useMemo`, not a `useState`+`useEffect` pair). |

## `src/components/modules/` — feature-specific

Built for one module each; not meant to be reused elsewhere.

| Component | Purpose |
|---|---|
| `model-settings-panel.tsx` | `/dashboard` AI model picker (admin/owner). Two `Select`s (chat/vision model) from `lib/models.ts`'s `listModels()`/`getModelSettings()`. Vision-capability icon + "Not configured" badge per option; disabled options stay visible, not hidden. Save is global + immediate (every visitor's `/chat` and every future generation uses it). |
| `document-manager.tsx` | `/dashboard` document management (admin/owner). `FileDropzone` upload → base64 → `lib/documents.ts`'s `ingestDocument`; lists documents with a status `Badge` (pending/processing/ready/error) + per-row delete. |
| `geo-page-panel.tsx` | Single auto-generated GEO/SEO company-profile page (`lib/geo-page.ts`'s `generateGeoPage()`, fixed slug `GEO_PAGE_SLUG = "seo"`, no picker). Generate/Regenerate + `SectionRenderer` preview + Edit (→ `/editor`) + Delete (`window.confirm`). |
| `chat/chat-panel.tsx` | `/chat` message list + composer. Steps 0-3 (category→tags→channel→free-text) are a **scripted local flow**, not LLM-driven. Free-text turns call the real `POST /api/chat` (`lib/chat.ts`'s `sendChatMessage`), RAG-grounded — a reply can carry `sources` (`[]` when nothing relevant, not just when nothing's uploaded). |
| `chat/chat-message-bubble.tsx` | One message bubble; renders `ChatControlRenderer` under assistant messages carrying a `control`. |
| `chat/chat-control-renderer.tsx` | Turns a `ChatControl` (`{ type: "text"\|"radio"\|"checkbox"\|"select", options? }`) into the matching widget, calls `onSubmit(value)`. |
| `login-form.tsx` | `/login` — email + password, `POST /api/auth/login`, `lib/auth.ts`'s `setAuth()`, redirect to `/dashboard`. Displays the 3 seeded demo accounts (password `0000` for all). |
| `agent-console-section.tsx` | `/dashboard`'s role-gated section. `user`/logged-out sees a locked `EmptyState`; admin/owner sees every real capability in order: `ModelSettingsPanel`, `DocumentManager`, `GeoPagePanel`, `PosterGeneratorPanel`, `PageGeneratorPanel` + `PageManager`, `CrmPanel`, `ReportPanel`. No stub-card grid — every `backend/apis/agent.py` route is real. |
| `poster-generator-panel.tsx` | Real UI for `generate_poster`: prompt + optional overlay text + Generate. Checks `lib/integrations.ts`'s `getIntegrations()` on mount, disables Generate with an explanation if ComfyUI is unreachable. Renders result via plain `<img>` (budget minutes, not seconds). |
| `crm-panel.tsx` | Real UI for CRM entry capture (`lib/crm.ts`'s `pushCrmEntry`/`listCrmEntries`). Form (email/summary/comma-separated tags) + list of captured entries. Stores in this project's own DB — no third-party CRM account configured. |
| `report-panel.tsx` | Real UI for chat-volume reporting (`lib/reports.ts`'s `generateChatVolumeReport`). Start/end date picker (defaults last 7 days) + a **recharts** line chart (sessions + messages per day). Scoped to chat volume only. |
| `page-generator-panel.tsx` | Real upload UI for `generate_landing_page`: `FileDropzone` (design image) + notes + Generate, live preview via `SectionRenderer`. Also renders `SavePageForm` (slug + note + Save → `lib/pages.ts`'s `savePageVersion`; slug `"home"` publishes to `/`, anything else to `/p/[slug]`). **Section locking**: each preview section (`LockableSectionPreview`) has a hover-revealed Lock/Move/Delete toolbar; regenerating merges the new result with locked sections preserved (`mergeLockedSections`, client-side only). Sections are keyed by a client-only `crypto.randomUUID()` (`PreviewItem`), not array index, so locks/animation follow content through a reorder. Move/delete animated via `framer-motion`. |
| `page-manager.tsx` | Lists every saved page (`GET /api/agent/pages`), expandable version history, one-click Restore (copies old content into a *new* version — never destroys history), per-page Delete (`window.confirm`, no undo). |
| `cte-editor-panel.tsx` | The real `/editor` UI — see "CTE" below for the full editing-capability catalog. Loads an *existing* slug only (no blank-page authoring — that's `PageGeneratorPanel`'s job); "Edit mode" `Switch` (off by default) drives `CteProvider`'s `active`. |

## `src/components/theme/` — LLM-generated page rendering

Renders a `PageSection[]` (`lib/theme.ts`) — output shape for both the
hand-authored default template (`src/config/default-theme.ts`) and
`backend/apis/agent.py`'s `generate_landing_page`/`generate_geo_page`.
The vision/text LLM only ever picks section types + fills content — never
emits raw HTML/CSS.

| Component | Purpose |
|---|---|
| `SectionRenderer` | `{sections, accentColor?, startIndex?, mergeContainerBadge?}` — switches on `section.type`. `accentColor` (hex) wraps output in a `div` overriding `--primary`, scoped to that render. `startIndex` offsets each section's CTE path (lets a caller render a slice, e.g. one section at a time, without corrupting other sections' paths). `mergeContainerBadge` (CTE-only) suppresses a top-level `container` section's own edit badge when the caller already folds it into another toolbar. Add a `case` here whenever a new section type is added to `lib/theme.ts`. |
| `HeroSection` | Headline/subheadline/eyebrow + CTAs. Two-column (text + `ThemeImageBox`) when `image` set, `image_position?: "left"\|"right"`. `background_color` (hex) → compact "banner" padding instead of the normal hero padding. `headline`/`subheadline` are `string \| RichText`. |
| `FeatureGridSection` | Heading + item grid, or (`layout: "split"`) heading/body/cta in a left column beside a fixed 2-col item grid. `item_style?: "card"\|"plain"\|"list"` (default `"card"`) — `"plain"` drops card chrome, `"list"` ignores `columns`/`layout` entirely (single-column divided rows). `image_style?: "photo"\|"avatar"` on individual items. `heading`/`subheading`/`body` are `string \| RichText`. |
| `CarouselSection` | Swiper-based carousel. Client component. Built but unused by the default template; not CTE-editable. |
| `ThemeImageBox` | Renders a `ThemeImage`: real `<img>` if `url` isn't `"#"`, else a deterministic (hash-seeded, not random — avoids SSR/CSR hydration mismatch) gradient placeholder captioned with `alt`. Plain `<img>`, not `next/image` (generated content's host isn't known ahead of time). |
| `TextBlockSection` | Icon + heading + body, optionally centered. Three mutually-exclusive layouts: plain, side-by-side `image`/`image_position`, or full-bleed `background_image` + dark scrim. `heading`/`body` are `string \| RichText`. |
| `CtaBannerSection` | Heading + body + buttons. `string \| RichText`; CTA colors via `themeCtaStyle()`. |
| `BadgeListSection` | Heading + row of badges. `heading` is `string \| RichText`; badges themselves are plain strings. |
| `rich-text.tsx` | `resolveRichText(value): RichText` normalizes `string \| RichText`. `richTextStyle(rt)` returns `color`/`fontSize` (px)/`fontWeight` as an inline `style` object — **inline style, not a Tailwind class**, specifically because a class-based override can lose to a responsive breakpoint class (`sm:text-5xl`) in the same tailwind-merge "slot." |
| `theme-cta-style.ts` | `themeCtaStyle(cta): CSSProperties \| undefined` (background/text/border color as inline style). `themeButtonClassName({rounded, size, border_width})` for both `ThemeCta` and `ButtonBlock`. |
| `icon-registry.ts` | `resolveIcon(key)` → Lucide component, safe fallback for unknown keys. Use `ThemeIcon` (also here) to render one, not `resolveIcon()` + a raw JSX tag (trips `react-hooks/static-components`). |
| `blocks/container-block.tsx`'s `ContainerBlock` (`"container"` case) | A top-level `container` section renders the same `ContainerBlock` nested blocks use, wrapped in the page's standard width `Container` (unless `full_bleed`). |

### `src/components/theme/blocks/` — generic block primitives

A small, fixed set of composable primitives (`ImageBlock`,
`TextContentBlock`, `ButtonBlock`, `ContainerBlock` — `lib/theme.ts`'s
`Block` union), distinct from the fixed-shape composite sections above.
For layouts the composite sections can't express (uneven column splits,
arbitrary nesting). Explicitly not a general page-builder library — no
input/select-type blocks, no free-form CSS (every style knob is an enum
or a plain hex color).

| Component | Purpose |
|---|---|
| `BlockRenderer` | `{blocks, arrayPath, sizeForRow?}` — dispatches on `block.type`, mutually recursive with `ContainerBlock`. The one genuinely tree-shaped renderer in the theme system. `arrayPath` gives each block a dot-path (`${arrayPath}.${index}`) for CTE addressing at any nesting depth. `sizeForRow` (boolean, not a function — see the root `AGENTS.md`'s RSC gotcha for why) sizes each child from its own `width` field when true. **Client component** (`"use client"`) since CTE part 7 — owns the insert-gap/type-picker state for `ContainerBlock.children`. |
| `ContainerBlock` | Row/column/grid holding other blocks. `layout: "row"`/`"column"` use flexbox (`align`, `justify`); `"grid"` uses a `COLUMN_CLASS` lookup. `background_color`/`border_color`/`background_image` (via `ThemeImageBox`, negative-z-index layer). `full_bleed?: boolean` (top-level sections only — skips the page-width wrapper). `width?: BlockWidth` (row-child sizing). `min_height?: "sm"\|"md"\|"lg"\|"xl"\|"screen"`. `margin?`/`padding?: "none"\|"sm"\|"md"\|"lg"`. A `"column"` layout with both `background_image` and `min_height` auto-anchors children to the bottom (`justify-end`) unless `justify` is explicitly set. `hideOwnBadge?: boolean` prop (CTE-only) suppresses its own corner edit badge when an external toolbar already offers the same action. |
| `ImageBlock` | `ThemeImageBox` + `aspect_ratio` (square/video/portrait/auto) + `rounded` (none/sm/lg/full). |
| `TextContentBlock` | Atomic text run: `size`/`weight`/`align` enums + optional hex `color`. Named to avoid colliding with `TextBlockSection`. |
| `ButtonBlock` | `Button` + `Link` with `background_color`/`text_color`/`border_color` (hex, inline style) instead of `ThemeCta`'s variant palette. `border_color` with no `background_color` renders outline-style. `rounded`/`size`/`border_width` shared with `ThemeCta` via `theme-cta-style.ts`. |

All four share optional **`width?: BlockWidth`** (`"auto"|"1/4"|"1/3"|
"1/2"|"2/3"|"3/4"|"full"`) — only meaningful as a direct `layout: "row"`
child; `"auto"` splits evenly among `"auto"` siblings.

### `src/components/theme/cte/` — click-to-edit (CTE)

A lightweight, schema-native click-to-edit layer, deliberately **not**
GrapesJS (GrapesJS edits raw HTML/CSS — conflicts with "the LLM/editor
never touches raw markup"). Inserted directly into the section components
above; every public route pays zero cost (gated behind
`useCte().active === false` by default, no provider at all on public
routes).

| Component | Purpose |
|---|---|
| `CteProvider` / `useCte()` | Context: `active`, `select(selection)`, `move(itemPath, direction)`, `remove(itemPath)`, `insertAt(arrayPath, index, value)`. `active` is driven by `CteEditorPanel`'s "Edit mode" `Switch`. `move`/`remove`/`insertAt` reach any nested renderer without prop-drilling; every provider besides `CteEditorPanel`'s defaults them to no-ops. |
| `Editable` | Wraps one independently-editable piece of content with a click-to-edit affordance, rendered as a DOM **sibling** of `children` (never nested — lets a badge live in a different screen position than stacked/overlapping content, e.g. `TextBlockSection`'s `background_image`). Inactive: renders `children` with `className`/`style` still applied (never a bare passthrough — often load-bearing layout). Active: pencil badge, inline after text/CTA fields, corner (`top-2 right-2`) for everything else. `hideBadge?: boolean` suppresses the badge when an external toolbar (`ArrayItemToolbar`'s `onEdit`) already offers the same action. `"block-container"`'s badge is `bg-blue-600` when shown standalone (distinguishes it from an adjacent child's badge); the *merged* toolbar version uses the same neutral style as move/delete. For `"rich-text"` fields, click reads `getComputedStyle()` (size/weight/color) and passes it as `CteSelection.computedDefaults`, so the popover shows the field's actual rendered value instead of a blank "Default." |
| `CteEditorPopover` | The field editor — a `Sheet`, `showOverlay={false}`. Branches on `fieldType`: `"text"` (plain string), `"image"`/`"feature-item"`/`"badge-list"`/`"cta"`, `"rich-text"` (content + color/size/weight for `RichText` fields), `"block-container"`/`"block-text"`/`"block-image"`/`"block-button"` (content + style together). **Live editing**: for `mode !== "create"`, edits apply as you change them (no separate Save click). `mode: "create"` (`AddItemButton`) stays click-to-commit (live-firing would append a fresh element per keystroke). Shared pieces: `EnumField` (generic `<Select>` + "Default" clear), `NumberField` (bounded numeric input + "Reset to default" — used for `RichText.size`, whose range needed to be continuous, not a 6-stop enum), `color-field.tsx`'s `ColorField`. Optional `onDelete` (feature-item/cta only) renders a footer Delete behind `window.confirm()`. |
| `AddItemButton` | Dashed "+" tile after the last item in a field-level array (feature-grid items, CTA buttons) — always-appends-at-the-end only. `SectionInsertMenu`/`BlockInsertMenu` (below) handle insert-at-any-position. |
| `ArrayItemToolbar` | Move-earlier/move-later/delete (+ optional `onEdit`) for one element of any "reusable component array" — feature-item/cta arrays, `ContainerBlock.children`. `position: absolute; top-2 left-2` (caller wraps the item in `relative`) — left corner so it never collides with that item's own pencil badge. Hover-revealed (`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100` — caller adds `group` to its wrapper). |
| `SectionInsertMenu` | "+" picker for the top-level `sections` array — `Sheet`, flat list from `lib/section-registry.ts`'s `INSERTABLE_SECTION_TYPES`. Picking one calls `onInsert(def.createDefault())`. |
| `BlockInsertMenu` | Same pattern for `ContainerBlock.children`, from `lib/block-registry.ts`'s `INSERTABLE_BLOCK_TYPES` (image/text/button/container). |
| `InsertGap` | Small "+" divider between array items — before/between/after every item (an empty array still gets exactly one gap). Hover-revealed, same mechanism as `ArrayItemToolbar`. Shared by `CteEditorPanel` (sections) and `BlockRenderer` (block children). |
| `ImageFieldEditor` | The `"image"` fieldType's editor (also used inside feature-item and `block-image`/`block-container` background-image forms). 4 tabs: **URL**, **Upload** (`FileDropzone` → base64 → `lib/media.ts`'s `uploadMedia`), **Generate** (prompt → `lib/poster.ts`'s `generatePoster`, empty overlay text), **Library** (`lib/media.ts`'s `listMedia`, lazy-fetched grid picker). |

**Discoverability**: content pencil badges are always-visible (the "what
can I edit" primary discovery mechanism — matters on touch devices).
Insert-gap "+"s and move/delete/edit toolbars are hover-revealed —
`/editor` is admin-only and used from a desktop browser in practice, and
several always-visible controls around small nested items proved to be
more noise than signal.

**Explicit, still-standing scope cuts**: fixed sections' own single
optional fields (Hero's `image`/`eyebrow`) don't support delete-then-
reinsert (only array-based content does — a different mechanism, not
built). Carousel slides aren't CTE-editable. Width/height editing on
individual blocks was discussed and shelved (not rejected — a real
ready-to-pick-up candidate: expose the existing `BlockWidth` enum +
`ContainerBlock.min_height`, both already-existing fields with no editor
UI yet).

`lib/cte.ts` (not a component, the piece that makes the above work):
- `setByPath(sections, path, value)` — hand-rolled lodash-`_.set`-shaped
  immutable updater, dot-separated paths mixing array indices and object
  keys (e.g. `"1.items.2.image.url"`). Always returns a new top-level
  array/object; sibling arrays/objects keep their old references.
- `appendByPath(sections, arrayPath, value)` — pushes onto the array,
  treating a missing array as empty.
- `removeByPath(sections, itemPath)` — splices out one element.
- `insertByPath(sections, arrayPath, index, value)` — insert at an
  arbitrary position, not just the end.
- `moveByPath(sections, itemPath, direction: -1|1)` — swaps with the
  neighbor at `direction`; no-op at either array boundary.
- `CteSelection = { path, fieldType, value, mode?: "edit"|"create",
  computedDefaults? }`. `EditableFieldType` = `"text"|"rich-text"|
  "image"|"feature-item"|"badge-list"|"cta"|"block-container"|
  "block-text"|"block-image"|"block-button"`.

`lib/section-registry.ts` / `lib/block-registry.ts`: `SECTION_REGISTRY`/
`BLOCK_REGISTRY`, one entry per type (`label`, `description`, an
`insertable` flag, `createDefault()`). `INSERTABLE_SECTION_TYPES`/
`INSERTABLE_BLOCK_TYPES` are the registries filtered on that flag — the
single source of truth for what shows in each "+" picker (`carousel` is
the one section type currently `insertable: false`, no slide-editing
support yet).

## `src/lib/`

| File | Purpose |
|---|---|
| `api.ts` | `apiFetch<T>(path, options)` — fetch wrapper. Base URL: **`NEXT_PUBLIC_API_URL` in the browser, `INTERNAL_API_URL` on the server** (Server Components run inside the frontend container; the browser-facing URL doesn't reach the backend from there — see root `AGENTS.md`'s gotcha). Attaches `Authorization: Bearer <token>` automatically from `lib/auth.ts`. Defaults `cache: "no-store"`. Throws `ApiError` on non-2xx. |
| `auth.ts` | Real session state. `getAuthToken()`/`getAuthState()`/`setAuth()`/`clearAuth()` (localStorage-backed) + `useAuth()` (`useSyncExternalStore`). The JWT is the real RBAC source of truth (backend re-verifies every request) — this cache is purely for UI display. `getAuthToken()` decodes the token's `exp` and clears stale auth if expired, called on every `apiFetch`. `AuthState` snapshots are cached by raw localStorage string so `useSyncExternalStore` gets a stable reference (returning a fresh object every call throws a React error). |
| `types.ts` | Shared domain types: `Role`, `RagSource` (snake_case, matches the backend wire format exactly), `ChatMessage`, `ChatControl`, `ChatOption`. |
| `chat.ts` | `sendChatMessage(message, history)` → `{reply, sources}`. No RBAC (the one public, tool-free path). `getChatSessionId()` — a `crypto.randomUUID()` cached in localStorage, sent as `session_id` so the backend can log turns for market-research review. Grouping key only, not auth. |
| `models.ts` | `listModels()`, `getModelSettings()`/`updateModelSettings()` — which LLM answers, not what it outputs (that's `theme.ts`). |
| `integrations.ts` | `getIntegrations()` → `{comfyui: {available, detail}}`, a live reachability check. Deliberately narrow (one service) — don't grow into a general health-check client without a second real need. |
| `poster.ts` | `generatePoster(prompt, overlayText)` → `{image_url}`. Also called from `ImageFieldEditor`'s "Generate" tab with empty `overlayText`. |
| `documents.ts` | `ingestDocument(filename, contentType, contentBase64)`, `listDocuments()`, `deleteDocument(id)`. `DocumentSummary.status`: pending/processing/ready/error. |
| `geo-page.ts` | `generateGeoPage()` (no args). Exports `GEO_PAGE_SLUG = "seo"`. Read/delete go through `pages.ts`'s generic functions. |
| `crm.ts` | `pushCrmEntry({contact_email, summary, tags})`, `listCrmEntries()`. |
| `reports.ts` | `generateChatVolumeReport(startDate, endDate)` → `{report_type, start_date, end_date, points: [{date, session_count, message_count}]}`. |
| `utils.ts` | `cn()` (clsx + tailwind-merge), shadcn-generated. |
| `theme.ts` | `PageSection` union + `Block` union — see "Page schema" in root `AGENTS.md` for the full field catalog. **Must stay in sync with the mirrored Pydantic models in `backend/apis/agent.py`** — adding a section/field means updating both sides. |
| `pages.ts` | `savePageVersion`, `listPages`, `listPageVersions`, `restorePageVersion` (admin/owner), `deletePage` (admin/owner, no undo), `getPublicPage(slug)` (public, `null` on 404 rather than throwing). |
| `file.ts` | `fileToBase64(file)` — browser-only, FileReader-based. |
| `media.ts` | `listMedia()`, `uploadMedia(filename, contentBase64)` (admin/owner). "Generate" reuses `poster.ts` directly rather than duplicating a call. |
| `slug.ts` | `slugify(input)` — lowercase, whitespace/underscores → hyphens, strips anything else, collapses stray hyphens. Applied on Load/Save, not per-keystroke. |

## `src/config/`

- `nav.ts` — `primaryNav: NavItem[]`, single source of truth for
  `SiteHeader`/`MobileNav`/`SiteFooter`.
- `default-theme.ts` — `DEFAULT_HOME_SECTIONS`/`DEFAULT_ABOUT_SECTIONS:
  PageSection[]`, fallback content rendered only when nothing's been
  saved to that slug yet.

## Routes

- `/` and `/p/[slug]` are `export const dynamic = "force-dynamic"` — not
  statically prerendered, since they fetch current page content on every
  request. `/p/[slug]` 404s (`notFound()`) if unsaved; `/` falls back to
  `DEFAULT_HOME_SECTIONS`.
- `/about` is the same pattern (`getPublicPage("about")` +
  `DEFAULT_ABOUT_SECTIONS` fallback).
- Every other route (`/chat`, `/dashboard`, `/editor`, `/login`) is
  statically prerendered — no saved-page-content dependency.
- **A brand-new route file may 404 until the dev server restarts** —
  Turbopack dev mode doesn't always pick up a freshly-created `page.tsx`
  live. The reverse happens too: deleting a route file can keep serving
  stale 200s until a restart. See root `AGENTS.md`'s `.next`-cache
  gotcha for the deeper case that needs `--renew-anon-volumes` instead.

## Theming

`theme-provider.tsx` (wraps `next-themes`) + `mode-toggle.tsx` (light/dark
toggle) wired into the root layout. Dark mode via the `.dark` class + CSS
variables in `globals.css` — no extra setup needed for `dark:` variants.
