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
import { getPaymentSettings, updatePaymentSettings, type PaymentSettings } from "@/lib/payments";

const PROVIDER_OPTIONS = [
  { value: "test" as const, label: "Test mode (no real charge)" },
  { value: "stripe" as const, label: "Stripe" },
];

/** Owner-facing "pay gate" picker (2026-08-20, backend/apis/payments.py)
 * — mirrors ModelSettingsPanel's write-only-secret pattern for
 * `custom_api_key`, applied to a new capability domain. "Test mode" is
 * the default: `/checkout` works with zero configuration, no real money
 * ever moves, an order is immediately marked paid — same "give the
 * owner choices, don't force config before anything works" posture
 * every AI provider picker already has. Switching to Stripe needs a
 * secret key (server-side, creates real Checkout Sessions) and,
 * separately, a webhook secret (verifies `POST /api/webhooks/stripe`
 * requests actually came from Stripe) before checkout will work end to
 * end — the publishable key is optional here since this app's own
 * checkout flow never renders Stripe Elements client-side (hosted
 * Checkout redirects instead), it's just surfaced for the owner's own
 * reference/future use. */
export function PaymentSettingsPanel() {
  const [settings, setSettings] = React.useState<PaymentSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [provider, setProvider] = React.useState<"test" | "stripe">("test");
  const [publishableKey, setPublishableKey] = React.useState("");
  const [secretKeyInput, setSecretKeyInput] = React.useState("");
  const [webhookSecretInput, setWebhookSecretInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getPaymentSettings()
      .then((result) => {
        setSettings(result);
        setProvider(result.payment_provider);
        setPublishableKey(result.stripe_publishable_key ?? "");
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
      });
      setSettings(result);
      setSecretKeyInput("");
      setWebhookSecretInput("");
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
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
        <Select value={provider} onValueChange={(v) => v && setProvider(v as "test" | "stripe")}>
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
            <Label className="text-xs text-muted-foreground">Publishable key (optional, for reference)</Label>
            <Input value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} placeholder="pk_test_…" />
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
