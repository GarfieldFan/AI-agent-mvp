/** Page-section schema for LLM-generated (or hand-authored) landing pages.
 *
 * The vision LLM's job (backend/apis/agent.py's generate_landing_page,
 * not implemented yet) is to look at a design image and output a list of
 * these typed sections — NOT raw HTML/CSS. Rendering happens by mapping
 * each section to one of the actual reusable components in
 * src/components/theme/ (see section-renderer.tsx), so generated pages
 * stay safe to render (no dangerouslySetInnerHTML), stay visually
 * consistent with the rest of the site (Tailwind/shadcn, not arbitrary
 * markup), and never need pixel-perfect fidelity — just the closest
 * matching section per identified design block.
 *
 * Icons are string keys (e.g. "shield-check"), not component references —
 * this schema must be plain JSON so an LLM can produce it and a backend
 * can transport it. See components/theme/icon-registry.ts for the
 * key -> component mapping (with a safe fallback for hallucinated keys).
 */

export type ThemeImage = {
  url: string;
  alt: string;
};

export type TextSize = "sm" | "base" | "lg" | "xl" | "2xl" | "3xl";
export type TextWeight = "normal" | "medium" | "semibold" | "bold";

/** A styled text field — added 2026-08-06 for CTE style editing. Every
 * headline/heading/subheading/body field below accepts `string |
 * RichText`: a plain string (the only shape the vision LLM ever
 * produces, and every field's original shape before this existed) means
 * "use this section's own default styling, unchanged" — only a CTE edit
 * that actually sets a color/size/weight upgrades a field to this object
 * form. Deliberately not a set of `xxx_color`/`xxx_size`/`xxx_weight`
 * sibling fields per text field, which would multiply badly across every
 * section type — one shared shape instead. Still fully controlled data
 * (a hex color, a bounded number, a fixed weight enum), never free-form
 * CSS — same principle as every other style field in this schema; see
 * `components/theme/rich-text.tsx` for how it's resolved/rendered.
 *
 * `size` is a plain pixel number, not the small `TextSize` enum
 * `TextContentBlock` uses — changed same-day after real testing showed
 * the enum's top stop (`"3xl"`, 1.875rem/30px) couldn't even reach a
 * Hero headline's own *default* size (`text-4xl`/`sm:text-5xl`,
 * 36-48px), let alone exceed it. A headline can legitimately need
 * anywhere from small print to a huge display size depending on the
 * source design — a 6-stop enum can't cover that range the way it can
 * for a body-text field, so this one field gets a bounded numeric input
 * instead (see the popover's `RT_SIZE_MIN`/`RT_SIZE_MAX`). Still not
 * arbitrary CSS: one clamped number, applied as `fontSize` in px, same
 * inline-style mechanism as before. */
export type RichText = {
  content: string;
  color?: string;
  size?: number;
  weight?: TextWeight;
};

export type ThemeCta = {
  label: string;
  href: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "link";
  /** Added 2026-08-06 for CTE style editing — plain hex, applied as
   * inline `style` (same pattern `ButtonBlock` already uses for its own
   * colors). All three optional; unset means "use `variant`'s fixed
   * palette," so every existing CTA renders unchanged. `border_color` set
   * with no `background_color` reads as an outline-style button, same
   * convention as `ButtonBlock`. */
  background_color?: string;
  text_color?: string;
  border_color?: string;
  /** Added 2026-08-06, same fixed-stop pattern as `ButtonBlock.rounded`.
   * Unset keeps the Button component's own default (`rounded-lg`). */
  rounded?: "none" | "sm" | "lg" | "full";
  /** Added 2026-08-06 — overrides the fixed `size="lg"` every CTA button
   * rendered at before this existed. Unset keeps that same "lg" default,
   * so no existing page changes. */
  size?: "sm" | "default" | "lg";
  /** Added 2026-08-06. Only meaningful alongside `border_color`. */
  border_width?: "thin" | "thick";
};

