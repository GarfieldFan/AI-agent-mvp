"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { ArrayItemToolbar } from "@/components/theme/cte/array-item-toolbar";
import { BlockInsertMenu } from "@/components/theme/cte/block-insert-menu";
import { useCte } from "@/components/theme/cte/cte-context";
import { InsertGap } from "@/components/theme/cte/insert-gap";
import { ButtonBlock } from "@/components/theme/blocks/button-block";
import { ContainerBlock } from "@/components/theme/blocks/container-block";
import { ImageBlock } from "@/components/theme/blocks/image-block";
import { MapBlock } from "@/components/theme/blocks/map-block";
import { ProductCardBlock } from "@/components/theme/blocks/product-card-block";
import { ProductListBlock } from "@/components/theme/blocks/product-list-block";
import { TextContentBlock } from "@/components/theme/blocks/text-content-block";
import type { Block, BlockWidth } from "@/lib/theme";

// Only applied for `layout: "row"` (via `sizeForRow`) — column/grid
// children size differently (see BlockWidth's doc comment). "auto" keeps
// this schema's original equal-split behavior unchanged, so a row with
// no `width` set on any child renders exactly as it did before this
// field existed. Fixed-ratio items get `grow-0` so they never grow past
// their assigned share; `basis-full` below `sm` matches the row's own
// `flex-col sm:flex-row` breakpoint (mobile always stacks full-width
// regardless of `width`).
//
// **`shrink-0` removed, 2026-09-08 — a real overflow bug, caught by the
// user from a real screenshot, not hypothetical.** Two `width: "1/2"`
// children sum to exactly 100% of the row in *published/preview*
// rendering, so `shrink-0` never visibly did anything there (nothing to
// shrink away — 50%+50% already fits with zero overflow). But in *edit
// mode*, `BlockRenderer` inserts extra `InsertGap` "+"s as additional
// flex items in that SAME row (before/between/after the real children,
// itself `shrink-0` too) — now the row's total requested width is
// 50%+50%+(3 gaps' own width), genuinely over 100%, and with every item
// in the row refusing to shrink, the excess had nowhere to go but
// overflow past the row's own right edge (exactly the bug: a `width:
// "1/2"` child visibly spilling outside its full-bleed row's background).
// Dropping `shrink-0` (keeping `grow-0`) fixes this with no effect on
// the published/preview case — flex-shrink only ever activates when
// content genuinely exceeds the container, which never happens there
// (min-w-0 is what actually lets shrinking go below the content's own
// intrinsic width once it needs to). The one accepted trade-off: in edit
// mode specifically, an exact 50/50 split can now compress a little
// (e.g. 1/2 minus roughly half the gaps' combined width each) to make
// room for the insert-gap "+"s — a temporary, edit-only visual tweak,
// never reflected in what's actually saved/published, and a strictly
// better outcome than content spilling outside its own container.
//
// Lives here, not in container-block.tsx, since 2026-08-06 — this used
// to be passed down as a function prop (`itemClassName`), which broke
// the moment this component became a Client Component (`ContainerBlock`
// is still a Server Component; passing a function across that boundary
// fails RSC serialization — the exact gotcha the root AGENTS.md already
// documents for component/icon props). `sizeForRow` (a plain boolean) is
// serializable; the actual class lookup happens entirely on this side.
const WIDTH_CLASS: Record<BlockWidth, string> = {
  auto: "basis-full sm:flex-1 min-w-0",
  "1/4": "basis-full sm:basis-1/4 sm:grow-0 min-w-0",
  "1/3": "basis-full sm:basis-1/3 sm:grow-0 min-w-0",
  "1/2": "basis-full sm:basis-1/2 sm:grow-0 min-w-0",
  "2/3": "basis-full sm:basis-2/3 sm:grow-0 min-w-0",
  "3/4": "basis-full sm:basis-3/4 sm:grow-0 min-w-0",
  full: "basis-full min-w-0",
};

function renderBlock(block: Block, path: string, hideContainerBadge: boolean) {
  switch (block.type) {
    case "image":
      return <ImageBlock {...block} path={path} />;
    case "text":
      return <TextContentBlock {...block} path={path} />;
    case "button":
      return <ButtonBlock {...block} path={path} />;
    case "container":
      // hideContainerBadge is only ever true from renderItem's active
      // branch, which is already adding an equivalent edit button to the
      // ArrayItemToolbar wrapping this block — see that call site.
      return <ContainerBlock {...block} path={path} hideOwnBadge={hideContainerBadge} />;
    case "product-list":
      return <ProductListBlock {...block} path={path} />;
    case "product-card":
      return <ProductCardBlock {...block} path={path} />;
    case "map":
      return <MapBlock {...block} path={path} />;
    default:
      return null;
  }
}

