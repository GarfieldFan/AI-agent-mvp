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

/** Same normalization as `slugify`, but underscore-joined (`snake_case`)
 * instead of hyphenated — matches this project's own "_key" convention
 * for programmatic identifiers (`IntentSchema.key` e.g. "insurance_claim",
 * `IntentField.field_key` e.g. "policy_number") rather than the
 * hyphenated page-slug convention `slugify` produces. Added 2026-08-20
 * so IntentSchemaPanel can auto-derive a schema's stable `key` from its
 * owner-typed `label`, instead of asking the owner to hand-invent a
 * "technical-looking" id themselves. */
export function slugifyKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