export type HeroSection = {
  type: "hero";
  eyebrow?: string;
  headline: string | RichText;
  subheadline?: string | RichText;
  ctas?: ThemeCta[];
  /** Optional — when present, the hero renders two-column (text + image)
   * instead of centered text-only. `image.url` is usually just `"#"` (the
   * vision LLM can describe an image it sees but can't invent a working
   * URL for it) — HeroSection/ThemeImageBox render a placeholder in that
   * case, never a gap or a broken <img>. */
  image?: ThemeImage;
  /** Added 2026-08-05. Plain hex color (same controlled pattern as
   * `ContainerBlock.background_color`) for a colored banner-style hero —
   * without this, a hero with a distinct background color (e.g. a
   * full-width yellow strip behind just the headline/subheadline, common
   * right above a separate full-width photo section) had no way to be
   * represented at all; the hero always used the page's fixed neutral
   * background. */
  background_color?: string;
  /** Added 2026-08-05. Which side `image` renders on; defaults to
   * `"right"` (text first, image second — the only order this section
   * supported before this field existed, so every hero that omits it
   * renders unchanged). Mirrors `TextBlockSection.image_position`. */
  image_position?: "left" | "right";
};

export type FeatureItem = {
  title: string;
  description: string;
  href: string;
  icon?: string;
  /** Takes priority over `icon` when present — a real photo instead of a
   * line-art icon, for design blocks the source image showed as photos
   * (e.g. product/people shots) rather than iconography. */
  image?: ThemeImage;
  /** Added 2026-08-05. Only meaningful when `image` is set. "avatar"
   * renders `image` as a small circular headshot beside the title instead
   * of a large rectangular photo card — the testimonial/review pattern
   * (round profile photo + name + quote), which the plain rectangular
   * card ("photo", the default) doesn't fit at all. */
  image_style?: "photo" | "avatar";
  badge?: string;
};

export type FeatureGridSection = {
  type: "feature-grid";
  heading?: string | RichText;
  subheading?: string | RichText;
  /** Added 2026-08-05. Only meaningful for `layout: "split"` — a longer
   * supporting paragraph in the left column, below heading/subheading
   * (e.g. "We handle affidavits, acknowledgments, jurats..."). */
  body?: string | RichText;
  /** Added 2026-08-05. Only meaningful for `layout: "split"` — a single
   * button in the left column, below heading/subheading/body. */
  cta?: ThemeCta;
  items: FeatureItem[];
  columns?: 2 | 3 | 4;
  /** "split" puts heading/subheading in a left column and the item grid
   * in a right column, side by side, instead of stacking heading above a
   * full-width grid. Matches designs where a heading sits beside — not
   * above — its grid. */
  layout?: "stacked" | "split";
  /** Added 2026-08-05. Controls each item's visual chrome — "card" (the
   * default: rounded box with a border/background, the existing
   * avatar/photo/icon variants) vs "plain" (same grid/row arrangement as
   * "card", but no border/background — image position controlled by
   * `item_image_position`) vs "list" (ignores `columns` entirely: a
   * single-column vertical list of rows, a small image on the left and
   * text on the right, divided by a line between rows). Not every design
   * presents repeated items as cards. */
  item_style?: "card" | "plain" | "list";
  /** Only meaningful when `item_style` is "plain" — whether each item's
   * image renders above ("top", default) or below its text. */
  item_image_position?: "top" | "bottom";
};

export type CarouselSection = {
  type: "carousel";
  heading?: string;
  slides: ThemeImage[];
};

export type TextBlockSection = {
  type: "text-block";
  icon?: string;
  heading: string | RichText;
  body: string | RichText;
  align?: "left" | "center";
  /** Side-by-side text + image, like Hero's `image`. Ignored if
   * `background_image` is set (the two are mutually exclusive layouts). */
  image?: ThemeImage;
  image_position?: "left" | "right";
  /** Full-bleed photo behind the text with a dark overlay for legibility,
   * instead of the plain muted background — for designs where a section's
   * heading/body sits over a photo rather than beside or without one. */
  background_image?: ThemeImage;
};

export type CtaBannerSection = {
  type: "cta-banner";
  heading: string | RichText;
  body?: string | RichText;
  ctas: ThemeCta[];
};

