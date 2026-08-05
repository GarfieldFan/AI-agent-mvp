"use client";

import * as React from "react";

import type { CteSelection } from "@/lib/cte";

type CteContextValue = {
  active: boolean;
  select: (selection: CteSelection) => void;
};

const CteContext = React.createContext<CteContextValue>({
  active: false,
  select: () => {},
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
  children,
}: {
  active: boolean;
  onSelect: (selection: CteSelection) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo<CteContextValue>(() => ({ active, select: onSelect }), [active, onSelect]);
  return <CteContext.Provider value={value}>{children}</CteContext.Provider>;
}
