import { apiFetch } from "@/lib/api";

/** Owner-facing map-provider config (2026-08-21, backend/apis/maps.py) —
 * mirrors payments.ts/notifications.ts's write-only-secret shape:
 * `google_maps_api_key` is never echoed back, only
 * `google_maps_api_key_set` says whether one is saved. */
export type MapSettings = {
  map_provider: string;
  google_maps_api_key_set: boolean;
};

export type MapSettingsInput = {
  map_provider: string;
  google_maps_api_key?: string;
};

export function getMapSettings() {
  return apiFetch<MapSettings>("/api/agent/map-settings");
}

export function updateMapSettings(input: MapSettingsInput) {
  return apiFetch<MapSettings>("/api/agent/map-settings", { method: "PUT", body: input });
}

/** Public, no-auth — resolves a place/address query into a ready embed
 * URL (only when a real provider is configured) plus a plain Google Maps
 * search link that's ALWAYS present regardless of configuration. Called
 * client-side by MapBlock, never server-side, since the query text is
 * owner-authored page content read at render time (see MapBlock's own
 * docstring for why every product-adjacent Block already fetches this
 * way). */
export type MapEmbedResult = {
  embed_url: string | null;
  maps_url: string;
};

export function getMapEmbed(query: string) {
  return apiFetch<MapEmbedResult>(`/api/map-embed?query=${encodeURIComponent(query)}`);
}
