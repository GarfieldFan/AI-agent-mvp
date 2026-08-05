"use client";

import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCte } from "@/components/theme/cte/cte-context";
import type { EditableFieldType } from "@/lib/cte";

type AddItemButtonProps = {
  /** The array's own path (not an item within it), e.g. `${sectionIndex}.items`. */
  path: string;
  fieldType: EditableFieldType;
  /** Blank/starter content for the new item — same shape `value` would
   * carry for an existing item of this fieldType, prefilled into the same
   * CteEditorPopover form an edit would open. */
  defaultValue: unknown;
  label?: string;
  className?: string;
};

/** The "+" counterpart to Editable's per-item edit badges — opens the same
 * CteEditorPopover (in "create" mode, see lib/cte.ts's CteSelection) with
 * `defaultValue` prefilled; saving appends rather than replaces. Self-
 * gates on edit mode (renders nothing outside it), so call sites don't
 * need their own `useCte()` check. Deliberately limited to *items within
 * an already-existing array field* (feature-grid items, CTA buttons) —
 * not whole new sections. Inserting/reordering/deleting entire sections
 * would push CTE from "touch up what's there" toward a general page
 * builder, which overlaps with PageGeneratorPanel's job and was an
 * explicit scope call the user made when this was discussed (see the
 * root AGENTS.md's CTE section) — a WordPress-style "only the reusable
 * blocks we ship" ceiling, not full free-form authoring. */
export function AddItemButton({ path, fieldType, defaultValue, label = "Add", className }: AddItemButtonProps) {
  const cte = useCte();
  if (!cte.active) return null;

  return (
    <button
      type="button"
      onClick={() => cte.select({ path, fieldType, value: defaultValue, mode: "create" })}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-primary/40 text-sm text-primary/70 transition hover:border-primary hover:bg-primary/5 hover:text-primary",
        className,
      )}
    >
      <Plus className="size-4" />
      {label}
    </button>
  );
}