export type BadgeListSection = {
  type: "badge-list";
  heading: string | RichText;
  badges: string[];
};

/** Generic, composable block primitives — added 2026-08-05 alongside
 * `ContainerBlock` below, distinct from the fixed composite sections
 * above (Hero, FeatureGrid, ...). Prompted by a concrete gap: a source
 * design with a row split into two 50/50 columns, each with its own
 * padding around an image+caption, has no composite section shape that
 * matches it — `generate_landing_page` could only approximate it as
 * padding on a couple of unrelated cards, losing the actual row/column
 * structure. `ContainerBlock` (row/column/grid, arbitrarily nestable)
 * exists to express layouts like that directly, with `ImageBlock` /
 * `TextContentBlock` / `ButtonBlock` as its children.
 *
 * Deliberately a SMALL, fixed set — this is not a general page-builder
 * block library (no input/textarea/select-type blocks; the chatbot
 * handles interactive/form needs elsewhere) and there's no free-form CSS
 * anywhere in it. Every style knob is a constrained enum or a plain hex
 * color string, the same "controlled, not open-ended" pattern
 * `GeneratedPage.accent_color` already established — a vision LLM (or a
 * human via CTE) can pick a color or a size, never write arbitrary CSS. */

/** How much of a `layout: "row"` container's width one child should take,
 * relative to its siblings — added 2026-08-05 for uneven splits (e.g. a
 * banner's headline column wider than its subheadline column). A small,
 * fixed set of discrete stops rather than an arbitrary fraction/percentage
 * on purpose: the exact ratio the vision LLM picks matters far less than
 * it reliably picking *some* reasonable uneven split when one exists —
 * matches the same "controlled options, not open-ended values" reasoning
 * as every other enum in this schema. "auto" (the default) means an equal
 * share among every sibling that's also "auto" — unchanged from this
 * schema's original behavior, so no existing saved page's rendering
 * changes just because this field now exists. Meaningless outside
 * `layout: "row"` (column/grid children size differently) — ignored
 * there. */
export type BlockWidth = "auto" | "1/4" | "1/3" | "1/2" | "2/3" | "3/4" | "full";

export type ImageBlock = {
  type: "image";
  image: ThemeImage;
  aspect_ratio?: "square" | "video" | "portrait" | "auto";
  rounded?: "none" | "sm" | "lg" | "full";
  width?: BlockWidth;
};

/** Named TextContentBlock, not TextBlock, to avoid colliding with
 * `TextBlockSection` above — that's a fixed composite (icon+heading+body,
 * optional image), this is a single, atomic run of styled text with no
 * fixed shape of its own. */
export type TextContentBlock = {
  type: "text";
  content: string;
  size?: TextSize;
  weight?: TextWeight;
  /** Hex color, e.g. "#c9a227" — same controlled-color pattern as
   * `accent_color`. Falls back to the theme's default text color when
   * unset, not literally forced to black/white. */
  color?: string;
  align?: "left" | "center" | "right";
  width?: BlockWidth;
};

export type ButtonBlock = {
  type: "button";
  label: string;
  href: string;
  background_color?: string;
  text_color?: string;
  /** When set, renders an outlined button in this color instead of a
   * filled one — border color and "is this outlined" are the same knob,
   * there's no separate filled-with-a-visible-border style. */
  border_color?: string;
  /** Added 2026-08-06, same fixed-stop pattern as `ImageBlock.rounded`.
   * Unset keeps the Button component's own default (`rounded-lg`). */
  rounded?: "none" | "sm" | "lg" | "full";
  /** Added 2026-08-06 — a small button reads very differently from a
   * hero CTA; both are common in real designs. Unset keeps whatever size
   * the rendering call site already hardcodes. */
  size?: "sm" | "default" | "lg";
  /** Added 2026-08-06. Only meaningful alongside `border_color`. Unset
   * (or "thin") is the existing 1px border every button already had;
   * "thick" is a heavier 2px border for designs with a bolder outline. */
  border_width?: "thin" | "thick";
  width?: BlockWidth;
  /** Added 2026-08-20 — lets an owner-composed block (Image/Text/Button
   * children inside a Container, see the root AGENTS.md's "Product
   * catalog + ordering" section for the full design) end in a real
   * add-to-cart action instead of only ever being a link. Unset (or
   * `"link"`) is this field's original, only behavior — `href` navigates,
   * unchanged. `"add_to_cart"` ignores `href` entirely and instead calls
   * the same deterministic `POST /api/cart/add` (lib/cart.ts) every other
   * add-to-cart control in this app already uses, for `product_id`. */
  action?: "link" | "add_to_cart";
  /** Only meaningful when `action === "add_to_cart"`. `null`/unset before
   * the owner picks one in the CTE editor — the button renders disabled
   * rather than silently adding nothing. */
  product_id?: number | null;
};

