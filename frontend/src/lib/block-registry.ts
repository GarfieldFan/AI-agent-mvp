import type { Block } from "@/lib/theme";

/** One entry per `Block` type — the `ContainerBlock.children` analogue of
 * `section-registry.ts`'s `SECTION_REGISTRY`, added 2026-08-06 (CTE part
 * 7) for `BlockInsertMenu`. Same declarative-`insertable`-flag pattern:
 * every current Block type is insertable, but the flag exists so a
 * future type with no CTE editing support yet (matching `carousel`'s
 * treatment in the section registry) has one place to opt out. */
export type BlockTypeDef = {
  type: Block["type"];
  label: string;
  description: string;
  insertable: boolean;
  createDefault: () => Block;
};

export const BLOCK_REGISTRY: BlockTypeDef[] = [
  {
    type: "text",
    label: "Text",
    description: "A run of styled text.",
    insertable: true,
    createDefault: () => ({ type: "text", content: "New text" }),
  },
  {
    type: "image",
    label: "Image",
    description: "A photo — upload, generate, or pick from the library after inserting.",
    insertable: true,
    createDefault: () => ({ type: "image", image: { url: "#", alt: "New image" } }),
  },
  {
    type: "button",
    label: "Button",
    description: "A single call-to-action button.",
    insertable: true,
    createDefault: () => ({ type: "button", label: "New button", href: "#" }),
  },
  {
    type: "container",
    label: "Row",
    description: "A nested row/column/grid — starts empty; insert more blocks into it the same way.",
    insertable: true,
    createDefault: () => ({ type: "container", layout: "row", gap: "md", children: [] }),
  },
  {
    type: "product-list",
    label: "Product list",
    description: "A grid of products from your catalog. Filter by tag, or pick specific products, after inserting.",
    insertable: true,
    createDefault: () => ({ type: "product-list" }),
  },
  {
    type: "product-card",
    label: "Product card",
    description: "One featured product — pick which one after inserting. For spotlighting a single item (a homepage strip, a swiper slide) instead of a whole grid.",
    insertable: true,
    createDefault: () => ({ type: "product-card", product_id: null }),
  },
];

export const INSERTABLE_BLOCK_TYPES = BLOCK_REGISTRY.filter((def) => def.insertable);
