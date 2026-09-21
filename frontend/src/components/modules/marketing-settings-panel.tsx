"use client";

import * as React from "react";
import { Megaphone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getMarketingSettings, updateMarketingSettings, type MarketingSettings } from "@/lib/marketing";

const PROVIDER_OPTIONS = [
  { value: "test" as const, label: "Test mode (no real sync)" },
  { value: "mailchimp" as const, label: "Mailchimp" },
  { value: "hubspot" as const, label: "HubSpot" },
];

/** Owner-facing marketing/CRM platform picker (2026-09-21, backend/apis/
 * marketing.py) — mirrors NotificationSettingsPanel's write-only-secret
 * UX. Unlike email/SMS, there's no separate "send a test message" action
 * here — a sync IS a real upsert of a contact record on the vendor's
 * side, so the natural verification step is syncing a real (or
 * deliberately throwaway test) lead from `CrmPanel`'s own "Sync to
 * marketing platform" button, not a parallel test-only code path. */
export function MarketingSettingsPanel() {
  const [settings, setSettings] = React.useState<MarketingSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [provider, setProvider] = React.useState<"test" | "mailchimp" | "hubspot">("test");
  const [mailchimpAudienceId, setMailchimpAudienceId] = React.useState("");
  const [mailchimpApiKeyInput, setMailchimpApiKeyInput] = React.useState("");
  const [hubspotAccessTokenInput, setHubspotAccessTokenInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getMarketingSettings()
      .then((result) => {
        setSettings(result);
        setProvider(result.marketing_provider);
        setMailchimpAudienceId(result.mailchimp_audience_id ?? "");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load marketing settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateMarketingSettings({
        marketing_provider: provider,
        mailchimp_audience_id: mailchimpAudienceId.trim() || null,
        ...(mailchimpApiKeyInput.trim() ? { mailchimp_api_key: mailchimpApiKeyInput.trim() } : {}),
        ...(hubspotAccessTokenInput.trim() ? { hubspot_access_token: hubspotAccessTokenInput.trim() } : {}),
      });
      setSettings(result);
      setMailchimpApiKeyInput("");
      setHubspotAccessTokenInput("");
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
        <LoadingSpinner label="Loading marketing settings…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Megaphone className="h-5 w-5" />
          Marketing / CRM sync
        </h3>
        <p className="text-xs text-muted-foreground">
          Pushes a captured lead&apos;s contact info to a marketing platform you already use. A
          deterministic, code-level sync — no AI decides what to send, only whether/which lead to sync
          (from CrmPanel&apos;s own button, or owner-agent&apos;s <code>sync_crm_entry_to_marketing</code>{" "}
          tool). Test mode (the default) does nothing.
        </p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Provider</Label>
        <Select value={provider} onValueChange={(v) => v && setProvider(v as "test" | "mailchimp" | "hubspot")}>
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

      {provider === "mailchimp" ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Audience (list) ID</Label>
            <Input
              value={mailchimpAudienceId}
              onChange={(e) => setMailchimpAudienceId(e.target.value)}
              placeholder="a1b2c3d4e5"
            />
            <p className="text-xs text-muted-foreground">
              Found under Audience &rarr; Settings &rarr; Audience name and defaults in your Mailchimp account.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">API key</Label>
            <Input
              type="password"
              value={mailchimpApiKeyInput}
              onChange={(e) => setMailchimpApiKeyInput(e.target.value)}
              placeholder={settings.mailchimp_api_key_set ? "•••••••• (leave blank to keep saved key)" : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us21"}
            />
            {settings.mailchimp_api_key_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
            <p className="text-xs text-muted-foreground">
              The datacenter (e.g. <code>us21</code>) is read from the end of the key itself — no separate
              field needed.
            </p>
          </div>
        </div>
      ) : null}

      {provider === "hubspot" ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Private app access token</Label>
            <Input
              type="password"
              value={hubspotAccessTokenInput}
              onChange={(e) => setHubspotAccessTokenInput(e.target.value)}
              placeholder={settings.hubspot_access_token_set ? "•••••••• (leave blank to keep saved key)" : "pat-…"}
            />
            {settings.hubspot_access_token_set ? (
              <Badge variant="secondary" className="text-xs">
                Saved
              </Badge>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Create a private app in HubSpot (Settings &rarr; Integrations &rarr; Private Apps) with the{" "}
              <code>crm.objects.contacts.write</code> scope and paste its access token here.
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
