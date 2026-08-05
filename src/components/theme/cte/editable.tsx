"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCte } from "@/components/theme/cte/cte-context";
import type { EditableFieldType } from "@/lib/cte";

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
export function Editable({ path, fieldType, value, as = "span", className, children }: EditableProps) {
  const cte = useCte();
  const Tag = as;

  if (!cte.active) {
    return className ? <Tag className={className}>{children}</Tag> : <>{children}</>;
  }

  const badgeStyle = fieldType === "text" || fieldType === "cta" ? "inline" : "corner";

  function handleClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    cte.select({ path, fieldType, value });
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
        "z-10 inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow transition hover:brightness-110",
        badgeStyle === "inline" ? "ml-1 size-4 align-middle" : "absolute top-2 right-2 size-6",
      )}
    >
      <Pencil className={badgeStyle === "inline" ? "size-2.5" : "size-3"} />
    </button>
  );

  return (
    <Tag
      className={cn(
        "rounded outline-dashed outline-1 outline-primary/40",
        badgeStyle === "corner" && "relative",
        // className last so tailwind-merge lets a real border-radius
        // (e.g. HeroSection's image wrapper's rounded-2xl) win over the
        // plain decorative "rounded" default above — see this
        // component's bugfix note for why that conflict matters here.
        className,
      )}
    >
      {children}
      {badge}
    </Tag>
  );
}
