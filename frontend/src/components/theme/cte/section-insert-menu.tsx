"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { INSERTABLE_SECTION_TYPES } from "@/lib/section-registry";
import type { PageSection } from "@/lib/theme";

/** The "+" insert picker — opened from a gap between (or before/after)
 * sections in `CteEditorPanel`. Same `Sheet` component and visual
 * language as `CteEditorPopover` (the pencil-badge editor), per the
 * user's explicit request that "+" should feel like the same
 * interaction, just showing a type list instead of a value form.
 *
 * Deliberately a flat list, not tabs, for now — `INSERTABLE_SECTION_TYPES`
 * only has 6 entries today. Revisit with tabs (grouped by function) once
 * a picker actually needs to show enough types that a flat list gets
 * unwieldy — e.g. once the container-children picker (image/text/button/
 * container) is built alongside this one. */
export function SectionInsertMenu({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (section: PageSection) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showOverlay={false}>
        <SheetHeader>
          <SheetTitle>Insert a section</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Inserted here with a minimal default — fine-tune it with the pencil editor afterward.
          </p>
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto px-4">
          {INSERTABLE_SECTION_TYPES.map((def) => (
            <button
              key={def.type}
              type="button"
              onClick={() => {
                onInsert(def.createDefault());
                onOpenChange(false);
              }}
              className="w-full rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/50"
            >
              <p className="text-sm font-medium">{def.label}</p>
              <p className="text-xs text-muted-foreground">{def.description}</p>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
