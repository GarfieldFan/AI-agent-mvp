import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { BlockRenderer } from "@/components/theme/blocks/block-renderer";
import { Editable } from "@/components/theme/cte/editable";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { ContainerBlock as ContainerBlockData } from "@/lib/theme";

const GAP_CLASS: Record<NonNullable<ContainerBlockData["gap"]>, string> = {
  none: "gap-0",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-8",
};

const PADDING_CLASS: Record<NonNullable<ContainerBlockData["padding"]>, string> = {
  none: "p-0",
  sm: "p-3",
  md: "p-6",
  lg: "p-10",
};

// Same fixed-stop scale as PADDING_CLASS, applied outside the border
// instead of inside it. "none" (the default when unset) is a genuine
// no-op class, not just an absent one, so every existing container that
// predates this field keeps rendering byte-for-byte.
const MARGIN_CLASS: Record<NonNullable<ContainerBlockData["margin"]>, string> = {
  none: "m-0",
  sm: "m-3",
  md: "m-6",
  lg: "m-10",
};

const ALIGN_CLASS: Record<NonNullable<ContainerBlockData["align"]>, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

// justify's counterpart to ALIGN_CLASS above — main-axis instead of
// cross-axis. Only meaningful for row/column (same scope as align);
// grid never reads this.
const JUSTIFY_CLASS: Record<NonNullable<ContainerBlockData["justify"]>, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};

const GRID_COLUMN_CLASS: Record<NonNullable<ContainerBlockData["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

// A container's height is otherwise purely content-driven — these give a
// background_image container (a hero banner, a photo card with text
// overlaid) a guaranteed minimum footprint regardless of how little text
// its children add up to. Values chosen for the two concrete uses this
// was built for: "lg" reads as a real hero band, "sm" as a grid card.
const MIN_HEIGHT_CLASS: Record<NonNullable<ContainerBlockData["min_height"]>, string> = {
  sm: "min-h-64",
  md: "min-h-80",
  lg: "min-h-[28rem]",
  xl: "min-h-[36rem]",
  screen: "min-h-screen",
};

/** A row/column/grid layout primitive that holds other blocks — including
 * more containers, so a "row of two padded columns, each with an image
 * and a caption" (the concrete design gap this was built for — see
 * lib/theme.ts's doc comment) is just a 2-level nesting, not a special
 * case. `layout: "row"` sizes each direct child from that child's own
 * `width` field (`BlockWidth`, added 2026-08-05 for uneven splits like a
 * banner's headline column being wider than its subheadline column) via
 * `BlockRenderer`'s `sizeForRow` (passed as `layout === "row"`) — every
 * child left at the default `"auto"` still splits the row evenly among
 * themselves, same as
 * before this field existed. Reused as both a top-level PageSection
 * (SectionRenderer has a "container" case) and a nested Block — same
 * component, same shape, either way. */
export function ContainerBlock({
  layout,
  columns = 2,
  gap = "md",
  padding = "none",
  margin = "none",
  background_color,
  background_image,
  border_color,
  align = "stretch",
  justify,
  min_height,
  width,
  full_bleed,
  path,
  children,
  hideOwnBadge,
}: ContainerBlockData & { path: string; hideOwnBadge?: boolean }) {
  // A "column" container that's both tall (min_height) and sitting over a
  // photo (background_image) reads as a hero-banner/photo-card pattern —
  // anchor its children to the bottom rather than leaving them stranded
  // at the top of all that extra height. An explicit `justify` always
  // wins over this default; it only fills in when the field's unset.
  const isOverlayBanner = layout === "column" && Boolean(background_image) && Boolean(min_height);
  const resolvedJustify = justify ?? (isOverlayBanner ? "end" : "start");

  const layoutClass =
    layout === "row"
      ? cn("flex flex-col sm:flex-row", ALIGN_CLASS[align], JUSTIFY_CLASS[resolvedJustify])
      : layout === "grid"
        ? cn("grid", GRID_COLUMN_CLASS[columns])
        : cn("flex flex-col", ALIGN_CLASS[align], JUSTIFY_CLASS[resolvedJustify]);

  const style: CSSProperties = {};
  if (background_color) style.backgroundColor = background_color;
  if (border_color) style.borderColor = border_color;

  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-container"
      hideBadge={hideOwnBadge}
      value={{
        type: "container",
        layout,
        columns,
        gap,
        padding,
        margin,
        background_color,
        background_image,
        border_color,
        align,
        justify,
        min_height,
        width,
        full_bleed,
        children,
      }}
      className={cn(
        "relative w-full",
        layoutClass,
        GAP_CLASS[gap],
        PADDING_CLASS[padding],
        MARGIN_CLASS[margin],
        border_color && "border",
        min_height && MIN_HEIGHT_CLASS[min_height],
      )}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      {background_image ? (
        <div className="absolute inset-0 -z-10">
          <ThemeImageBox image={background_image} className="h-full w-full" />
        </div>
      ) : null}
      <BlockRenderer blocks={children} arrayPath={`${path}.children`} sizeForRow={layout === "row"} />
    </Editable>
  );
}
