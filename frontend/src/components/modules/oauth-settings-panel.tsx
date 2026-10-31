"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretKeyField } from "@/components/common/secret-key-field";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getOAuthSettings, updateOAuthSettings, type OAuthSettings } from "@/lib/oauth";

/** Owner-facing OAuth credential config (2026-08-22, backend/apis/
 * oauth.py) — same write-only-secret UX as `payment-settings-panel.tsx`/
 * `map-settings-panel.tsx`/`notification-settings-panel.tsx`, one block
 * per provider sharing a single Save button (mirrors
 * `NotificationSettingsPanel`'s Email/SMS shape exactly). Google was
 * built first as the reference implementation; Facebook follows the same
 * authorization-code-grant flow. X does NOT — it uses OAuth 2.0 + PKCE,
 * and its standard API doesn't reliably return an email address without
 * an elevated Developer Portal permission this app has no control over —
 * flagged directly in its own block below, not hidden. This is for the
 * public `user` tier ONLY — admin/owner accounts never use OAuth, a
 * deliberate, confirmed design choice, not an oversight. */
export function OAuthSettingsPanel() {
  const [settings, setSettings] = React.useState<OAuthSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [googleClientId, setGoogleClientId] = React.useState("");
  const [googleClientSecretInput, setGoogleClientSecretInput] = React.useState("");
  const [facebookClientId, setFacebookClientId] = React.useState("");
  const [facebookClientSecretInput, setFacebookClientSecretInput] = React.useState("");
  const [xClientId, setXClientId] = React.useState("");
  const [xClientSecretInput, setXClientSecretInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getOAuthSettings()
      .then((result) => {
        setSettings(result);
        setGoogleClientId(result.google_client_id ?? "");
        setFacebookClientId(result.facebook_client_id ?? "");
        setXClientId(result.x_client_id ?? "");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load OAuth settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateOAuthSettings({
        google_client_id: googleClientId.trim() || null,
        ...(googleClientSecretInput.trim() ? { google_client_secret: googleClientSecretInput.trim() } : {}),
        facebook_client_id: facebookClientId.trim() || null,
        ...(facebookClientSecretInput.trim() ? { facebook_client_secret: facebookClientSecretInput.trim() } : {}),
        x_client_id: xClientId.trim() || null,
        ...(xClientSecretInput.trim() ? { x_client_secret: xClientSecretInput.trim() } : {}),
      });
      setSettings(result);
      setGoogleClientSecretInput("");
      setFacebookClientSecretInput("");
      setXClientSecretInput("");
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
        <LoadingSpinner label="Loading OAuth settings…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-4 w-4" />
          Social login
        </h3>
        <p className="text-xs text-muted-foreground">
          Lets a visitor sign in with Google/Facebook/X instead of creating a password — for the
          public site only. Admin/owner accounts always use the password login above, never this.
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Google</h4>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Authorized redirect URI (paste into Google Cloud Console)
          </Label>
          <Input
            readOnly
            value={settings.google_callback_url}
            className="font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Client ID</Label>
          <Input
            value={googleClientId}
            onChange={(e) => setGoogleClientId(e.target.value)}
            placeholder="....apps.googleusercontent.com"
          />
        </div>
        <div className="space-y-1">
          <SecretKeyField label="Client secret" value={googleClientSecretInput} onChange={setGoogleClientSecretInput} saved={settings.google_client_secret_set} placeholder={"GOCSPX-…"} />
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-medium">Facebook</h4>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Valid OAuth redirect URI (paste into the Facebook app&apos;s Login settings)
          </Label>
          <Input
            readOnly
            value={settings.facebook_callback_url}
            className="font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">App ID</Label>
          <Input value={facebookClientId} onChange={(e) => setFacebookClientId(e.target.value)} placeholder="123456789012345" />
        </div>
        <div className="space-y-1">
          <SecretKeyField label="App secret" value={facebookClientSecretInput} onChange={setFacebookClientSecretInput} saved={settings.facebook_client_secret_set} placeholder={"…"} />
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-medium">X</h4>
        <p className="text-xs text-muted-foreground">
          X&apos;s standard API does not reliably return an email address — that needs an elevated
          permission from X&apos;s own Developer Portal that isn&apos;t guaranteed to be approved.
          Sign-in may fail after redirecting back here even with valid credentials, depending on
          what your X app is actually approved for.
        </p>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Callback URI (paste into the X app&apos;s User authentication settings)
          </Label>
          <Input
            readOnly
            value={settings.x_callback_url}
            className="font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Client ID</Label>
          <Input value={xClientId} onChange={(e) => setXClientId(e.target.value)} placeholder="…" />
        </div>
        <div className="space-y-1">
          <SecretKeyField label="Client secret" value={xClientSecretInput} onChange={setXClientSecretInput} saved={settings.x_client_secret_set} placeholder={"…"} />
        </div>
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
