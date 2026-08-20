import { apiFetch } from "@/lib/api";

export type DocumentStatus = "pending" | "processing" | "ready" | "error";

export type DocumentSummary = {
  id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: DocumentStatus;
  error_message: string | null;
  chunk_count: number;
  uploaded_by: string | null;
  created_at: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  // True when this document's chunks were embedded under a different
  // provider/model than the currently-configured one (e.g. the owner
  // switched embedding providers in ModelSettingsPanel since this
  // document was last ingested) — see reembedAllDocuments below.
  needs_reembed: boolean;
};

export type ReembedFailure = {
  document_id: number;
  filename: string;
  error: string;
};

export type ReembedAllResult = {
  processed: number;
  succeeded: number;
  failed: ReembedFailure[];
};

/** Admin/owner only — see backend/apis/documents.py. Synchronous: this
 * doesn't resolve until parsing + chunking + embedding all finish (same
 * tradeoff generate_landing_page makes), so a real document can take a
 * few seconds to tens of seconds depending on size. */
export function ingestDocument(filename: string, contentType: string, contentBase64: string) {
  return apiFetch<DocumentSummary>("/api/agent/documents/ingest", {
    method: "POST",
    body: { filename, content_type: contentType, content_base64: contentBase64 },
  });
}

export type DocumentListResult = {
  items: DocumentSummary[];
  total: number;
  /** Stale-document count across EVERY document, not just this page —
   * see backend/apis/documents.py's DocumentListResponse docstring. */
  needs_reembed_count: number;
};

/** Paginated (2026-08-20, was a plain unbounded fetch — see the root
 * AGENTS.md). */
export function listDocuments(limit = 50, offset = 0) {
  return apiFetch<DocumentListResult>(`/api/agent/documents?limit=${limit}&offset=${offset}`);
}

export function deleteDocument(id: number) {
  return apiFetch<void>(`/api/agent/documents/${id}`, { method: "DELETE" });
}

/** Re-parses and re-embeds every document's raw file against whatever
 * embedding provider/model is currently configured — the recovery step
 * after switching embedding providers in ModelSettingsPanel clears
 * everyone's chunks. Synchronous, same tradeoff as ingestDocument — can
 * take a while for many documents. */
export function reembedAllDocuments() {
  return apiFetch<ReembedAllResult>("/api/agent/documents/reembed-all", { method: "POST" });
}
