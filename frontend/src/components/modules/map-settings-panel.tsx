"use client";

import * as React from "react";
import { MapPin } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getMapSettings, updateMapSettings, type MapSettings } from "@/lib/maps";

const MAP_PROVIDER_OPTIONS = [
  { value: "test" as const, label: "No live embed (redirect link only)" },
  { value: "google" as const, label: "Google Maps" },
];

/** Owner-facing map-provider picker (2026-08-21, backend/apis/maps.py) —
 * mirrors PaymentSettingsPanel/NotificationSettingsPanel's write-only-
 * secret UX exactly. Test mode is the default: a Map block still always
 * links out to Google Maps with zero configuration (see MapBlock's own
 * docstring); a real provider here adds a live in-page iframe on top of
 * that floor. */
export function MapSettingsPanel() {
  const [settings, setSettings] = React.useState<MapSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [provider, setProvider] = React.useState<"test" | "google">("test");
  const [apiKeyInput, setApiKeyInput] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getMapSettings()
      .then((result) => {
        setSettings(result);
        setProvider(result.map_provider === "google" ? "google" : "test");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load map settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateMapSettings({
        map_provider: provider,
        ...(apiKeyInput.trim() ? { google_maps_api_key: apiKeyInput.trim() } : {}),
      });
      setSettings(result);
      setApiKeyInput("");
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
        <LoadingSpinner label="Loading map settings…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <MapPin className="h-4 w-4" />
          Map
        </h3>
        <p className="text-xs text-muted-foreground">
          A Map block (insertable via the page editor) always links out to Google Maps, even with
          nothing configured here. Picking Google Maps below adds a live, in-page map on top of that
          link.
        </p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Provider</Label>
        <Select value={provider} onValueChange={(v) => v && setProvider(v as "test" | "google")}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAP_PROVIDER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {provider === "google" ? (
        <div className="space-y-1 rounded-lg border border-dashed p-3">
          <Label className="text-xs text-muted-foreground">Google Maps Embed API key</Label>
          <Input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={settings.google_maps_api_key_set ? "•••••••• (leave blank to keep saved key)" : "AIza…"}
          />
          {settings.google_maps_api_key_set ? (
            <Badge variant="secondary" className="text-xs">
              Saved
            </Badge>
          ) : null}
        </div>
      ) : null}

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
