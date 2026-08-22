import { apiFetch } from "@/lib/api";
import type { CrmEntry } from "@/lib/crm";
import type { Order } from "@/lib/orders";

/** Self-service account-scoped views (2026-08-22, backend/apis/
 * my_account.py) — "user isolation": any logged-in account (any role,
 * via `apiFetch`'s automatic Authorization header, see lib/auth.ts) sees
 * only ITS OWN orders/CRM entries/chat history, never anyone else's.
 * 401s if not logged in at all — genuinely different from every other
 * lib/*.ts admin client in this app (those are role-gated to admin/
 * owner and see EVERYONE's data). */

export type MyOrdersResult = {
  items: Order[];
  total: number;
};

export function listMyOrders(limit = 20, offset = 0) {
  return apiFetch<MyOrdersResult>(`/api/my/orders?limit=${limit}&offset=${offset}`);
}

export function listMyCrmEntries() {
  return apiFetch<CrmEntry[]>("/api/my/crm-entries");
}

export type MyChatSessionSummary = {
  id: number;
  session_key: string;
  created_at: string;
  last_seen_at: string;
  message_count: number;
};

export function listMyChatSessions() {
  return apiFetch<MyChatSessionSummary[]>("/api/my/chat-sessions");
}

export type MyChatMessageSummary = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export function getMyChatSessionMessages(sessionId: number) {
  return apiFetch<MyChatMessageSummary[]>(`/api/my/chat-sessions/${sessionId}/messages`);
}
