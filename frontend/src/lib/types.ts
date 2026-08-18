/** Shared domain types used across modules. Mirrors (a subset of) the
 * shapes the FastAPI backend is expected to return once each module's API
 * is implemented — see ai-mvp-project-plan.pdf, sections 三/四. */

export type Role = "owner" | "admin" | "user";

// ---------------------------------------------------------------------------
// Chatbot module — RAG citations. Matches backend/apis/chat.py's
// `ChatSource` shape (snake_case, no camelCase aliasing anywhere in this
// API — same convention as GeneratedPage.accent_color). Document
// *management* types (upload/list/delete) live in lib/documents.ts's
// `DocumentSummary`, not here.
//
// Used to be its own "RAG (knowledge base) module" with a dedicated
// /knowledge page and RagQueryResponse type — merged into the main
// chatbot 2026-08-04 (see the root AGENTS.md), so this is now just the
// citation shape a chat reply can optionally carry.
// ---------------------------------------------------------------------------

export type RagSource = {
  document_id: number;
  chunk_id: number;
  document_title: string;
  excerpt: string;
  score?: number;
};

// ---------------------------------------------------------------------------
// Chatbot module
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";

/** The LLM is expected to respond with one of these control types so the
 * frontend can render the matching input instead of plain text. */
export type ChatControlType = "text" | "radio" | "checkbox" | "select";

export type ChatOption = {
  label: string;
  value: string;
};

export type ChatControl = {
  type: ChatControlType;
  label?: string;
  options?: ChatOption[];
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  control?: ChatControl;
  /** RAG citations, when the reply was grounded in uploaded documents —
   * omitted (not just empty) for plain conversational replies. */
  sources?: RagSource[];
  /** Set on a user message that carried a POST /api/chat/upload
   * attachment (see lib/chat.ts's uploadChatAttachment) — local-only
   * rendering, never sent back by the backend on the assistant's reply. */
  attachmentUrl?: string;
  createdAt: string;
};