export type ContainerBlock = {
  type: "container";
  layout: "row" | "column" | "grid";
  /** Only meaningful for `layout: "grid"`. */
  columns?: 2 | 3 | 4;
  gap?: "none" | "sm" | "md" | "lg";
  padding?: "none" | "sm" | "md" | "lg";
  /** Added 2026-08-06 — CTE style-editing pass. Same fixed-stop pattern as
   * `padding` (space outside the container's own border, vs. `padding`'s
   * space inside it). Omitted/`"none"` renders exactly as before this
   * field existed. */
  margin?: "none" | "sm" | "md" | "lg";
  background_color?: string;
  /** Full-bleed background photo behind the container's children — same
   * "no real URL means a placeholder, never a gap" handling as every
   * other `ThemeImage` use in this schema (see `ThemeImageBox`). */
  background_image?: ThemeImage;
  border_color?: string;
  /** Cross-axis alignment for `row`/`column` layouts (e.g. a "row" with
   * `align: "center"` vertically centers shorter children next to a
   * taller one). Ignored for `grid`. */
  align?: "start" | "center" | "end" | "stretch";
  /** Added 2026-08-06. Main-axis alignment for `row`/`column` layouts —
   * `align`'s counterpart on the other axis. This is what actually lets a
   * container's content lean left/right (`row`) or top/bottom (`column`)
   * instead of only ever starting flush at the beginning of the axis.
   * Ignored for `grid`, same scope as `align`. Omitted keeps the original
   * "start" behavior every existing container already renders with. */
  justify?: "start" | "center" | "end" | "between";
  /** Added 2026-08-05. Only meaningful when this `ContainerBlock` is a
   * top-level `PageSection` (a nested one is already inside its parent's
   * box, so this would have nothing to break out of). Every section
   * normally renders inside the page's standard max-width `Container` —
   * `full_bleed: true` skips that wrapper for this one section, so it
   * spans the full viewport width edge-to-edge (e.g. a full-width banner
   * photo with no side whitespace). The container's own `padding`/`gap`
   * still apply as normal; this only removes the *page's* outer
   * constraint, not this container's own spacing. */
  full_bleed?: boolean;
  /** How much of the *parent* row's width this container itself should
   * take, when this container is a child inside another container's
   * `children` (see `BlockWidth`'s doc comment) — same field, same
   * meaning as on the leaf block types. */
  width?: BlockWidth;
  /** Added 2026-08-05. Without this, a container's height is purely
   * whatever its children/padding happen to add up to — fine for most
   * uses, but wrong for a `background_image` container meant to read as
   * a substantial photo block (a full-bleed hero banner, a photo card
   * with text overlaid on it): a couple of lines of text would otherwise
   * leave the photo far shorter than the design shows. A small fixed set
   * of stops, not an arbitrary pixel/rem value — same "controlled options"
   * reasoning as `width`/`BlockWidth`. Ignored (no min-height applied)
   * when unset, so every container without this field renders exactly as
   * before it existed. */
  min_height?: "sm" | "md" | "lg" | "xl" | "screen";
  /** Added 2026-08-20 — binds this whole container to one Product,
   * rendering a full-cover "stretched link" to `/products/{id}` behind
   * its children (a well-established card pattern: the link is a
   * positioned sibling covering the card, not a wrapper around the
   * content, so it never produces invalid `<button>`-inside-`<a>` HTML
   * even when a child `ButtonBlock` sets `action: "add_to_cart"` — that
   * button renders above the overlay via z-index and intercepts its own
   * clicks instead of triggering navigation). Lets an owner freely
   * compose Image/Text/Button children (see the root AGENTS.md's
   * "Product catalog + ordering" section) into a self-designed "product
   * promo" block — a homepage feature strip, a swiper slide — without a
   * dedicated, separately-designed component for it. `null`/unset
   * (every existing container) renders exactly as before this field
   * existed — a plain, non-linking container. */
  link_product_id?: number | null;
  children: Block[];
};

