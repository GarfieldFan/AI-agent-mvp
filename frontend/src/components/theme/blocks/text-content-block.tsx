import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { Editable } from "@/components/theme/cte/editable";
import type { TextContentBlock as TextContentBlockData } from "@/lib/theme";

const SIZE_CLASS: Record<NonNullable<TextContentBlockData["size"]>, string> = {
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
  "3xl": "text-3xl",
};

const WEIGHT_CLASS: Record<NonNullable<TextContentBlockData["weight"]>, string> = {
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
};

const ALIGN_CLASS: Record<NonNullable<TextContentBlockData["align"]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** A single, atomic run of styled text — deliberately no fixed shape of
 * its own (no heading/body split like TextBlockSection), just content +
 * a handful of controlled typography knobs. `color` is a plain hex
 * string, same pattern as `GeneratedPage.accent_color` — no arbitrary
 * CSS, just a color value. */
export function TextContentBlock({
  content,
  size = "base",
  weight = "normal",
  color,
  align = "left",
  width,
  path,
}: TextContentBlockData & { path: string }) {
  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-text"
      value={{ type: "text", content, size, weight, color, align, width }}
    >
      <p
        className={cn(SIZE_CLASS[size], WEIGHT_CLASS[weight], ALIGN_CLASS[align], !color && "text-foreground")}
        style={color ? ({ color } as CSSProperties) : undefined}
      >
        {content}
      </p>
    </Editable>
  );
}
