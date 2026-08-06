import type { PageSection } from "@/lib/theme";

/** One entry per `PageSection` type, added 2026-08-06 for the CTE "+"
 * insert picker (`SectionInsertMenu`) — the user's own suggestion,
 * instead of hardcoding the insertable type list directly in that
 * component: a declarative `insertable` flag here is the single source
 * of truth for "can this go in the + list," so adding a new section type
 * later doesn't require also remembering to touch the picker UI, and a
 * type that isn't safe to blind-insert (see `carousel` below) can be
 * excluded in one place rather than special-cased at every call site
 * that lists section types. */
export type SectionTypeDef = {
  type: PageSection["type"];
  label: string;
  description: string;
  /** False for section types that exist in the schema/renderer but have
   * no CTE editing support to actually fill them in afterward — inserting
   * one would be a dead end. Currently only `carousel` (slides aren't
   * CTE-editable yet, see the root AGENTS.md's CTE scope-cut notes). */
  insertable: boolean;
  createDefault: () => PageSection;
};

export const SECTION_REGISTRY: SectionTypeDef[] = [
  {
    type: "hero",
    label: "Hero",
    description: "Large headline, optional subheadline and buttons.",
    insertable: true,
    createDefault: () => ({
      type: "hero",
      headline: "New headline",
      subheadline: "A short supporting line.",
      ctas: [{ label: "Learn more", href: "#" }],
    }),
  },
  {
    type: "feature-grid",
    label: "Feature grid",
    description: "A heading plus a grid of repeated items (cards, list, or plain).",
    insertable: true,
    createDefault: () => ({
      type: "feature-grid",
      heading: "New heading",
      items: [
        { title: "First item", description: "Describe it here.", href: "#" },
        { title: "Second item", description: "Describe it here.", href: "#" },
      ],
      columns: 3,
    }),
  },
  {
    type: "text-block",
    label: "Text block",
    description: "A heading and a paragraph, optionally beside or behind an image.",
    insertable: true,
    createDefault: () => ({
      type: "text-block",
      heading: "New heading",
      body: "New body text.",
    }),
  },
  {
    type: "cta-banner",
    label: "CTA banner",
    description: "A closing call-to-action with one or more buttons.",
    insertable: true,
    createDefault: () => ({
      type: "cta-banner",
      heading: "Ready to get started?",
      ctas: [{ label: "Contact us", href: "#" }],
    }),
  },
  {
    type: "badge-list",
    label: "Badge list",
    description: "A heading and a row of short badges (e.g. a tech-stack list).",
    insertable: true,
    createDefault: () => ({
      type: "badge-list",
      heading: "New heading",
      badges: ["Badge one", "Badge two"],
    }),
  },
  {
    type: "container",
    label: "Row",
    description: "A generic row/column/grid container — inserted empty; use the \"+\" inside it to add columns (text, image, button, or another row), and the pencil editor for layout/spacing.",
    insertable: true,
    createDefault: () => ({
      type: "container",
      layout: "row",
      gap: "md",
      children: [],
    }),
  },
  {
    type: "carousel",
    label: "Carousel",
    description: "Not insertable yet — slide content has no CTE editing support.",
    insertable: false,
    createDefault: () => ({ type: "carousel", slides: [] }),
  },
];

export const INSERTABLE_SECTION_TYPES = SECTION_REGISTRY.filter((def) => def.insertable);
