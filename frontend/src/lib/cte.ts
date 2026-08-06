import type { TextWeight } from "@/lib/theme";

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

/** Inserts `value` into the array at `arrayPath` at a specific `index`
 * (0 = before the first element, `array.length` = after the last) —
 * added 2026-08-06 for CTE part 7's structural-editing generalization
 * (`ContainerBlock.children`'s "+" insert-at-any-position, see
 * `BlockInsertMenu`/`BlockRenderer`). Unlike `appendByPath`, which only
 * ever adds at the end (`AddItemButton`'s original scope), this backs any
 * array's "+" gap, not just the last one. Treats a missing array as
 * empty, same as `appendByPath`. */
export function insertByPath<T>(sections: T, arrayPath: string, index: number, value: unknown): T {
  const keys = arrayPath.split(".");
  const current = (getByPath(sections, keys) as unknown[] | undefined) ?? [];
  const next = [...current];
  next.splice(index, 0, value);
  return setRecursive(sections, keys, next) as T;
}

/** Swaps the array element at `itemPath` with its neighbor in `direction`
 * (-1 = earlier, 1 = later) — added 2026-08-06, generalizing
 * `CteEditorPanel`'s original section-only `handleMoveSection` (a plain
 * top-level array swap with no path needed) to work at *any* depth, so
 * the same "move" affordance also works for feature-item/cta arrays and
 * `ContainerBlock.children`. No-op (returns the original reference) at
 * either end of the array, same "nothing to do" semantics the disabled
 * move buttons already rely on. */
export function moveByPath<T>(sections: T, itemPath: string, direction: -1 | 1): T {
  const keys = itemPath.split(".");
  const index = Number(keys[keys.length - 1]);
  const arrayKeys = keys.slice(0, -1);
  const current = getByPath(sections, arrayKeys) as unknown[];
  const target = index + direction;
  if (target < 0 || target >= current.length) return sections;
  const next = [...current];
  [next[index], next[target]] = [next[target], next[index]];
  return setRecursive(sections, arrayKeys, next) as T;
}

/** What kind of editor popover a click should open, and how to interpret
 * `value` — see cte-editor-popover.tsx for the actual form per type.
 * "block-*" (added 2026-08-06) edit a whole Container/Text/Image/Button
 * Block instance (lib/theme.ts's `Block` union) — content AND style
 * fields (color, size/weight, padding/margin, layout/justify/align) in
 * one form, since a Block's style knobs live on the same object as its
 * content, unlike the fixed composite sections' plain-string fields. */
export type EditableFieldType =
  | "text"
  | "rich-text"
  | "image"
  | "feature-item"
  | "badge-list"
  | "cta"
  | "block-container"
  | "block-text"
  | "block-image"
  | "block-button";

export type CteSelection = {
  path: string;
  fieldType: EditableFieldType;
  value: unknown;
  /** "create" means `path` points at the *array itself* (e.g. "1.items")
   * and saving should append `value` as a new element rather than
   * replacing whatever's at `path` — set by AddItemButton, default "edit"
   * everywhere else (Editable never sets this). */
  mode?: "edit" | "create";
  /** Added 2026-08-06 for `"rich-text"` fields only — the actual rendered
   * font-size/weight/color read via `getComputedStyle` on the clicked DOM
   * node, at click time (see `Editable`). Exists because `RichText`'s
   * "unset" state doesn't have one universal default the way e.g.
   * `ContainerBlock.layout` does ("row") — each fixed section's own
   * headline/heading/body renders at a different hardcoded size, so the
   * only way to show "what this field currently looks like" in the
   * editor (instead of a blank "Default" input) is to read it straight
   * off the live-rendered element. Purely a *display* hint for the
   * popover's initial field values — never written back unless the user
   * actually keeps/changes it, same as any other draft state. */
  computedDefaults?: { size?: number; weight?: TextWeight; color?: string };
};