type BlockRendererProps = {
  blocks: Block[];
  /** Dot-path to *this array itself* (e.g. "2.children" for a top-level
   * container section's children) — see lib/cte.ts's setByPath. Each
   * block's own editable path is derived as `${arrayPath}.${index}`, so
   * CTE can address any block at any nesting depth without a separate
   * addressing scheme from the rest of the schema. */
  arrayPath: string;
  /** True for a `layout: "row"` container — sizes each direct child from
   * its own `width` field (`BlockWidth`, lib/theme.ts) via `WIDTH_CLASS`
   * above, instead of every child defaulting to an even split.
   * "column"/"grid" layouts leave this unset (children size differently
   * there — see `WIDTH_CLASS`'s doc comment). */
  sizeForRow?: boolean;
};

/** Recursive dispatcher for the block primitives (components/theme/blocks/,
 * see lib/theme.ts's `Block` union) — mutually recursive with
 * ContainerBlock, which calls back into this for its own `children`. This
 * is the one piece of the schema that's a real tree, not a flat list;
 * every other section type in lib/theme.ts stays flat.
 *
 * **2026-08-06 (CTE part 7, Task 3)**: gained the same move/delete/insert
 * machinery `CteEditorPanel` already has for the top-level `sections`
 * array, generalized to work at any nesting depth via `lib/cte.ts`'s
 * path-aware `moveByPath`/`removeByPath`/`insertByPath` (reached through
 * `useCte()`'s `move`/`remove`/`insertAt`, not local state — this
 * component only owns *which insert gap is open*, never the sections
 * data itself). Outside edit mode this renders byte-for-byte what it
 * always did (no extra wrapper divs) — the toolbar/gap machinery is
 * entirely additive and gated on `useCte().active`. */
export function BlockRenderer({ blocks, arrayPath, sizeForRow }: BlockRendererProps) {
  const cte = useCte();
  const [insertAt, setInsertAt] = React.useState<number | null>(null);

  function renderItem(block: Block, index: number) {
    const path = `${arrayPath}.${index}`;
    const wrapperClass = sizeForRow ? WIDTH_CLASS[block.width ?? "auto"] : undefined;

    if (!cte.active) {
      const rendered = renderBlock(block, path, false);
      return wrapperClass ? (
        <div key={path} className={wrapperClass}>
          {rendered}
        </div>
      ) : (
        <React.Fragment key={path}>{rendered}</React.Fragment>
      );
    }

    // A container child gets its "edit the whole container" pencil
    // folded into this same toolbar (onEdit) instead of ContainerBlock's
    // own corner badge (suppressed via hideContainerBadge) — see
    // ArrayItemToolbar's 2026-08-06 doc comment for why.
    const isContainer = block.type === "container";
    return (
      // min-h-16 only in edit mode: an empty/near-empty child (most
      // visibly a freshly-inserted empty row's own children, or a plain
      // ContainerBlock with little content yet) would otherwise collapse
      // to a sliver too short for its own top-2 toolbar to fit inside
      // without overlapping its neighbors' — see InsertGap's 2026-08-06
      // doc comment for the matching row-stretch bug found the same way.
      //
      // pt-10, container children only: a nested container's *own*
      // BlockRenderer renders its first InsertGap flush at its own
      // top-left (nothing pushes it down when that nested container is
      // itself empty/short) — landing in the exact same screen area as
      // *this* wrapper's ArrayItemToolbar, which floats at its top-2/
      // left-2. Found from a real screenshot showing the two visually
      // overlapping. Leaf blocks (image/text/button) have no such
      // internal top-edge content competing with their own toolbar, so
      // they don't need the extra clearance.
      <div key={path} className={cn("group relative min-h-16", isContainer && "pt-10", wrapperClass)}>
        <ArrayItemToolbar
          path={path}
          disableBack={index === 0}
          disableForward={index === blocks.length - 1}
          onEdit={isContainer ? () => cte.select({ path, fieldType: "block-container", value: block }) : undefined}
        />
        {renderBlock(block, path, isContainer)}
      </div>
    );
  }

  if (!cte.active) {
    return <>{blocks.map((block, index) => renderItem(block, index))}</>;
  }

  return (
    <>
      <InsertGap onClick={() => setInsertAt(0)} />
      {blocks.map((block, index) => (
        <React.Fragment key={`gap-${arrayPath}.${index}`}>
          {renderItem(block, index)}
          <InsertGap onClick={() => setInsertAt(index + 1)} />
        </React.Fragment>
      ))}
      <BlockInsertMenu
        open={insertAt !== null}
        onOpenChange={(open) => {
          if (!open) setInsertAt(null);
        }}
        onInsert={(block) => {
          if (insertAt === null) return;
          cte.insertAt(arrayPath, insertAt, block);
          setInsertAt(null);
        }}
      />
    </>
  );
}
