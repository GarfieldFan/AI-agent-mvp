"use client";

import * as React from "react";
import { MessageSquareText, Route, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import {
  getChatSettings,
  suggestIntentPrompt,
  updateChatSettings,
  type ChatPromptSettings,
} from "@/lib/chat-settings";

/** Owner-facing editor for the public chatbot's system prompt (2026-08-21,
 * `lib/chat-settings.ts`) — a full, direct replacement of the built-in
 * persona/behavior instructions, not just additional rules layered on
 * top. Confirmed directly with the user: this is safe to allow in full
 * because the app's own real-time context (RAG excerpts, visitor
 * identity, order state, ...) is injected separately into each turn's
 * user message, and lead-capture/order-extraction run on their own
 * fixed prompts this setting can't touch — see `apis/chat.py`'s
 * `_resolve_system_prompt` docstring for the complete reasoning. Applies
 * globally and immediately, same posture as `ModelSettingsPanel`.
 *
 * Also renders the intent-triage prompt editor (2026-09-09) — a
 * SEPARATE, independent setting that is config-layer-only today (see
 * `lib/chat-settings.ts`'s doc comment): it has zero effect on live
 * chat behavior until a future round wires a real classification call
 * to it. Said plainly in this panel's own copy so an owner never
 * mistakes saving it for something already live. */
export function ChatPromptSettingsPanel() {
  const [settings, setSettings] = React.useState<ChatPromptSettings | null>(null);
  const [draft, setDraft] = React.useState("");
  const [intentDraft, setIntentDraft] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [intentSaveStatus, setIntentSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [intentSaveError, setIntentSaveError] = React.useState<string | null>(null);
  const [suggestStatus, setSuggestStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  const [suggestNote, setSuggestNote] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getChatSettings()
      .then((result) => {
        setSettings(result);
        setDraft(result.chat_system_prompt ?? result.default_chat_system_prompt);
        setIntentDraft(result.chat_intent_prompt ?? result.default_chat_intent_prompt);
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
      const result = await updateChatSettings({ chat_system_prompt: draft });
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
      const result = await updateChatSettings({ chat_system_prompt: null });
      setSettings(result);
      setDraft(result.default_chat_system_prompt);
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Reset failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleSaveIntent() {
    setIntentSaveStatus("saving");
    setIntentSaveError(null);
    try {
      const result = await updateChatSettings({ chat_intent_prompt: intentDraft });
      setSettings(result);
      setIntentSaveStatus("idle");
    } catch (err) {
      setIntentSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setIntentSaveStatus("error");
    }
  }

  async function handleResetIntentToDefault() {
    if (!settings) return;
    setIntentSaveStatus("saving");
    setIntentSaveError(null);
    try {
      const result = await updateChatSettings({ chat_intent_prompt: null });
      setSettings(result);
      setIntentDraft(result.default_chat_intent_prompt);
      setIntentSaveStatus("idle");
    } catch (err) {
      setIntentSaveError(err instanceof ApiError ? err.message : "Reset failed — is the backend reachable?");
      setIntentSaveStatus("error");
    }
  }

  async function handleSuggestIntent() {
    setSuggestStatus("loading");
    setSuggestError(null);
    setSuggestNote(null);
    try {
      const result = await suggestIntentPrompt();
      if (result.document_count === 0 || !result.suggestion.trim()) {
        setSuggestNote("No ready company documents found to draft from — upload some in Documents first.");
      } else {
        setIntentDraft(result.suggestion);
        setSuggestNote(`Drafted from ${result.document_count} document(s) — review below, then Save.`);
      }
      setSuggestStatus("idle");
    } catch (err) {
      setSuggestError(err instanceof ApiError ? err.message : "Draft failed — is the backend reachable?");
      setSuggestStatus("error");
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
  const isIntentCustom = Boolean(settings.chat_intent_prompt);

  return (
    <div className="space-y-6">
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

      <div className="space-y-3 rounded-xl border p-4">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Route className="h-4 w-4" />
            Intent-triage prompt
            {isIntentCustom ? (
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
            Guides the chatbot&apos;s decision, on the very first message of each conversation, whether
            asking one short clarifying question would help before replying — live as of the visitor&apos;s
            next chat. Leave the visitor&apos;s need clear and it asks nothing and answers directly.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSuggestIntent} disabled={suggestStatus === "loading"}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {suggestStatus === "loading" ? "Drafting…" : "Suggest from documents"}
          </Button>
          {suggestNote ? <span className="text-xs text-muted-foreground">{suggestNote}</span> : null}
        </div>
        {suggestStatus === "error" && suggestError ? (
          <ErrorMessage description={suggestError} onRetry={() => setSuggestStatus("idle")} />
        ) : null}

        <Textarea
          value={intentDraft}
          onChange={(e) => setIntentDraft(e.target.value)}
          rows={10}
          className="font-mono text-xs"
        />

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button onClick={handleSaveIntent} disabled={intentSaveStatus === "saving"}>
            {intentSaveStatus === "saving" ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            onClick={handleResetIntentToDefault}
            disabled={intentSaveStatus === "saving" || !isIntentCustom}
          >
            Reset to default
          </Button>
        </div>
        {intentSaveStatus === "error" && intentSaveError ? (
          <ErrorMessage description={intentSaveError} onRetry={() => setIntentSaveStatus("idle")} />
        ) : null}
      </div>
    </div>
  );
}
