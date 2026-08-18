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
| `model-settings-panel.tsx` | `/dashboard` AI model picker (admin/owner). Four `Select`s (chat/vision/embedding/image-gen) from `lib/models.ts`'s `listModels()`/`getModelSettings()`. Vision-capability icon + "Not configured" badge per option; disabled options stay visible, not hidden. Save is global + immediate (every visitor's `/chat` and every future generation uses it) — changing the embedding model clears every document's vectors server-side (see `DocumentManager` below). `CustomEndpointBlock` (2026-08-18) — base URL + optional API key + "Test connection" (`lib/models.ts`'s `testCustomProvider`) for any OpenAI-compatible endpoint (llama.cpp, vLLM, ...); rendered **twice**, not shared — one instance feeds chat+vision (`mergeCustomModels` into both dropdowns), a second, independent instance feeds embedding alone, since a real local setup runs embedding as its own llama.cpp process (embedding mode is a process-level flag incompatible with serving a chat model from the same router instance). Each instance has its own base URL/API key state and its own backend fields (`custom_base_url`/`custom_api_key` for chat+vision, `embedding_base_url`/`embedding_api_key` for embedding). |
| `document-manager.tsx` | `/dashboard` document management (admin/owner). `FileDropzone` upload → base64 → `lib/documents.ts`'s `ingestDocument`; lists documents with a status `Badge` (pending/processing/ready/error) + per-row delete. (2026-08-18) Per-document "Needs re-embed" `Badge` when `doc.needs_reembed` (stale relative to the currently-configured embedding provider), plus a header banner + "Re-embed all documents" button (`reembedAllDocuments`) shown whenever any document is stale — same result-summary pattern as `CrmPanel`'s "Clean up unused uploads". |
| `geo-page-panel.tsx` | Single auto-generated GEO/SEO company-profile page (`lib/geo-page.ts`'s `generateGeoPage()`, fixed slug `GEO_PAGE_SLUG = "seo"`, no picker). Generate/Regenerate + `SectionRenderer` preview + Edit (→ `/editor`) + Delete (`window.confirm`). |
| `chat/chat-panel.tsx` | `/chat` message list + composer. Steps 0-3 (category→tags→channel→free-text) are a **scripted local flow**, not LLM-driven. Free-text turns call the real `POST /api/chat` (`lib/chat.ts`'s `sendChatMessage`), RAG-grounded — a reply can carry `sources` (`[]` when nothing relevant, not just when nothing's uploaded). `embedded?: boolean` prop (default `false`) omits its own border/rounded corners when nested inside `ChatBubbleWidget`'s own card, so the two don't visually double up. Paperclip button (`lib/chat.ts`'s `uploadChatAttachment`, 2026-08-08) uploads a photo/PDF ahead of send; the resulting URL rides along on the next `sendChatMessage` call and is attached to that user message locally (`ChatMessage.attachmentUrl`) so `ChatMessageBubble` can render it — sending is allowed with an empty draft as long as an attachment is pending. |
| `chat/chat-message-bubble.tsx` | One message bubble; renders `ChatControlRenderer` under assistant messages carrying a `control`. Renders `message.attachmentUrl` (2026-08-08) above the text — an inline `<img>` thumbnail for an image URL, otherwise a small "Attached file" link that opens in a new tab. |
| `chat/chat-control-renderer.tsx` | Turns a `ChatControl` (`{ type: "text"\|"radio"\|"checkbox"\|"select", options? }`) into the matching widget, calls `onSubmit(value)`. |
| `chat/chat-bubble-widget.tsx` | Site-wide floating chat entry point, mounted once in `app/layout.tsx` (root layout) — a bottom-right bubble button (`MessageCircle`↔`X` toggle) that reveals a docked `ChatPanel` (`embedded`) above it. Hidden on `/chat` (already the full chat page — a second copy on top of itself would be confusing) and `/editor` (its CTE Sheets render `side="right"`, `inset-y-0 right-0` — the exact corner this widget docks in, would visually collide). The panel stays mounted while visually "closed" (opacity/`pointer-events`, not conditional rendering) so `ChatPanel`'s message history survives closing/reopening — and, since the App Router doesn't remount `layout.tsx` across client-side navigation, survives navigating to a different page while docked, too. Only a full page reload resets it. |
| `login-form.tsx` | `/login` — email + password, `POST /api/auth/login`, `lib/auth.ts`'s `setAuth()`, redirect to `/dashboard`. Displays the 3 seeded demo accounts (password `0000` for all). |
| `agent-console-section.tsx` | `/dashboard`'s role-gated section. `user`/logged-out sees a locked `EmptyState`; admin/owner sees every real capability in order: `ModelSettingsPanel`, `DocumentManager`, `GeoPagePanel`, `PosterGeneratorPanel`, `PageGeneratorPanel` + `PageManager`, `CrmPanel`, `ReportPanel`, `OwnerAgentPanel` (owner only — see below). No stub-card grid — every `backend/apis/agent.py` route is real. |
| `owner-agent-panel.tsx` | Owner-only (stricter than the rest of this section — see `canViewOwnerAgent` in `agent-console-section.tsx`). Command `Textarea` + Run, calls `lib/owner-agent.ts`'s `runOwnerAgentCommand` — a real LLM tool-calling loop in the separate `owner-agent` service (root `AGENTS.md`'s "Owner agent"), not a single deterministic pipeline call. Renders the final answer plus the full step trace (tool/args/result per step), not just the outcome. |
| `poster-generator-panel.tsx` | Real UI for `generate_poster`: prompt + optional overlay text + Generate. Checks `lib/integrations.ts`'s `getIntegrations()` on mount, disables Generate with an explanation if ComfyUI is unreachable. Renders result via plain `<img>` (budget minutes, not seconds). |
| `crm-panel.tsx` | Real UI for CRM entry capture (`lib/crm.ts`'s `pushCrmEntry`/`listCrmEntries`/`updateCrmEntryStatus`/`deleteCrmEntry`/`cleanupChatUploads`). Form (email/summary/category/comma-separated tags) + entries grouped by category (appointment/quote/claim/inquiry/other), each with a status (`new`/`contacted`/`closed`) `Select` that PATCHes optimistically and rolls back on failure. Stores in this project's own DB — no third-party CRM account configured; most rows now arrive from `apis/chat.py`'s automatic chat-driven capture, not this form. An entry with `attachment_url` set (2026-08-08 — the visitor attached a file in chat) shows a "View attached file" link, opened in a new tab; `contact_name`/`contact_phone` (best-effort, from automatic attachment analysis) render next to the email when present. `analysis_notes` (owner-triggered deep-scan results, accumulated) renders in a collapsed `<details>` — read-only here, actually triggering a scan is the owner-agent's `scan_crm_attachment` tool (root `AGENTS.md`), not a button in this panel. Per-entry trash-icon **Delete** (2026-08-08, `window.confirm`, no undo) and a header-level **"Clean up unused uploads"** button (runs `cleanup_chat_uploads`, reports scanned/deleted/freed-bytes inline) round out the destructive/maintenance actions this panel now supports. |
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
| `chat.ts` | `sendChatMessage(message, history, attachmentUrl?)` → `{reply, sources}`. No RBAC (the one public, tool-free path). `getChatSessionId()` — a `crypto.randomUUID()` cached in localStorage, sent as `session_id` so the backend can log turns for market-research review. Grouping key only, not auth. `uploadChatAttachment(filename, contentBase64)` (2026-08-08) → `{filename, url}`, same public tier — `POST /api/chat/upload`, also sends `session_id` (the backend stores the file under a folder keyed by that id, or the caller's account email if logged in — see the root `AGENTS.md`'s "Chat lead capture & optional caller identity" section). |
| `models.ts` | `listModels()`, `getModelSettings()`/`updateModelSettings()` — which LLM answers, not what it outputs (that's `theme.ts`). `ModelListResponse`/`ModelSettings` now cover chat, vision, **and embedding** (2026-08-18) — `embedding_dimensions` is response-only/informational. `testCustomProvider(baseUrl, apiKey?)` probes an arbitrary OpenAI-compatible endpoint, no persistence — see `model-settings-panel.tsx`'s `CustomEndpointBlock`. `ModelSettings` carries optional `custom_base_url`/`custom_api_key` for when `chat_provider` or `embedding_provider` is `"custom"` (they share one endpoint). |
| `integrations.ts` | `getIntegrations()` → `{comfyui: {available, detail}}`, a live reachability check. Deliberately narrow (one service) — don't grow into a general health-check client without a second real need. |
| `poster.ts` | `generatePoster(prompt, overlayText)` → `{image_url}`. Also called from `ImageFieldEditor`'s "Generate" tab with empty `overlayText`. |
| `documents.ts` | `ingestDocument(filename, contentType, contentBase64)`, `listDocuments()`, `deleteDocument(id)`. `DocumentSummary.status`: pending/processing/ready/error. (2026-08-18) `DocumentSummary` also carries `embedding_provider`/`embedding_model`/`needs_reembed`; `reembedAllDocuments()` → `POST /api/agent/documents/reembed-all`, re-parses every document's still-stored raw file against the current embedding config. |
| `geo-page.ts` | `generateGeoPage()` (no args). Exports `GEO_PAGE_SLUG = "seo"`. Read/delete go through `pages.ts`'s generic functions. |
| `crm.ts` | `pushCrmEntry({contact_email, summary, tags, category?})`, `listCrmEntries()`, `updateCrmEntryStatus(crmId, status)`, `deleteCrmEntry(crmId)` (2026-08-08, `DELETE`, no undo). `CrmStatus = "new"\|"contacted"\|"closed"`. `CrmEntry` also carries `attachment_url`, `contact_name`, `contact_phone`, `analysis_notes` (all `string \| null`, 2026-08-08). `cleanupChatUploads({olderThanHours?, dryRun?})` (2026-08-08) → `CleanupUploadsResult` — scans/removes orphaned `POST /api/chat/upload` files, see the root `AGENTS.md`'s "Chat lead capture" section. |
| `reports.ts` | `generateChatVolumeReport(startDate, endDate)` → `{report_type, start_date, end_date, points: [{date, session_count, message_count}]}`. |
| `owner-agent.ts` | `runOwnerAgentCommand(command)` → `{final_answer, stopped_reason, steps}`. Calls the separate `owner-agent` service directly (`NEXT_PUBLIC_OWNER_AGENT_URL`), not `lib/api.ts`'s backend `apiFetch` — different origin, different container. |
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
