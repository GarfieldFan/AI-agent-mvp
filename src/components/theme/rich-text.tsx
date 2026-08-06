import type { CSSProperties } from "react";

import type { RichText, TextWeight } from "@/lib/theme";

/** Normalizes a `string | RichText` field to its object form — a plain
 * string (every field's shape before RichText existed, and the only
 * shape the vision LLM ever produces) becomes `{ content: value }` with
 * no style overrides. */
export function resolveRichText(value: string | RichText): RichText {
  return typeof value === "string" ? { content: value } : value;
}

const FONT_WEIGHT_VALUE: Record<TextWeight, number> = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

/** `color`/`size`/`weight` overrides as an inline `style` object —
 * **2026-08-06, replaced an earlier Tailwind-class version
 * (`richTextClassName`) after a real bug**: several sections' default
 * classes include a responsive breakpoint variant (e.g. `HeroSection`'s
 * headline is `text-4xl ... sm:text-5xl`) — a plain override class like
 * `text-lg` lives in a different tailwind-merge "slot" than `sm:text-5xl`
 * and doesn't beat it, so a size override on that field visually did
 * nothing at normal desktop widths (`sm:text-5xl` kept winning) even
 * though the same override worked fine on fields with no responsive
 * variant. Inline styles have no such problem — they always win over any
 * class, regardless of breakpoint, since Tailwind's utilities never use
 * `!important`. Returns `{}` (not `undefined`) when nothing's set, so
 * spreading it into a `style` prop is always safe and a field with no
 * override renders with exactly its original classes untouched.
 *
 * `size` is a plain pixel number (see `RichText`'s doc comment for why
 * this isn't the small fixed enum every other size-ish field in this
 * schema uses) — applied directly as `px`, no unit conversion. */
export function richTextStyle(rt: Pick<RichText, "color" | "size" | "weight">): CSSProperties {
  const style: CSSProperties = {};
  if (rt.color) style.color = rt.color;
  if (rt.size) style.fontSize = `${rt.size}px`;
  if (rt.weight) style.fontWeight = FONT_WEIGHT_VALUE[rt.weight];
  return style;
}
