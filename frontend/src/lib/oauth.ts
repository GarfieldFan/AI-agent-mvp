import { apiFetch } from "@/lib/api";

/** Social login for the public `user` tier only (2026-08-22, backend/
 * apis/oauth.py) — admin/owner accounts never use this, confirmed
 * directly with the user; they stay on the existing password login
 * (lib/auth.ts). Google, Facebook, X (2026-08-22, all three) — Google was
 * built first as the reference implementation. */
export type OAuthProviders = {
  google: boolean;
  facebook: boolean;
  x: boolean;
};

/** Public, no-auth — the login page reads this to decide which
 * "Sign in with ..." buttons to show at all. */
export function getOAuthProviders() {
  return apiFetch<OAuthProviders>("/api/auth/oauth-providers");
}

function oauthStartUrl(provider: "google" | "facebook" | "x"): string {
  const base = typeof window === "undefined" ? "" : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000");
  return `${base}/api/auth/oauth/${provider}/start`;
}

/** Not a fetch — a real top-level browser navigation. The backend
 * redirects to the provider's own consent screen, then back to this
 * app's own callback route, then to /login?oauth_token=... — see
 * LoginForm for the receiving end. */
export function googleOAuthStartUrl(): string {
  return oauthStartUrl("google");
}

export function facebookOAuthStartUrl(): string {
  return oauthStartUrl("facebook");
}

/** X sign-in may fail after the redirect (a clean ?oauth_error=1) even
 * with valid credentials configured — X's standard API doesn't reliably
 * return an email address without an elevated Developer Portal
 * permission this app has no control over. See backend/apis/oauth.py's
 * own docstring. */
export function xOAuthStartUrl(): string {
  return oauthStartUrl("x");
}

export type OAuthSettings = {
  google_client_id: string | null;
  google_client_secret_set: boolean;
  google_callback_url: string;
  facebook_client_id: string | null;
  facebook_client_secret_set: boolean;
  facebook_callback_url: string;
  x_client_id: string | null;
  x_client_secret_set: boolean;
  x_callback_url: string;
};

export type OAuthSettingsInput = {
  google_client_id?: string | null;
  google_client_secret?: string;
  facebook_client_id?: string | null;
  facebook_client_secret?: string;
  x_client_id?: string | null;
  x_client_secret?: string;
};

export function getOAuthSettings() {
  return apiFetch<OAuthSettings>("/api/agent/oauth-settings");
}

export function updateOAuthSettings(input: OAuthSettingsInput) {
  return apiFetch<OAuthSettings>("/api/agent/oauth-settings", { method: "PUT", body: input });
}
