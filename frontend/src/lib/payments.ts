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
