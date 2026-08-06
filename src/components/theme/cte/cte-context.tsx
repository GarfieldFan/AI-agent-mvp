"use client";

import * as React from "react";

import type { CteSelection } from "@/lib/cte";

type CteContextValue = {
  active: boolean;
  select: (selection: CteSelection) => void;
  /** Added 2026-08-06 (CTE part 7) — move/delete/insert-at-position for
   * *any* array in the tree (feature-item/cta arrays,
   * `ContainerBlock.children`), not just the top-level `sections` array
   * `CteEditorPanel` already handled directly. Exposed through context
   * (like `select`) so a deeply-nested renderer (e.g. `BlockRenderer`,
   * several levels of container nesting deep) can trigger a top-level
   * `sections` mutation without threading callbacks down as props through
   * every intermediate component. `itemPath`/`arrayPath` use the same
   * dot-path addressing as `select`'s `path` (see lib/cte.ts). */
  move: (itemPath: string, direction: -1 | 1) => void;
  remove: (itemPath: string) => void;
  insertAt: (arrayPath: string, index: number, value: unknown) => void;
};

const noop = () => {};

const CteContext = React.createContext<CteContextValue>({
  active: false,
  select: noop,
  move: noop,
  remove: noop,
  insertAt: noop,
});

export const useCte = () => React.useContext(CteContext);

/** Wraps a SectionRenderer tree in CTE edit mode. `active` is driven by
 * CteEditorPanel's "Edit mode" Switch (2026-08-04 — replaced an earlier
 * always-on-while-mounted version) rather than being implicitly true
 * whenever a provider exists: loading a page in /editor should look like
 * the live site until you deliberately flip edit mode on — both because
 * that's a truer preview, and because it's the mechanism that makes
 * editable regions discoverable without hover (see Editable's doc
 * comment — hover doesn't exist on touch devices). Every public route
 * (/, /about, /p/[slug]) renders SectionRenderer with no provider above
 * it at all, so useCte()'s default (`active: false`) keeps them exactly
 * as before regardless. */
export function CteProvider({
  active,
  onSelect,
  onMove,
  onRemove,
  onInsertAt,
  children,
}: {
  active: boolean;
  onSelect: (selection: CteSelection) => void;
  /** Optional — omitted by the (currently nonexistent) callers that don't
   * need structural editing; default to no-ops so `useCte()` always has a
   * safe function to call. */
  onMove?: (itemPath: string, direction: -1 | 1) => void;
  onRemove?: (itemPath: string) => void;
  onInsertAt?: (arrayPath: string, index: number, value: unknown) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo<CteContextValue>(
    () => ({
      active,
      select: onSelect,
      move: onMove ?? noop,
      remove: onRemove ?? noop,
      insertAt: onInsertAt ?? noop,
    }),
    [active, onSelect, onMove, onRemove, onInsertAt],
  );
  return <CteContext.Provider value={value}>{children}</CteContext.Provider>;
}
