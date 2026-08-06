"use client";

import { ArrowLeft, ArrowRight, Pencil, Trash2 } from "lucide-react";

import { useCte } from "@/components/theme/cte/cte-context";

/** Move-earlier/move-later/delete controls for one element of an array
 * this schema treats as a "reusable component list" — feature-item/cta
 * arrays, `ContainerBlock.children`. Added 2026-08-06 (CTE part 7) as a
 * shared component instead of duplicating the same three buttons at each
 * of those call sites. Self-gates on `useCte().active`, matching every
 * other CTE control (`Editable`, `AddItemButton`).
 *
 * Renders `position: absolute; top-2 left-2` — the caller must wrap the
 * item in a `relative` element (matching every other per-item toolbar in
 * this codebase, e.g. `CteEditorPanel`'s section-level one). Deliberately
 * the *left* corner: every fieldType's own pencil badge already claims
 * either the inline position (right after text/CTA content) or the
 * *right* corner (`top-2 right-2`, image/feature-item/block-*) — left
 * keeps this toolbar from ever colliding with it, the same convention
 * the section-level move/delete toolbar already established.
 *
 * "Move earlier/later," not direction-aware up/down/left/right icons —
 * these arrays render in different physical directions (a row's children
 * left-to-right, a stacked list top-to-bottom) and one icon pair can't be
 * visually correct for both; "earlier/later in the array" is the one
 * meaning that's always accurate regardless of layout.
 *
 * **2026-08-06 (CTE part 9)**: gained an optional `onEdit` — for a
 * `ContainerBlock` child specifically, `BlockRenderer` passes this
 * (alongside `hideOwnBadge` on the container itself, see `Editable`'s
 * doc comment) so "edit the whole container" lives in the *same* button
 * group as move/delete instead of a separate badge floating in the
 * opposite corner. Prompted directly by a real screenshot: a row of
 * several narrow nested columns put both toolbars close enough together
 * to look like visual noise rather than two distinct controls. Every
 * other caller (feature-item, cta) leaves `onEdit` unset — those already
 * have an adjacent pencil badge that reads fine on its own, since they're
 * leaf content, not a component with its own children to also expose.
 *
 * **2026-08-06 (CTE part 12) — hover-revealed**, same reasoning and same
 * `group`/`group-hover` mechanism as `InsertGap`'s matching change (see
 * its doc comment): a real screenshot with several nested items showed
 * every one of their toolbars visible simultaneously, more noise than
 * signal, and this codebase already has working precedent for hover-
 * reveal in an admin-only, desktop-oriented editing surface
 * (`page-generator-panel.tsx`'s `LockableSectionPreview`). **The caller
 * must add `group` to the `relative` wrapper it already provides** — this
 * component only supplies the `group-hover:opacity-100` half.
 *
 * **2026-08-06 (CTE part 13)**: the `onEdit` button dropped its
 * `bg-blue-600` and now shares move/delete's plain `bg-background/90`
 * style — the user's own call, once it sat inside this same grouped
 * toolbar rather than floating alone: a solid color made sense to
 * distinguish it from an *unrelated* pencil badge in the opposite corner
 * (the original part-8 problem), but once merged into one group, the
 * color read as inconsistent with its neighbors instead. `Editable`'s
 * *standalone* `block-container` badge (rendered when nothing merges it
 * — e.g. `PageGeneratorPanel`'s preview) keeps `bg-blue-600` unchanged —
 * that context still needs the color to stay distinguishable from an
 * adjacent child's own badge, the problem it was built to solve. */
export function ArrayItemToolbar({
  path,
  disableBack,
  disableForward,
  onEdit,
}: {
  /** Dot-path to *this item itself* (e.g. "1.items.2") — same addressing
   * `Editable`'s `path` uses. */
  path: string;
  disableBack?: boolean;
  disableForward?: boolean;
  onEdit?: () => void;
}) {
  const cte = useCte();
  if (!cte.active) return null;

  return (
    <div className="absolute top-2 left-2 z-20 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit this container"
          title="Edit this container"
          className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => cte.move(path, -1)}
        disabled={disableBack}
        aria-label="Move earlier"
        title="Move earlier"
        className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ArrowLeft className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => cte.move(path, 1)}
        disabled={disableForward}
        aria-label="Move later"
        title="Move later"
        className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ArrowRight className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => cte.remove(path)}
        aria-label="Delete this item"
        title="Delete this item"
        className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground"
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}
