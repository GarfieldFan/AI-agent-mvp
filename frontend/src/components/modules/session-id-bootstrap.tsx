"use client";

import * as React from "react";

import { restoreChatSessionId } from "@/lib/chat";

/** Restores a visitor's cart/chat identity from a `?sid=` URL param
 * (2026-08-20) — the fix for a lost order: if localStorage is cleared or
 * a visitor switches devices, the id getChatSessionId() relies on is
 * gone and their in-progress cart becomes unreachable in the UI (the
 * order still exists server-side). A link carrying `?sid=<id>` — saved
 * from /cart's own "Save this cart" button, or a dine-in table's own
 * printed QR code pointing at `https://.../?sid=<id>` — restores it
 * instantly, no backend lookup needed.
 *
 * Mounted once in the root layout so it applies on every route, not just
 * /cart. Reads `window.location.search` directly in an effect rather
 * than Next's `useSearchParams()` — that hook forces every route under
 * this root-layout-mounted component into dynamic rendering just to read
 * a param this app only ever cares about once, on load; several routes
 * are deliberately static (see frontend/AGENTS.md's Routes section).
 * Strips the param from the URL afterward via history.replaceState so it
 * doesn't linger if the visitor bookmarks or reshares the page mid-visit.
 * Renders nothing. */
export function SessionIdBootstrap() {
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("sid");
    if (!sid) return;
    restoreChatSessionId(sid);
    params.delete("sid");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, []);

  return null;
}
