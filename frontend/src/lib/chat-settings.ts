import { apiFetch } from "@/lib/api";

/** Owner-configurable public-chat system prompt (2026-08-21, backend/
 * apis/chat_settings.py) — the persona/behavior instructions sent on
 * every /api/chat turn. A FULL replacement, not an append-only override
 * — confirmed directly with the user; see apis/chat.py's
 * `_resolve_system_prompt` docstring for why that's safe: every dynamic
 * per-turn fact (RAG excerpts, visitor identity, order/cart state, ...)
 * is injected into the user message, never this system string, and the
 * lead-capture/order-extraction classification calls never read this
 * setting at all. */
export type ChatPromptSettings = {
  chat_system_prompt: string | null;
  /** Always the built-in constant, regardless of what's stored — lets
   * ChatPromptSettingsPanel show/diff against it and power "Reset to
   * default" without a second hardcoded copy of this text. */
  default_chat_system_prompt: string;
};

export function getChatSettings() {
  return apiFetch<ChatPromptSettings>("/api/agent/chat-settings");
}

/** `chatSystemPrompt: null` resets to the built-in default. */
export function updateChatSettings(chatSystemPrompt: string | null) {
  return apiFetch<ChatPromptSettings>("/api/agent/chat-settings", {
    method: "PUT",
    body: { chat_system_prompt: chatSystemPrompt },
  });
}
