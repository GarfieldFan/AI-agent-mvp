"use client";

import * as React from "react";
import { CreditCard } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getPaymentSettings, registerWalletDomain, updatePaymentSettings, type PaymentSettings } from "@/lib/payments";
import { useAsyncApply } from "@/lib/use-async-apply";

const WALLET_METHOD_LABELS: Array<{ key: "apple_pay" | "google_pay" | "link" | "paypal"; label: string }> = [
  { key: "apple_pay", label: "Apple Pay" },
  { key: "google_pay", label: "Google Pay" },
  { key: "link", label: "Link (Stripe's own 1-click wallet)" },
  { key: "paypal", label: "PayPal (Stripe-processed, EU accounts only)" },
];

const PROVIDER_OPTIONS = [
  { value: "test" as const, label: "Test mode (no real charge)" },
  { value: "stripe" as const, label: "Stripe" },
  { value: "adyen" as const, label: "Adyen (UnionPay + regional methods)" },
];

/** Owner-facing "pay gate" picker (2026-08-20, backend/apis/payments.py)
 * — mirrors ModelSettingsPanel's write-only-secret pattern for
 * `custom_api_key`, applied to a new capability domain. "Test mode" is
 * the default: `/checkout` works with zero configuration, no real money
 * ever moves, an order is immediately marked paid — same "give the
 * owner choices, don't force config before anything works" posture
 * every AI provider picker already has. Switching to Stripe needs THREE
 * things before checkout works end to end: a secret key (server-side,
 * creates real embedded Checkout Sessions), a publishable key
 * (2026-09-10 — genuinely REQUIRED now, not just for reference: `/checkout`'s
 * embedded-Checkout popup calls Stripe.js's `loadStripe(publishableKey)`
 * client-side, fetched via the public `GET /api/payment-config`), and a
 * webhook secret (verifies `POST /api/webhooks/stripe` requests actually
 * came from Stripe). Adyen (2026-09-21) is a fourth option, the same
 * shape as Stripe (secret-style API key + HMAC key write-only, client
 * key/merchant account echoed back) — see backend/payments.py's module
 * docstring for why it exists alongside Stripe rather than replacing it. */
