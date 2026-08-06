import { apiFetch } from "@/lib/api";
import type { RagSource } from "@/lib/types";

export type ChatApiTurn = {
  role: "user" | "assistant";
  content: string;
};

type ChatApiResponse = {
  reply: string;
  sources: RagSource[];
};

const SESSION_STORAGE_KEY = "chat_session_id";

/** Client-generated id (localStorage-persisted, survives page reloads)
 * identifying one visitor's conversation across /api/chat calls, sent as
 * `session_id` so the backend can log turns under one ChatSession for
 * later market-research review — see backend/models.py's ChatSession
 * docstring and the root AGENTS.md. Not an auth mechanism: /api/chat has
 * none (see the RBAC architecture note there), this is purely a grouping
 * key for an anonymous, unauthenticated endpoint. Only ever called from a
 * client component's event handler, so `window` is always defined. */
function getChatSessionId(): string {
  let id = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

/** Calls the user-tier chat endpoint (POST /api/chat) — LLM inference
 * against the owner-selected chat model, no tools/agent access, optionally
 * grounded in uploaded documents (RAG merged in 2026-08-04, see the repo
 * root AGENTS.md). `sources` is `[]` for a plain conversational reply, not
 * just when nothing's been uploaded yet — retrieval always runs, but
 * irrelevant matches are dropped server-side before they'd ever reach
 * here. See backend/apis/chat.py and the repo root AGENTS.md's
 * architecture note for why this is deliberately the only backend path
 * the public chatbot can reach. */
export async function sendChatMessage(
  message: string,
  history: ChatApiTurn[] = [],
): Promise<{ reply: string; sources: RagSource[] }> {
  const response = await apiFetch<ChatApiResponse>("/api/chat", {
    method: "POST",
    body: { message, history, session_id: getChatSessionId() },
  });
  return { reply: response.reply, sources: response.sources };
}
