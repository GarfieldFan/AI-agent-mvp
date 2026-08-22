"use client";

import * as React from "react";
import { MapPin } from "lucide-react";

import { Editable } from "@/components/theme/cte/editable";
import { getMapEmbed, type MapEmbedResult } from "@/lib/maps";
import type { MapBlock as MapBlockData } from "@/lib/theme";

/** An embedded business-location map (2026-08-21) — see lib/theme.ts's
 * MapBlock doc comment and backend/maps.py's swappable-provider design.
 * Fetches client-side, same reason ProductListBlock/ProductCardBlock do
 * (BlockRenderer, the recursive dispatcher rendering every Block type
 * including this one, is a Client Component, and a Client Component can't
 * render an async Server Component as a child) — and because `query` is
 * owner-authored page content only known once this block actually
 * renders, not something a caller could resolve ahead of time.
 *
 * The "open in Google Maps" link is ALWAYS rendered, regardless of
 * whether a real map provider is configured — the redirect-only floor
 * the owner asked about, never gated on any provider setup. The live
 * iframe on top of it only appears once `embed_url` comes back non-null
 * (a real provider configured in Map settings). */
export function MapBlock({ query, path }: MapBlockData & { path: string }) {
  const [result, setResult] = React.useState<MapEmbedResult | undefined>(undefined);

  React.useEffect(() => {
    // A stale `result` from a previous non-empty query is harmless here —
    // the render below always checks `!query.trim()` first and never
    // shows `result` in that branch, so there's no need to reset state
    // synchronously (which would trip react-hooks/set-state-in-effect).
    if (!query.trim()) return;
    let cancelled = false;
    getMapEmbed(query).then((res) => {
      if (!cancelled) setResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <Editable as="div" path={path} fieldType="block-map" value={{ type: "map", query }} className="space-y-2">
      {!query.trim() ? (
        <p className="text-sm text-muted-foreground">
          No address set yet — edit this block to add one.
        </p>
      ) : (
        <>
          {result?.embed_url ? (
            <iframe
              src={result.embed_url}
              className="h-72 w-full rounded-lg border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              title={query}
            />
          ) : (
            <div className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground">
              <MapPin className="mr-2 h-4 w-4" />
              {query}
            </div>
          )}
          {result ? (
            <a
              href={result.maps_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2"
            >
              <MapPin className="h-3.5 w-3.5" />
              Open in Google Maps
            </a>
          ) : null}
        </>
      )}
    </Editable>
  );
}
