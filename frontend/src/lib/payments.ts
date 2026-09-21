import { apiFetch } from "@/lib/api";

/** Owner-facing payment gate settings (2026-08-20, backend/apis/
 * payments.py) — mirrors lib/models.ts's write-only-secret pattern
 * (`custom_api_key`): `stripe_secret_key`/`stripe_webhook_secret` are
 * never echoed back by GET, only a `*_set` boolean says whether one is
 * saved. `stripe_publishable_key` is the one exception — Stripe's own
 * publishable key is meant to be public, safe to display. */
/** Wallet payment method status (2026-09-20, backend/payments.py) — the
 * raw result of Stripe's payment-method-domains API for this
 * deployment's own domain, hand-extracted to just the fields the panel
 * shows. Each method field is a Stripe status string (e.g. `"active"`)
 * or `null` when Stripe hasn't reported anything on that method yet. */
export type WalletDomainStatus = {
  domain_name: string | null;
  enabled: boolean | null;
  apple_pay: string | null;
  google_pay: string | null;
  link: string | null;
  paypal: string | null;
};

export type PaymentSettings = {
  payment_provider: "test" | "stripe" | "adyen";
  stripe_publishable_key: string | null;
  stripe_secret_key_set: boolean;
  stripe_webhook_secret_set: boolean;
  /** Always present — the domain that would be/is registered for
   * Apple Pay/Google Pay/Link, derived server-side from
   * FRONTEND_PUBLIC_URL, not something this panel can edit. */
  wallet_domain: string;
  /** Best-effort live read; `null` means "not registered yet" (or
   * Stripe isn't configured/reachable right now to check). */
  wallet_domain_status: WalletDomainStatus | null;
  /** Adyen (2026-09-21) — the aggregator gateway added alongside Stripe
   * specifically for local/regional methods Stripe doesn't cover for a
   * given merchant account (China UnionPay in particular). Same
   * write-only-secret split as the Stripe fields above:
   * adyen_client_key (Adyen's own public, browser-embeddable key) and
   * adyen_merchant_account are echoed back; adyen_api_key/
   * adyen_hmac_key never are. */
  adyen_client_key: string | null;
  adyen_merchant_account: string | null;
  adyen_environment: "test" | "live";
  adyen_api_key_set: boolean;
  adyen_hmac_key_set: boolean;
};

export type PaymentSettingsInput = {
  payment_provider: "test" | "stripe" | "adyen";
  stripe_publishable_key?: string | null;
  /** Omit to leave the previously-saved secret alone — only send this
   * when the owner actually typed a new one. */
  stripe_secret_key?: string;
  stripe_webhook_secret?: string;
  adyen_client_key?: string | null;
  adyen_merchant_account?: string | null;
  adyen_environment?: "test" | "live";
  /** Same "omit to leave the previously-saved secret alone" rule as
   * the Stripe secret fields above. */
  adyen_api_key?: string;
  adyen_hmac_key?: string;
};

export function getPaymentSettings() {
  return apiFetch<PaymentSettings>("/api/agent/payment-settings");
}

export function updatePaymentSettings(input: PaymentSettingsInput) {
  return apiFetch<PaymentSettings>("/api/agent/payment-settings", { method: "PUT", body: input });
}

/** Registers this deployment's public domain with Stripe so Apple Pay/
 * Google Pay/Link (and Stripe's standard PayPal, where eligible) can
 * render inside embedded Checkout — a one-time owner action, not
 * something that needs re-running after every settings save. Rejects
 * (via `ApiError`) on a domain Stripe genuinely can't verify yet, e.g.
 * localhost or a production domain whose DNS isn't live — that's
 * expected in local dev, not a bug. */
export function registerWalletDomain() {
  return apiFetch<PaymentSettings>("/api/agent/payment-settings/register-wallet-domain", { method: "POST" });
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
  /** Adyen's own equivalents (2026-09-21) — same "safe to expose,
   * designed for browser-side JS" reasoning as publishable_key above.
   * All three only ever set together, when provider === "adyen". */
  adyen_client_key: string | null;
  adyen_environment: string | null;
  adyen_merchant_account: string | null;
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
