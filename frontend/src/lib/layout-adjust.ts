import { apiFetch } from "@/lib/api";
import type { Block, ContainerBlock } from "@/lib/theme";

export type LayoutAdjustChildSummary = { kind: string; summary: string };

export type LayoutAdjustSuggestion = {
  layout: ContainerBlock["layout"];
  gap: NonNullable<ContainerBlock["gap"]>;
  padding: NonNullable<ContainerBlock["padding"]>;
  margin: NonNullable<ContainerBlock["margin"]>;
  align: NonNullable<ContainerBlock["align"]>;
  justify: ContainerBlock["justify"] | null;
  min_height: ContainerBlock["min_height"] | null;
  reasoning: string;
};

/** One-level, non-recursive summary of a container's direct child — just
 * enough for the layout-adjust model to reason about proportions ("a
 * short heading next to a long paragraph"), never enough to let it
 * reconstruct or rewrite the child itself (it never gets the child's
 * full object, only this). */
function summarizeChild(block: Block): LayoutAdjustChildSummary {
  switch (block.type) {
    case "text":
      return { kind: "text", summary: block.content.slice(0, 100) };
    case "image":
      return { kind: "image", summary: block.image.alt.slice(0, 100) || "(no description)" };
    case "button":
      return { kind: "button", summary: block.label };
    case "container":
      return {
        kind: `nested ${block.layout} container (${block.children.length} item${block.children.length === 1 ? "" : "s"})`,
        summary: block.background_image ? "has its own background image" : "",
      };
    case "product-list":
      return { kind: "product list", summary: "" };
    case "product-card":
      return { kind: "product card", summary: "" };
    case "map":
      return { kind: "map", summary: block.query };
  }
}

/** POST /api/agent/pages/ai-adjust-layout — admin/owner. The "local area"
 * layout-adjust action from CteEditorPopover's block-container form: asks
 * an LLM to suggest better values for this ONE container's own style
 * fields (layout/gap/padding/margin/align/justify/min_height), given a
 * plain summary of what it holds — never its content, never its
 * structure (no add/remove/reorder). See the root AGENTS.md's CTE section
 * for the full design and why this is deliberately narrower than the
 * whole-page AI-fill content step. */
export function requestLayoutAdjust(container: ContainerBlock, instruction: string) {
  return apiFetch<LayoutAdjustSuggestion>("/api/agent/pages/ai-adjust-layout", {
    method: "POST",
    body: {
      instruction,
      container: {
        layout: container.layout,
        gap: container.gap ?? "md",
        padding: container.padding ?? "none",
        margin: container.margin ?? "none",
        align: container.align ?? "stretch",
        justify: container.justify ?? null,
        min_height: container.min_height ?? null,
        full_bleed: container.full_bleed ?? false,
        has_background_image: Boolean(container.background_image),
        has_background_color: Boolean(container.background_color),
      },
      children: container.children.map(summarizeChild),
    },
  });
}
