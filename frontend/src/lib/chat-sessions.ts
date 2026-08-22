import { apiFetch } from "@/lib/api";

/** Admin/owner-only reader for the chat sessions/messages `/api/chat`
 * already persists on every turn (2026-08-21, backend/apis/chat_sessions.py)
 * — closes a real, long-flagged dashboard gap: `ReportPanel` only ever
 * showed aggregate day-by-day counts, nothing let an owner actually read
 * a transcript. Read-only — nothing here writes anything. */
export type ChatSessionSummary = {
  id: number;
  session_key: string;
  user_email: string | null;
  created_at: string;
  last_seen_at: string;
  message_count: number;
};

export type ChatSessionListResult = {
  items: ChatSessionSummary[];
  total: number;
};

export function listChatSessions(params: { q?: string; limit?: number; offset?: number } = {}) {
  const { q, limit = 20, offset = 0 } = params;
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) search.set("q", q);
  return apiFetch<ChatSessionListResult>(`/api/agent/chat-sessions?${search.toString()}`);
}

export type ChatMessageSummary = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type ChatSessionMessagesResult = {
  items: ChatMessageSummary[];
  total: number;
  session: ChatSessionSummary;
};

/** Oldest-first, paginated from the START of the conversation (`offset`
 * moves forward through it) — the opposite pagination direction from
 * every other list in this app (which page backward from "most recent"),
 * since "page 1" of a transcript means "the beginning," not "the latest
 * activity." See the backend route's own docstring. */
export function getChatSessionMessages(sessionId: number, limit = 50, offset = 0) {
  return apiFetch<ChatSessionMessagesResult>(
    `/api/agent/chat-sessions/${sessionId}/messages?limit=${limit}&offset=${offset}`,
  );
}
