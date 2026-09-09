"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getTurnstileSettings, updateTurnstileSettings, type TurnstileSettings } from "@/lib/turnstile";

/** Owner-facing Cloudflare Turnstile config (2026-09-10,
 * backend/apis/turnstile_settings.py) — off by default, same "give the
 * owner a choice, don't force config before anything works" posture as
 * every other gate in this app. See backend/turnstile.py's own docstring
 * for why this never affects SEO/GEO: it only ever gates the public
 * chat's first turn, the contact form, and login — never a page view a
 * crawler would make. */
export function TurnstileSettingsPanel() {
  const [settings, setSettings] = React.useState<TurnstileSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [enabled, setEnabled] = React.useState(false);
  const [siteKeyInput, setSiteKeyInput] = React.useState("");
  const [secretKeyInput, setSecretKeyInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getTurnstileSettings()
      .then((result) => {
        setSettings(result);
        setEnabled(result.turnstile_enabled);
        setSiteKeyInput(result.turnstile_site_key ?? "");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load bot-verification settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateTurnstileSettings({
        turnstile_enabled: enabled,
        turnstile_site_key: siteKeyInput.trim() || null,
        ...(secretKeyInput.trim() ? { turnstile_secret_key: secretKeyInput.trim() } : {}),
      });
      setSettings(result);
      setSecretKeyInput("");
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
        <LoadingSpinner label="Loading bot-verification settings…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-4 w-4" />
          Bot verification
        </h3>
        <p className="text-xs text-muted-foreground">
          Cloudflare Turnstile — a mostly-invisible human check on the public chat&apos;s first message,
          the contact form, and login. Off by default. Only ever gates those three write actions, never a
          page view, so it has no effect on search/AI crawlers reading your site.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Switch checked={enabled} onCheckedChange={(c) => setEnabled(Boolean(c))} />
        <Label className="text-sm">Require bot verification</Label>
      </div>

      <div className="space-y-3 rounded-lg border border-dashed p-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Site key</Label>
          <Input
            value={siteKeyInput}
            onChange={(e) => setSiteKeyInput(e.target.value)}
            placeholder="0x4AAAAAAA…"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Secret key</Label>
          <Input
            type="password"
            value={secretKeyInput}
            onChange={(e) => setSecretKeyInput(e.target.value)}
            placeholder={settings.turnstile_secret_key_set ? "•••••••• (leave blank to keep saved key)" : "0x4AAAAAAA…"}
          />
          {settings.turnstile_secret_key_set ? (
            <Badge variant="secondary" className="text-xs">
              Saved
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Get both from the Cloudflare dashboard (Turnstile → Add site) — free, no account minimum.
        </p>
      </div>

      <div className="flex items-center gap-2 border-t pt-4">
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
