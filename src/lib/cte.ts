/** Minimal path-based updater for a `PageSection[]` tree — powers the
 * click-to-edit (CTE) layer (see components/theme/cte/). The original
 * project plan called for wrapping GrapesJS here; that was traded away
 * (see the root AGENTS.md's CTE section) because GrapesJS edits raw
 * HTML/CSS directly, which conflicts with this project's "the LLM/editor
 * only ever produces a typed PageSection, never markup" safety story.
 * This file is the hand-rolled replacement for the one piece of that
 * GrapesJS integration actually needed: turning "the user edited this one
 * field" into a new, immutable `sections` array.
 *
 * Paths are dot-separated segments mixing array indices and object keys,
 * e.g. "0.headline" or "1.items.2.image.url" — the same shape a
 * lodash-style `_.set` path would use. Hand-rolled since this is the only
 * place in the codebase that needs it. */
export function setByPath<T>(sections: T, path: string, value: unknown): T {
  return setRecursive(sections, path.split("."), value) as T;
}

function setRecursive(node: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;

  if (Array.isArray(node)) {
    const index = Number(key);
    const clone = [...node];
    clone[index] = rest.length === 0 ? value : setRecursive(node[index], rest, value);
    return clone;
  }

  if (node && typeof node === "object") {
    const clone = { ...(node as Record<string, unknown>) };
    clone[key] = rest.length === 0 ? value : setRecursive(clone[key], rest, value);
    return clone;
  }

  throw new Error(`setByPath: cannot descend into path segment "${key}" of a non-object/array node`);
}

function getByPath(node: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((acc, key) => {
    if (Array.isArray(acc)) return acc[Number(key)];
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, node);
}

/** Appends `value` to the array found at `arrayPath` (e.g. "1.items") —
 * powers CTE's "+" add-item buttons (AddItemButton). Treats a missing
 * array (e.g. HeroSection.ctas when the hero has none yet) as empty
 * rather than throwing, so "add the first button" works too. */
export function appendByPath<T>(sections: T, arrayPath: string, value: unknown): T {
  const keys = arrayPath.split(".");
  const current = (getByPath(sections, keys) as unknown[] | undefined) ?? [];
  return setRecursive(sections, keys, [...current, value]) as T;
}

/** Removes the array element at `itemPath` (e.g. "1.items.2") — powers
 * CTE's per-item Delete button. */
export function removeByPath<T>(sections: T, itemPath: string): T {
  const keys = itemPath.split(".");
  const index = Number(keys[keys.length - 1]);
  const arrayKeys = keys.slice(0, -1);
  const current = getByPath(sections, arrayKeys) as unknown[];
  const next = current.filter((_, i) => i !== index);
  return setRecursive(sections, arrayKeys, next) as T;
}

/** What kind of editor popover a click should open, and how to interpret
 * `value` — see cte-editor-popover.tsx for the actual form per type. */
export type EditableFieldType = "text" | "image" | "feature-item" | "badge-list" | "cta";

export type CteSelection = {
  path: string;
  fieldType: EditableFieldType;
  value: unknown;
  /** "create" means `path` points at the *array itself* (e.g. "1.items")
   * and saving should append `value` as a new element rather than
   * replacing whatever's at `path` — set by AddItemButton, default "edit"
   * everywhere else (Editable never sets this). */
  mode?: "edit" | "create";
};
