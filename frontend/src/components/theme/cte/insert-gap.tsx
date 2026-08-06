import { Plus } from "lucide-react";

/** A small "+" between array items — added 2026-08-06 (CTE part 7),
 * originally local to `CteEditorPanel` for the `sections` array, pulled
 * out here so `BlockRenderer` can reuse the same affordance for
 * `ContainerBlock.children`. Callers are responsible for only rendering
 * this while `useCte().active` — it has no such check of its own since
 * some callers (`CteEditorPanel`) gate a whole block of JSX on edit mode
 * already, and adding a second check here would be redundant, not
 * defensive.
 *
 * **2026-08-06 (CTE part 9) real bug, from a screenshot**: the original
 * version had a fixed `h-4` height plus a full-width absolute divider
 * line — reasonable for `CteEditorPanel`'s vertical section list, but
 * inside a `ContainerBlock`'s `layout: "row"` (a horizontal flex
 * container), this component is just another flex item — with
 * `align-items: stretch` (the row's own default), it stretched to match
 * its siblings' full height, and the divider line stretched with it,
 * producing a criss-crossed mess of lines/badges rather than a small
 * floating "+". Fixed by dropping the divider line entirely (it was
 * cosmetic, not load-bearing — the "+" alone is a clear enough insert
 * point) and adding `self-center shrink-0` so this never stretches to
 * match a flex row's cross-axis height regardless of the parent's own
 * `align`, plus real padding (`px-3 py-3`) so it can't visually touch
 * whatever's on either side of it, matching the breathing room the
 * page-section list already had from normal block-flow spacing.
 *
 * **2026-08-06 (CTE part 12) — hover-revealed, reversing the earlier
 * "always visible" call.** That original call (see the deleted
 * doc-comment history) was made to avoid a discoverability regression on
 * touch devices; it was the right call *for the pencil edit badges*
 * (`Editable`, still always-visible, unchanged) but turned out wrong for
 * insert gaps specifically once nesting got a few levels deep — a real
 * screenshot showed 4+ "+" buttons simultaneously visible around just 3
 * small nested rows, more noise than signal. `/editor` is an admin-only
 * surface used from a desktop browser in practice (not the touch-first
 * public site the original mobile concern was about), and this codebase
 * already has precedent for hover-reveal working fine in exactly this
 * kind of internal tool (`page-generator-panel.tsx`'s
 * `LockableSectionPreview`). `opacity-0 group-hover:opacity-100` on a
 * local `group` (this component's own small footprint, not a shared
 * ancestor) — hovering the gap's own area reveals it; the pencil badges
 * that actually drive "what can I edit" discovery are untouched. */
export function InsertGap({ onClick }: { onClick: () => void }) {
  return (
    <div className="group flex shrink-0 basis-auto items-center justify-center self-center px-3 py-3">
      <button
        type="button"
        onClick={onClick}
        aria-label="Insert here"
        title="Insert here"
        className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition group-hover:opacity-100 group-focus-within:opacity-100 hover:brightness-110"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
