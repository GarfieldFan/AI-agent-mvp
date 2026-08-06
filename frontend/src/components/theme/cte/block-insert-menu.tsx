"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { INSERTABLE_BLOCK_TYPES } from "@/lib/block-registry";
import type { Block } from "@/lib/theme";

/** The "+" insert picker for `ContainerBlock.children` — the
 * `SectionInsertMenu` of the Block system, added 2026-08-06 (CTE part 7,
 * Task 3). Same `Sheet` and flat-list pattern; kept as a separate
 * component rather than generalizing `SectionInsertMenu` since the two
 * pick from genuinely different registries (`PageSection` types vs.
 * `Block` types) with no shared shape worth abstracting over for just
 * two call sites. */
export function BlockInsertMenu({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (block: Block) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showOverlay={false}>
        <SheetHeader>
          <SheetTitle>Insert a block</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Inserted here with a minimal default — fine-tune it with the pencil editor afterward.
          </p>
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto px-4">
          {INSERTABLE_BLOCK_TYPES.map((def) => (
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
