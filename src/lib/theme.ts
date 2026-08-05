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

export type ThemeCta = {
  label: string;
  href: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "link";
};

export type HeroSection = {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subheadline?: string;
  ctas?: ThemeCta[];
  /** Optional — when present, the hero renders two-column (text + image)
   * instead of centered text-only. `image.url` is usually just `"#"` (the
   * vision LLM can describe an image it sees but can't invent a working
   * URL for it) — HeroSection/ThemeImageBox render a placeholder in that
   * case, never a gap or a broken <img>. */
  image?: ThemeImage;
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
  badge?: string;
};

export type FeatureGridSection = {
  type: "feature-grid";
  heading?: string;
  subheading?: string;
  items: FeatureItem[];
  columns?: 2 | 3 | 4;
  /** "split" puts heading/subheading in a left column and the item grid
   * in a right column, side by side, instead of stacking heading above a
   * full-width grid. Matches designs where a heading sits beside — not
   * above — its grid. */
  layout?: "stacked" | "split";
};

export type CarouselSection = {
  type: "carousel";
  heading?: string;
  slides: ThemeImage[];
};

export type TextBlockSection = {
  type: "text-block";
  icon?: string;
  heading: string;
  body: string;
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
  heading: string;
  body?: string;
  ctas: ThemeCta[];
};

export type BadgeListSection = {
  type: "badge-list";
  heading: string;
  badges: string[];
};

export type PageSection =
  | HeroSection
  | FeatureGridSection
  | CarouselSection
  | TextBlockSection
  | CtaBannerSection
  | BadgeListSection;

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
