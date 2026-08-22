"use client";

import * as React from "react";
import { MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getChatSettings, updateChatSettings, type ChatPromptSettings } from "@/lib/chat-settings";

/** Owner-facing editor for the public chatbot's system prompt (2026-08-21,
 * `lib/chat-settings.ts`) — a full, direct replacement of the built-in
 * persona/behavior instructions, not just additional rules layered on
 * top. Confirmed directly with the user: this is safe to allow in full
 * because the app's own real-time context (RAG excerpts, visitor
 * identity, order state, ...) is injected separately into each turn's
 * user message, and lead-capture/order-extraction run on their own
 * fixed prompts this setting can't touch — see `apis/chat.py`'s
 * `_resolve_system_prompt` docstring for the complete reasoning. Applies
 * globally and immediately, same posture as `ModelSettingsPanel`. */
export function ChatPromptSettingsPanel() {
  const [settings, setSettings] = React.useState<ChatPromptSettings | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getChatSettings()
      .then((result) => {
        setSettings(result);
        setDraft(result.chat_system_prompt ?? result.default_chat_system_prompt);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load chat prompt settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateChatSettings(draft);
      setSettings(result);
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleResetToDefault() {
    if (!settings) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateChatSettings(null);
      setSettings(result);
      setDraft(result.default_chat_system_prompt);
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Reset failed — is the backend reachable?");
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
        <LoadingSpinner label="Loading chat prompt settings…" />
      </div>
    );
  }

  const isCustom = Boolean(settings.chat_system_prompt);

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <MessageSquareText className="h-4 w-4" />
          Public chat system prompt
          {isCustom ? (
            <Badge variant="secondary" className="text-xs">
              Customized
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              Default
            </Badge>
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          Controls the public chatbot&apos;s tone, persona, and behavior rules on every `/chat` turn.
          Replacing this text fully replaces the default below — it does not change what data the
          chatbot has access to (uploaded documents, product catalog, in-progress requests all keep
          working exactly the same, since those are injected separately on every turn).
        </p>
      </div>

      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} className="font-mono text-xs" />

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button onClick={handleSave} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={handleResetToDefault} disabled={saveStatus === "saving" || !isCustom}>
          Reset to default
        </Button>
      </div>
      {saveStatus === "error" && saveError ? (
        <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
      ) : null}
    </div>
  );
}
