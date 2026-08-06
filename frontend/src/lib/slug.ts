/** Normalizes free-typed text into a URL-safe page slug: lowercase,
 * whitespace/underscores -> hyphens, strips anything that isn't
 * a-z0-9-, collapses/trims stray hyphens ("Summer Promo!" -> "summer-promo").
 * Applied right before a slug is actually used (Load/Save), not on every
 * keystroke — transforming live would mangle a name mid-type (e.g. a
 * trailing space becoming a trailing hyphen immediately). Used by both
 * CteEditorPanel's slug field and PageGeneratorPanel's SavePageForm. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
