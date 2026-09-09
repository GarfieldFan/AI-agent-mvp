import { apiFetch } from "@/lib/api";

/** Bot verification (2026-09-10, backend/turnstile.py) — Cloudflare
 * Turnstile. `getTurnstileConfig` is a public, no-auth, page-view-time
 * lookup (never itself gated — see backend/turnstile.py's own docstring
 * for why this feature can never affect SEO/GEO crawling) that every
 * gated form/panel calls once on mount to decide whether to render the
 * widget at all. `site_key` isn't a secret — same posture as Stripe's
 * own publishable key. */
export type TurnstileConfig = {
  enabled: boolean;
  site_key: string | null;
};

export function getTurnstileConfig() {
  return apiFetch<TurnstileConfig>("/api/turnstile-config");
}

/** Owner-facing settings (admin/owner-gated) — mirrors lib/maps.ts's
 * shape exactly. */
export type TurnstileSettings = {
  turnstile_enabled: boolean;
  turnstile_site_key: string | null;
  turnstile_secret_key_set: boolean;
};

export function getTurnstileSettings() {
  return apiFetch<TurnstileSettings>("/api/agent/turnstile-settings");
}

export function updateTurnstileSettings(input: {
  turnstile_enabled: boolean;
  turnstile_site_key?: string | null;
  turnstile_secret_key?: string | null;
}) {
  return apiFetch<TurnstileSettings>("/api/agent/turnstile-settings", {
    method: "PUT",
    body: input,
  });
}
