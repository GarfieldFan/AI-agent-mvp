import Link from "next/link";
import type { CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Editable } from "@/components/theme/cte/editable";
import { themeButtonClassName } from "@/components/theme/theme-cta-style";
import type { ButtonBlock as ButtonBlockData } from "@/lib/theme";

/** A button with AI/CTE-controlled colors instead of the fixed variant
 * palette ThemeCta's buttons use — `background_color`/`text_color`/
 * `border_color` are plain hex strings applied as inline styles (same
 * controlled-color pattern as `accent_color`), not a new set of Tailwind
 * classes to maintain. `border_color` set with no `background_color`
 * renders as an outline-style button (transparent fill, colored border
 * and text) — there's no separate "filled but also has a visible border"
 * knob, that combination wasn't a real design case worth a third state.
 * `rounded`/`size`/`border_width` added 2026-08-06 — see
 * `theme-cta-style.ts`'s `themeButtonClassName`. */
export function ButtonBlock({
  label,
  href,
  background_color,
  text_color,
  border_color,
  rounded,
  size = "lg",
  border_width,
  width,
  path,
}: ButtonBlockData & { path: string }) {
  const style: CSSProperties = {};
  if (background_color) style.backgroundColor = background_color;
  if (text_color) style.color = text_color;
  if (border_color) style.borderColor = border_color;

  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-button"
      value={{ type: "button", label, href, background_color, text_color, border_color, rounded, size, border_width, width }}
    >
      <Button
        size={size}
        variant={border_color && !background_color ? "outline" : "default"}
        nativeButton={false}
        render={<Link href={href} />}
        className={themeButtonClassName({ size, rounded, border_width })}
        style={Object.keys(style).length > 0 ? style : undefined}
      >
        {label}
      </Button>
    </Editable>
  );
}
