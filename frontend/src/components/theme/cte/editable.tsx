"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCte } from "@/components/theme/cte/cte-context";
import type { EditableFieldType } from "@/lib/cte";
import type { TextWeight } from "@/lib/theme";

// Nearest named TextWeight for a CSS `font-weight` computed value (a
// numeric string like "400"/"600"/"700" in every modern browser) —
// matches Tailwind's own font-normal/medium/semibold/bold scale.
function weightFromComputed(value: string): TextWeight | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric >= 700) return "bold";
  if (numeric >= 600) return "semibold";
  if (numeric >= 500) return "medium";
  return "normal";
}

// `getComputedStyle(...).color` always resolves to `rgb(r, g, b)` (or
// `rgba(...)`), never a hex string — converted here since `ColorField`'s
// `<input type="color">` needs hex.
function rgbToHex(value: string): string | undefined {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return undefined;
  const [, r, g, b] = match;
  return "#" + [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

/** Reads the *actual currently-rendered* size/weight/color of a rich-text
 * field straight off its DOM node — added 2026-08-06 at the user's
 * request ("CTE 里应该有一个当前值，而不是 default 或者 unset"). Unlike
 * most other style fields in this schema (`ContainerBlock.layout`
 * defaults to a single fixed "row", `TextContentBlock.weight` to
 * "normal", ...), `RichText`'s "unset" state has no *one* universal
 * default to show — Hero's headline, a FeatureGrid heading, and a
 * CtaBanner body each render at a different hardcoded size/weight/color
 * of their own. Reading it off the live element is the only way to show
 * "what this looks like right now" without threading a bespoke default
 * spec through every one of the 5 fixed sections. Purely a display hint
 * (see `CteSelection.computedDefaults`'s doc comment) — never written
 * back unless the user actually keeps/changes the value. */
function readComputedRichTextDefaults(el: HTMLElement | null): { size?: number; weight?: TextWeight; color?: string } {
  if (!el) return {};
  const computed = window.getComputedStyle(el);
  const size = Math.round(parseFloat(computed.fontSize));
  return {
    size: Number.isFinite(size) ? size : undefined,
    weight: weightFromComputed(computed.fontWeight),
    color: rgbToHex(computed.color),
  };
}

type EditableProps = {
  /** Dot-path into the page's `sections` array this click should edit —
   * see lib/cte.ts's setByPath. */
  path: string;
  fieldType: EditableFieldType;
  /** Current value at `path`, passed through untouched to the editor
   * sheet (see cte-editor-popover.tsx) — read from the same section data
   * each call site already has in scope, not re-derived from `path`. */
  value: unknown;
  /** "div" for block-level children (an image box, a whole card) — using
   * the wrong one can produce invalid nesting (e.g. a span around a div).
   * Defaults to "span" since most editable content here is inline text. */
  as?: "span" | "div";
  /** For block-level usages this often carries essential layout (aspect
   * ratio, `overflow-hidden`, `rounded-*`) that used to live on a plain,
   * always-rendered wrapper `div` before Editable existed — see the
   * 2026-08-05 bugfix note below for why this must be applied even when
   * edit mode is off, not just when the badge renders. */
  className?: string;
  /** Added 2026-08-06 for `ContainerBlock`'s `background_color`/
   * `border_color` (inline styles, not Tailwind classes — see
   * `ContainerBlock`'s own doc comment for why) — needs the same
   * always-applied-regardless-of-edit-mode treatment as `className`
   * above, for the same reason. */
  style?: React.CSSProperties;
  /** Added 2026-08-06 (CTE part 9) for `ContainerBlock` specifically:
   * when a container is rendered as another array's child (`BlockRenderer`
   * already wraps it in `ArrayItemToolbar`, which grows an `onEdit` button
   * for exactly this case), suppress this component's own corner badge so
   * "edit the whole container" isn't offered twice in two different
   * corners — the outer toolbar's pencil is the one true entry point.
   * Outline styling still renders (so the dashed border stays visible);
   * only the clickable badge button itself is omitted. Every other
   * fieldType leaves this unset. */
  hideBadge?: boolean;
  children: React.ReactNode;
};

/** Wraps one logical, independently-editable piece of section content — a
 * headline, an image, a whole feature-grid item, a CTA button — with a
 * click-to-edit affordance. Outside edit mode (`useCte().active === false`
 * — either no CteProvider above it at all, i.e. every public route, or
 * the "Edit mode" Switch in CteEditorPanel is off), renders `children`
 * with `className` still applied but no outline/badge/click handling —
 * see the bugfix note below for why this can't collapse to a bare
 * `<>{children}</>` whenever `className` is doing real layout work.
 *
 * **2026-08-04 redesign, replacing an earlier hover-revealed /
 * whole-block-clickable version**: two real problems with that version —
 * (1) hover doesn't exist on touch devices, so mobile had no way to
 * discover what was editable; (2) wrapping the *entire* block as one
 * click target broke down for stacked/overlapping content (e.g.
 * TextBlockSection's background_image with heading/body text on top of
 * it) — a click could only ever resolve to whichever element happened to
 * be on top, so "I meant to edit the image" silently opened the text
 * editor instead, with no way to reach the image at all.
 *
 * Fixed by switching to a small, explicit pencil-icon button *rendered
 * inline next to* (text/CTA fields — small enough that a corner badge
 * would overlap the content itself) or *pinned to a corner of* (image,
 * feature-item — large enough that a corner badge has room) each field's
 * own content, always visible while edit mode is on (no hover needed) —
 * and, critically, rendered as a DOM **sibling** of `children`, never
 * nested inside it. That sibling relationship is what actually fixes the
 * stacked-element problem: the background image's badge and the
 * heading's badge now live in genuinely different positions (section
 * corner vs. inline after the heading text) instead of competing for the
 * same click area. It's also why a badge nested inside a `<Link>`
 * (feature cards, CTA buttons) never triggers that link's navigation —
 * being a sibling, its click never reaches the anchor at all;
 * `stopPropagation`/`preventDefault` below are defensive, not
 * load-bearing.
 *
 * **2026-08-05 bugfix, found from a real screenshot**: the original
 * version's inactive path was a bare `return <>{children}</>` — for
 * `as="span"` text fields that's harmless (no wrapper existed before
 * Editable either), but for `as="div"` block fields it silently dropped
 * `className` entirely, and that `className` is often load-bearing
 * layout (e.g. HeroSection's image wrapper carries `aspect-[4/3]
 * overflow-hidden rounded-2xl` — before Editable existed this was a
 * plain, always-rendered `div`). The result: every image lost its aspect
 * ratio, clipping, and border radius the instant edit mode was off —
 * which is the *default* state on every public route and on `/editor`
 * itself before the Switch is flipped, so the regression was live
 * essentially everywhere. Fixed by always rendering the wrapping `Tag`
 * with `className` applied when one was given; only the outline/badge is
 * actually conditional on edit mode now. Also fixed the same real
 * screenshot's other two complaints: the corner badge used to hang half
 * outside its box via negative offsets (`-top-2 -right-2`), which got
 * silently clipped by any wrapped content that also set
 * `overflow-hidden` (exactly the image case) — moved to a fully-inset
 * position (`top-2 right-2`) so it can never be clipped regardless of
 * what the wrapped content's own overflow/rounding does. And CTA buttons
 * now use the inline badge style instead of a corner badge, which used
 * to overlap a small button's own label.
 *
 * **Second 2026-08-05 bugfix, same day, from a follow-up screenshot**:
 * the inline badge's own outer display was `flex`, not `inline-flex` —
 * `flex` is block-level, so the badge was forced onto its own new line
 * *every time*, regardless of whether the preceding text/button actually
 * left room for it on the current line. Looked like short text and small
 * buttons were uniquely broken ("the pencil pushes the text up / is half
 * hidden"), but it was universal — short content just made the dropped-
 * to-a-new-line badge visually collide with whatever rendered right
 * below it. `inline-flex` flows the badge inline like the surrounding
 * text/button actually calls for, only wrapping when there's genuinely
 * no room. */
export function Editable({ path, fieldType, value, as = "span", className, style, hideBadge, children }: EditableProps) {
  const cte = useCte();
  const Tag = as;
  const contentRef = React.useRef<HTMLElement>(null);

  if (!cte.active) {
    return className || style ? (
      <Tag className={className} style={style}>
        {children}
      </Tag>
    ) : (
      <>{children}</>
    );
  }

  const badgeStyle = fieldType === "text" || fieldType === "cta" || fieldType === "block-text" ? "inline" : "corner";
  // "block-container" is the one fieldType whose Editable wraps a whole
  // block *with children of its own* (a row/column/grid, potentially
  // holding several other Editable-wrapped blocks) — added 2026-08-06
  // (CTE part 7) after a real screenshot showed its corner badge sharing
  // the same color as an adjacent child's badge, making them impossible
  // to tell apart at a glance. A distinct color reads as "this edits the
  // whole container," not "this edits the last child in it."
  const isContainerBadge = fieldType === "block-container";

  function handleClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const computedDefaults = fieldType === "rich-text" ? readComputedRichTextDefaults(contentRef.current) : undefined;
    cte.select({ path, fieldType, value, computedDefaults });
  }

  const badge = (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Edit"
      className={cn(
        // inline-flex, not flex: this badge sits next to a text/CTA
        // sibling inside a naturally-flowing inline context (a <span> or
        // a flex row) — `flex` (block-level) forced it onto its own line
        // every time regardless of available room, which is what made
        // short text/small buttons look "pushed up"/half-hidden. See this
        // component's 2026-08-05 bugfix note.
        "z-10 inline-flex shrink-0 items-center justify-center rounded-full shadow transition hover:brightness-110",
        isContainerBadge ? "bg-blue-600 text-white" : "bg-primary text-primary-foreground",
        badgeStyle === "inline" ? "ml-1 size-4 align-middle" : "absolute top-2 right-2 size-6",
      )}
    >
      <Pencil className={badgeStyle === "inline" ? "size-2.5" : "size-3"} />
    </button>
  );

  return (
    <Tag
      // Callback ref, not `contentRef` directly: `Tag` is a dynamic
      // "span" | "div", so its JSX-inferred ref type is narrower
      // (HTMLSpanElement/HTMLDivElement) than `contentRef`'s plain
      // `HTMLElement` — a callback sidesteps the mismatch without an
      // `any` cast.
      ref={(node: HTMLElement | null) => {
        contentRef.current = node;
      }}
      className={cn(
        "rounded outline-dashed outline-1 outline-primary/40",
        badgeStyle === "corner" && "relative",
        // className last so tailwind-merge lets a real border-radius
        // (e.g. HeroSection's image wrapper's rounded-2xl) win over the
        // plain decorative "rounded" default above — see this
        // component's bugfix note for why that conflict matters here.
        className,
      )}
      style={style}
    >
      {children}
      {hideBadge ? null : badge}
    </Tag>
  );
}