/** Added 2026-08-19 — a grid of product cards from the owner's Product
 * catalog (lib/products.ts), owner-inserted only via CTE (never
 * vision-generated — see backend/apis/agent.py's ProductListBlock
 * docstring). `tags` (2026-08-20, replaced the old single `category`
 * string — see backend/models.py's Product docstring) null/empty shows
 * every available product; set one or more to filter to products
 * carrying ANY of them (OR-matched against Product.tags).
 *
 * `product_ids` (2026-08-20) is a second, more specific filter — an
 * explicit ordered allow-list ("feature exactly these 3 products, in
 * this order," e.g. a homepage "bestsellers" strip) instead of "every
 * product with this tag." Takes priority over `tags` when both are
 * set — the two aren't meant to be combined, `product_ids` already names
 * exactly what should show. `null`/empty keeps the original
 * tags-or-everything behavior unchanged. */
export type ProductListBlock = {
  type: "product-list";
  tags?: string[] | null;
  product_ids?: number[] | null;
  width?: BlockWidth;
};

/** Added 2026-08-20 — a single product card, for featuring ONE product
 * somewhere a full grid doesn't fit (a homepage hero strip, a swiper
 * slide, a promo row) — the ProductList Block above is a grid, this is
 * its one-item counterpart. Owner-inserted only via CTE, same posture as
 * ProductListBlock (never vision-generated — a vision model has no way
 * to know which of the owner's real products a design mockup's "featured
 * product" placeholder is supposed to be). `product_id: null` (the
 * freshly-inserted default, before the owner picks one in the CTE
 * editor) renders an empty-state placeholder, never a broken fetch. */
export type ProductCardBlock = {
  type: "product-card";
  product_id: number | null;
  width?: BlockWidth;
};

/** Added 2026-08-21 — an embedded business-location map (backend/maps.py's
 * swappable provider abstraction). `query` is a plain place/address search
 * string, resolved into an embed URL at render time by `GET /api/map-embed`
 * — never baked into a stored embed URL, so changing the configured map
 * provider/key later doesn't require re-editing every page that already
 * has one. A plain "open in Google Maps" link is always rendered
 * alongside the embed (or in place of it, when no provider is
 * configured) — see components/theme/blocks/map-block.tsx. Owner-inserted
 * only via CTE, never vision-generated (a vision model has no way to know
 * a real business address from a design mockup). */
export type MapBlock = {
  type: "map";
  query: string;
  width?: BlockWidth;
};

export type Block =
  | ImageBlock
  | TextContentBlock
  | ButtonBlock
  | ContainerBlock
  | ProductListBlock
  | ProductCardBlock
  | MapBlock;

export type PageSection =
  | HeroSection
  | FeatureGridSection
  | CarouselSection
  | TextBlockSection
  | CtaBannerSection
  | BadgeListSection
  | ContainerBlock;

export type GeneratedPage = {
  sections: PageSection[];
  /** Hex color (e.g. "#c9a227"), the dominant/brand color the vision LLM
   * picked out of the design image. Applied by SectionRenderer as a CSS
   * custom-property override on `--primary` scoped to that render — it
   * retints existing components (buttons, badges, icons) rather than
   * opening the door to arbitrary generated CSS. snake_case to match the
   * backend's wire format (backend/apis/agent.py — no camelCase aliasing
   * anywhere in this API). */
  accent_color?: string;
};
