import { apiFetch } from "@/lib/api";

/** Owner-facing payment gate settings (2026-08-20, backend/apis/
 * payments.py) — mirrors lib/models.ts's write-only-secret pattern
 * (`custom_api_key`): `stripe_secret_key`/`stripe_webhook_secret` are
 * never echoed back by GET, only a `*_set` boolean says whether one is
 * saved. `stripe_publishable_key` is the one exception — Stripe's own
 * publishable key is meant to be public, safe to display. */
export type PaymentSettings = {
  payment_provider: "test" | "stripe";
  stripe_publishable_key: string | null;
  stripe_secret_key_set: boolean;
  stripe_webhook_secret_set: boolean;
};

export type PaymentSettingsInput = {
  payment_provider: "test" | "stripe";
  stripe_publishable_key?: string | null;
  /** Omit to leave the previously-saved secret alone — only send this
   * when the owner actually typed a new one. */
  stripe_secret_key?: string;
  stripe_webhook_secret?: string;
};

export function getPaymentSettings() {
  return apiFetch<PaymentSettings>("/api/agent/payment-settings");
}

export function updatePaymentSettings(input: PaymentSettingsInput) {
  return apiFetch<PaymentSettings>("/api/agent/payment-settings", { method: "PUT", body: input });
}

/** Public payment config (2026-09-10, backend/apis/payments.py) — what
 * `/checkout`'s embedded-Checkout modal needs to call Stripe.js's own
 * `loadStripe(publishableKey)`. `publishable_key` isn't a secret — same
 * posture as Google Maps' embed key / Turnstile's site key. This is a
 * SEPARATE, public, no-auth endpoint from `getPaymentSettings` above
 * (admin/owner-gated) — a public checkout page has no admin JWT to call
 * that with. */
export type PaymentConfig = {
  provider: string;
  publishable_key: string | null;
};

export function getPaymentConfig() {
  return apiFetch<PaymentConfig>("/api/payment-config");
}

/** A best-effort READ of a Checkout Session's status, for the return
 * page's own friendly display copy only — never proof of payment (see
 * backend/payments.py's `retrieve_checkout_session_status` docstring).
 * `sessionId` comes from Stripe's own `return_url` redirect, not
 * anything generated client-side. */
export type CheckoutSessionStatus = {
  status: string;
  payment_status: string;
};

export function getCheckoutSessionStatus(sessionId: string) {
  return apiFetch<CheckoutSessionStatus>(`/api/checkout/session-status?session_id=${encodeURIComponent(sessionId)}`);
}
