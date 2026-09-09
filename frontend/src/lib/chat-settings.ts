import { apiFetch } from "@/lib/api";

/** Owner-configurable public-chat system prompt (2026-08-21, backend/
 * apis/chat_settings.py) — the persona/behavior instructions sent on
 * every /api/chat turn. A FULL replacement, not an append-only override
 * — confirmed directly with the user; see apis/chat.py's
 * `_resolve_system_prompt` docstring for why that's safe: every dynamic
 * per-turn fact (RAG excerpts, visitor identity, order/cart state, ...)
 * is injected into the user message, never this system string, and the
 * lead-capture/order-extraction classification calls never read this
 * setting at all.
 *
 * `chat_intent_prompt` (2026-09-09) is a SEPARATE, independent prompt —
 * config layer only, not yet read by any live runtime. It's the
 * groundwork for eventually replacing chat-panel.tsx's hardcoded 3-step
 * category/tags/channel wizard with a real model decision about
 * whether/what structured question to ask a visitor before the main
 * reply. Saving it today has zero effect on live chat behavior. */
export type ChatPromptSettings = {
  chat_system_prompt: string | null;
  /** Always the built-in constant, regardless of what's stored — lets
   * ChatPromptSettingsPanel show/diff against it and power "Reset to
   * default" without a second hardcoded copy of this text. */
  default_chat_system_prompt: string;
  chat_intent_prompt: string | null;
  default_chat_intent_prompt: string;
};

export function getChatSettings() {
  return apiFetch<ChatPromptSettings>("/api/agent/chat-settings");
}

/** Each field is optional-independent: omit one to leave it untouched,
 * pass `null` to reset that one back to its own built-in default. */
export function updateChatSettings(input: { chat_system_prompt?: string | null; chat_intent_prompt?: string | null }) {
  return apiFetch<ChatPromptSettings>("/api/agent/chat-settings", {
    method: "PUT",
    body: input,
  });
}

export type SuggestIntentPromptResult = {
  suggestion: string;
  document_count: number;
};

/** Best-effort LLM draft from ingested company documents + any
 * configured IntentSchemas — never saves anything, mirrors
 * `business-profile.ts`'s `suggestBusinessProfile()` propose-then-
 * owner-applies pattern. `document_count: 0` means no ready documents
 * exist yet, `suggestion` comes back empty in that case. */
export function suggestIntentPrompt() {
  return apiFetch<SuggestIntentPromptResult>("/api/agent/chat-settings/suggest-intent-prompt", {
    method: "POST",
  });
}
