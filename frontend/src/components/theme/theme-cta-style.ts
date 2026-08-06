import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import type { ThemeCta } from "@/lib/theme";

/** Optional inline-style override for a `ThemeCta` button, added
 * 2026-08-06 for CTE style editing — `variant` (the existing fixed
 * palette) still picks the button's base look; these three plain-hex
 * colors, when set, apply as inline `style` on top, which naturally wins
 * over the variant's own Tailwind classes via normal CSS specificity, no
 * extra logic needed. Returns `undefined` (not an empty object) when
 * nothing's set, so a CTA with no color overrides renders exactly as
 * before this existed. */
export function themeCtaStyle(cta: ThemeCta): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (cta.background_color) style.backgroundColor = cta.background_color;
  if (cta.text_color) style.color = cta.text_color;
  if (cta.border_color) style.borderColor = cta.border_color;
  return Object.keys(style).length > 0 ? style : undefined;
}

const ROUNDED_CLASS: Record<"none" | "sm" | "lg" | "full", string> = {
  none: "rounded-none",
  sm: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

/** `Button`'s own `size` variants (`sm`/`default`/`lg`) only differ by
 * 1px of height (`h-7`/`h-8`/`h-9`) and never change font size at all —
 * `text-sm` is baked into every size via the shared base class. Fine for
 * a dense admin UI, not for a marketing-page CTA where "small" vs "large"
 * button should actually read as different at a glance. These three
 * override height/padding/font-size together, appended after `Button`'s
 * own classes in `cn(...)` so tailwind-merge lets them win (same pattern
 * as `richTextClassName`). Still just three fixed stops, not an
 * arbitrary size — same controlled-enum principle as everywhere else in
 * this schema. */
const BUTTON_SIZE_CLASS: Record<"sm" | "default" | "lg", string> = {
  sm: "h-8 px-3 text-sm",
  default: "h-10 px-5 text-base",
  lg: "h-12 px-7 text-lg",
};

/** `size`/`rounded`/`border_width` as Tailwind classes, appended after
 * the Button component's own base classes in a `cn(...)` call — same
 * tailwind-merge "later class wins" resolution `richTextClassName` uses
 * (see `rich-text.tsx`). Every shadcn `Button` variant already carries a
 * base `border` (1px, usually `border-transparent`) regardless of
 * `variant`, so `border_color` alone is always visible once set — this
 * only needs to act when `border_width` asks for something heavier than
 * that default. Shared by both `ThemeCta`-rendered buttons and
 * `ButtonBlock` — same three fields, same meaning, on both types. */
export function themeButtonClassName(button: {
  size?: "sm" | "default" | "lg";
  rounded?: "none" | "sm" | "lg" | "full";
  border_width?: "thin" | "thick";
}): string {
  return cn(
    button.size && BUTTON_SIZE_CLASS[button.size],
    button.rounded && ROUNDED_CLASS[button.rounded],
    button.border_width === "thick" && "border-2",
  );
}
