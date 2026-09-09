import { apiFetch } from "@/lib/api";
import type { ChatControl, ChatProductCard, RagSource } from "@/lib/types";

export type ChatApiTurn = {
  role: "user" | "assistant";
  content: string;
};

type ChatApiResponse = {
  reply: string;
  sources: RagSource[];
  products: ChatProductCard[] | null;
  search_link: string | null;
  // Real LLM-driven intent triage (2026-09-09, backend/apis/chat.py's
  // _intent_triage_call) — a structured clarifying question for a
  // conversation's very first turn, when the model judges one would
  // help. null for every ordinary reply.
  control: ChatControl | null;
};

type ChatUploadResponse = {
  filename: string;
  url: string;
};

const SESSION_STORAGE_KEY = "chat_session_id";

/** Client-generated id (localStorage-persisted, survives page reloads)
 * identifying one visitor's conversation across /api/chat calls, sent as
 * `session_id` so the backend can log turns under one ChatSession for
 * later market-research review — see backend/models.py's ChatSession
 * docstring and the root AGENTS.md. Not an auth mechanism: /api/chat has
 * none (see the RBAC architecture note there), this is purely a grouping
 * key for an anonymous, unauthenticated endpoint. Only ever called from a
 * client component's event handler, so `window` is always defined.
 *
 * **Exported** (2026-08-19) so lib/cart.ts's addToCart can reuse the
 * exact same id — a visitor's cart (backend/cart.py's Order lookup) has
 * to resolve to the same ChatSession whether they click "Add to cart"
 * on a page or talk in the chatbot, or the two would never see each
 * other's items. */
export function getChatSessionId(): string {
  let id = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

/** Overwrites the stored session id — the recovery half of
 * getChatSessionId (2026-08-20, see components/modules/session-id-
 * bootstrap.tsx). Losing this id (cleared localStorage, a different
 * device/browser) otherwise means a visitor's in-progress cart becomes
 * unreachable — the order still exists server-side, but nothing in the
 * UI can find it again. A link carrying `?sid=<this id>` (e.g. saved
 * from /cart's own "Save this cart" button, or a dine-in table's own
 * printed QR code) restores it with zero backend lookup. Doesn't
 * validate the id is a real, known session — an unrecognized id just
 * behaves like a brand-new empty cart, same as any id getChatSessionId
 * would generate on its own. */
export function restoreChatSessionId(sid: string): void {
  const trimmed = sid.trim();
  if (!trimmed) return;
  window.localStorage.setItem(SESSION_STORAGE_KEY, trimmed);
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
  attachmentUrl?: string,
  turnstileToken?: string,
): Promise<{
  reply: string;
  sources: RagSource[];
  products: ChatProductCard[] | null;
  searchLink: string | null;
  control: ChatControl | null;
}> {
  const response = await apiFetch<ChatApiResponse>("/api/chat", {
    method: "POST",
    body: {
      message,
      history,
      session_id: getChatSessionId(),
      attachment_url: attachmentUrl ?? null,
      // Bot verification (2026-09-10) — only ever checked server-side on
      // a conversation's first turn (empty history); harmless to include
      // on every call, see backend/apis/chat.py's own gate.
      turnstile_token: turnstileToken ?? null,
    },
  });
  return {
    reply: response.reply,
    sources: response.sources,
    products: response.products,
    searchLink: response.search_link,
    control: response.control,
  };
}

/** Uploads one photo/PDF ahead of a chat turn (`POST /api/chat/upload`,
 * same public/no-auth tier as `sendChatMessage` — see
 * backend/apis/chat.py's "Chat file attachment" docstring section for the
 * validation this endpoint applies since it has no RBAC gate at all).
 * Returns the stored URL to pass into `sendChatMessage`. Sends the same
 * `session_id` `sendChatMessage` does — the backend stores this file
 * under a folder keyed by that id (or the caller's account email if
 * logged in), see backend/chat_attachments.py. */
export async function uploadChatAttachment(filename: string, contentBase64: string): Promise<ChatUploadResponse> {
  return apiFetch<ChatUploadResponse>("/api/chat/upload", {
    method: "POST",
    body: { filename, content_base64: contentBase64, session_id: getChatSessionId() },
  });
}