export function PaymentSettingsPanel() {
  const [settings, setSettings] = React.useState<PaymentSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [provider, setProvider] = React.useState<"test" | "stripe" | "adyen">("test");
  const [publishableKey, setPublishableKey] = React.useState("");
  const [secretKeyInput, setSecretKeyInput] = React.useState("");
  const [webhookSecretInput, setWebhookSecretInput] = React.useState("");

  const [adyenClientKey, setAdyenClientKey] = React.useState("");
  const [adyenMerchantAccount, setAdyenMerchantAccount] = React.useState("");
  const [adyenEnvironment, setAdyenEnvironment] = React.useState<"test" | "live">("test");
  const [adyenApiKeyInput, setAdyenApiKeyInput] = React.useState("");
  const [adyenHmacKeyInput, setAdyenHmacKeyInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const walletRegister = useAsyncApply();

  const refresh = React.useCallback(() => {
    getPaymentSettings()
      .then((result) => {
        setSettings(result);
        setProvider(result.payment_provider);
        setPublishableKey(result.stripe_publishable_key ?? "");
        setAdyenClientKey(result.adyen_client_key ?? "");
        setAdyenMerchantAccount(result.adyen_merchant_account ?? "");
        setAdyenEnvironment(result.adyen_environment ?? "test");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load payment settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updatePaymentSettings({
        payment_provider: provider,
        stripe_publishable_key: publishableKey.trim() || null,
        ...(secretKeyInput.trim() ? { stripe_secret_key: secretKeyInput.trim() } : {}),
        ...(webhookSecretInput.trim() ? { stripe_webhook_secret: webhookSecretInput.trim() } : {}),
        adyen_client_key: adyenClientKey.trim() || null,
        adyen_merchant_account: adyenMerchantAccount.trim() || null,
        adyen_environment: adyenEnvironment,
        ...(adyenApiKeyInput.trim() ? { adyen_api_key: adyenApiKeyInput.trim() } : {}),
        ...(adyenHmacKeyInput.trim() ? { adyen_hmac_key: adyenHmacKeyInput.trim() } : {}),
      });
      setSettings(result);
      setSecretKeyInput("");
      setWebhookSecretInput("");
      setAdyenApiKeyInput("");
      setAdyenHmacKeyInput("");
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleRegisterWalletDomain() {
    await walletRegister.run(async () => {
      const result = await registerWalletDomain();
      setSettings(result);
    });
  }

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading payment settings…" />
      </div>
    );
  }

  const webhookUrl = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/webhooks/stripe`;
  const adyenWebhookUrl = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/webhooks/adyen`;

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <CreditCard className="h-5 w-5" />
          Payment gate
        </h3>
        <p className="text-xs text-muted-foreground">
          Controls what happens when a visitor checks out. Test mode (the default) skips payment
          entirely — no real charge, orders are marked paid immediately — so checkout works before
          you&apos;ve set up a real processor.
        </p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Provider</Label>
        <Select value={provider} onValueChange={(v) => v && setProvider(v as "test" | "stripe" | "adyen")}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {provider === "stripe" ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Secret key</Label>
            <Input
              type="password"
              value={secretKeyInput}
              onChange={(e) => setSecretKeyInput(e.target.value)}
              placeholder={settings.stripe_secret_key_set ? "•••••••• (leave blank to keep saved key)" : "sk_test_…"}
            />
            {settings.stripe_secret_key_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Publishable key</Label>
            <Input value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} placeholder="pk_test_…" />
            <p className="text-xs text-muted-foreground">
              Required — the checkout popup uses this client-side to load Stripe.js. Safe to expose;
              it&apos;s not a secret.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Webhook signing secret</Label>
            <Input
              type="password"
              value={webhookSecretInput}
              onChange={(e) => setWebhookSecretInput(e.target.value)}
              placeholder={
                settings.stripe_webhook_secret_set ? "•••••••• (leave blank to keep saved key)" : "whsec_…"
              }
            />
            {settings.stripe_webhook_secret_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Point a Stripe webhook (event: <code>checkout.session.completed</code>) at{" "}
              <code className="break-all">{webhookUrl}</code> and paste its signing secret here — without
              this, a real Stripe payment will never actually mark an order paid.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <Label className="text-xs text-muted-foreground">Wallet payments</Label>
            <p className="text-xs text-muted-foreground">
              Apple Pay, Google Pay, WeChat Pay, and Alipay are enabled from your{" "}
              <a
                href="https://dashboard.stripe.com/settings/payment_methods"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Stripe Dashboard
              </a>
              , not here — once turned on there (and eligible for your account/region), they appear in
              checkout automatically, no changes needed on this page. Apple Pay and Google Pay need one
              extra one-time step first: registering this site&apos;s own domain with Stripe.
            </p>
            <p className="text-xs">
              Domain to register: <code className="break-all">{settings.wallet_domain}</code>
            </p>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {WALLET_METHOD_LABELS.map(({ key, label }) => {
                const status = settings.wallet_domain_status?.[key];
                return (
                  <li key={key} className="flex items-center gap-2">
                    <Badge variant={status === "active" ? "default" : "secondary"} className="text-xs">
                      {status ?? "not registered"}
                    </Badge>
                    {label}
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRegisterWalletDomain}
              disabled={walletRegister.status === "saving"}
            >
              {walletRegister.status === "saving" ? "Registering…" : "Register domain for wallet payments"}
            </Button>
            <p className="text-xs text-muted-foreground">
              A local/dev domain (e.g. <code>localhost</code>) or one whose DNS isn&apos;t live yet will
              fail here — that&apos;s Stripe correctly refusing to register something it can&apos;t
              verify, not a bug. Safe to click again later once your real domain is live.
            </p>
            {walletRegister.status === "error" && walletRegister.error ? (
              <ErrorMessage description={walletRegister.error} onRetry={walletRegister.reset} />
            ) : null}
          </div>
        </div>
      ) : null}

      {provider === "adyen" ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            The aggregator gateway — one more option alongside Stripe, specifically for local/regional
            payment methods Stripe doesn&apos;t cover for your account (China UnionPay in particular).
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Environment</Label>
            <Select value={adyenEnvironment} onValueChange={(v) => v && setAdyenEnvironment(v as "test" | "live")}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="test">Test</SelectItem>
                <SelectItem value="live">Live</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Merchant account</Label>
            <Input
              value={adyenMerchantAccount}
              onChange={(e) => setAdyenMerchantAccount(e.target.value)}
              placeholder="YourCompanyECOM"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">API key</Label>
            <Input
              type="password"
              value={adyenApiKeyInput}
              onChange={(e) => setAdyenApiKeyInput(e.target.value)}
              placeholder={settings.adyen_api_key_set ? "•••••••• (leave blank to keep saved key)" : "AQE…"}
            />
            {settings.adyen_api_key_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Client key</Label>
            <Input value={adyenClientKey} onChange={(e) => setAdyenClientKey(e.target.value)} placeholder="test_…" />
            <p className="text-xs text-muted-foreground">
              Required — the checkout popup uses this client-side to load Adyen&apos;s Drop-in. Safe to
              expose; it&apos;s not a secret.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">HMAC key</Label>
            <Input
              type="password"
              value={adyenHmacKeyInput}
              onChange={(e) => setAdyenHmacKeyInput(e.target.value)}
              placeholder={settings.adyen_hmac_key_set ? "•••••••• (leave blank to keep saved key)" : "64 hex characters…"}
            />
            {settings.adyen_hmac_key_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Point an Adyen standard webhook at{" "}
              <code className="break-all">{adyenWebhookUrl}</code> and paste its HMAC key here — without
              this, a real Adyen payment will never actually mark an order paid.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      {saveStatus === "error" && saveError ? (
        <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
      ) : null}
    </div>
  );
}
