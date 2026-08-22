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
  /** Set only for a document added via ingestFromUrl (2026-08-21) — null
   * for a plain file upload. DocumentManager shows this as a link plus a
   * "Re-sync" action (resyncDocument); ScheduledTasksPanel's
   * "resync_url_document" task type re-fetches it on a recurring basis. */
  source_url: string | null;
  /** True (default) = this document states facts about the business
   * itself; False = background reference material (a law, a
   * regulation) the business operates within but doesn't own — e.g. the
   * motivating example, a jurisdiction's own constitution/statutes.
   * Only affects what feeds generate_geo_page/detect_business_type/
   * business-profile-suggest (company-profile synthesis); ordinary RAG
   * retrieval for /chat still searches every ready document regardless,
   * just labels a False one to the model as background reference, not
   * an authoritative company fact. */
  is_company_material: boolean;
  /** Free-text status note (2026-08-21) — e.g. "Repealed 2024-01-01,
   * replaced by SB-123." Owner-typed, or LLM-suggested at ingest time
   * (see ingestDocument/ingestFromUrl's suggestStatusNote param) —
   * conservative by design, only ever set when the source text
   * explicitly states its own status, never a guess. Null is the common
   * case (no behavior change). Shown to the model in RAG context
   * alongside a retrieved chunk from this document — see the root
   * AGENTS.md's "Document classification" section. */
  status_note: string | null;
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
export function ingestDocument(
  filename: string,
  contentType: string,
  contentBase64: string,
  isCompanyMaterial = true,
  suggestStatusNote = false,
) {
  return apiFetch<DocumentSummary>("/api/agent/documents/ingest", {
    method: "POST",
    body: {
      filename,
      content_type: contentType,
      content_base64: contentBase64,
      is_company_material: isCompanyMaterial,
      suggest_status_note: suggestStatusNote,
    },
  });
}

/** Toggles is_company_material and/or edits status_note after the fact
 * — omit a param (leave it undefined) to leave that field untouched;
 * pass an empty string for statusNote to clear it. Doesn't touch
 * status/chunks/embeddings, purely classification metadata. */
export function updateDocument(id: number, isCompanyMaterial?: boolean, statusNote?: string) {
  return apiFetch<DocumentSummary>(`/api/agent/documents/${id}`, {
    method: "PATCH",
    body: {
      ...(isCompanyMaterial !== undefined ? { is_company_material: isCompanyMaterial } : {}),
      ...(statusNote !== undefined ? { status_note: statusNote } : {}),
    },
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

/** Fetches one or more URLs and ingests each as a document (2026-08-21)
 * — a webpage's own main text is extracted automatically, or a URL
 * pointing directly at a PDF/DOCX is parsed the same way an upload
 * would be. Returns immediately with `pending` rows; the actual fetch/
 * parse/chunk/embed work runs in the background — watch status flip to
 * ready/error via listDocuments (refresh or re-poll), same as any other
 * document. A single string or an array — the backend accepts both
 * shapes directly, no need to normalize client-side. `isCompanyMaterial`
 * applies to every URL in this call — see DocumentSummary's own doc
 * comment. `suggestStatusNote`, when true, classifies each URL's own
 * text independently (a batch plausibly has a genuine mix of current/
 * repealed/proposed sources). */
export function ingestFromUrl(url: string | string[], isCompanyMaterial = true, suggestStatusNote = false) {
  return apiFetch<{ documents: DocumentSummary[] }>("/api/agent/documents/ingest-from-url", {
    method: "POST",
    body: { url, is_company_material: isCompanyMaterial, suggest_status_note: suggestStatusNote },
  });
}

/** Manually re-fetches and re-embeds a URL-sourced document right now —
 * only valid for a document with source_url set (400s otherwise, same
 * as the backend). Runs in the background like ingestFromUrl. */
export function resyncDocument(id: number, suggestStatusNote = false) {
  return apiFetch<DocumentSummary>(
    `/api/agent/documents/${id}/resync?suggest_status_note=${suggestStatusNote}`,
    { method: "POST" },
  );
}

/** Re-parses and re-embeds every document's raw file against whatever
 * embedding provider/model is currently configured — the recovery step
 * after switching embedding providers in ModelSettingsPanel clears
 * everyone's chunks. Synchronous, same tradeoff as ingestDocument — can
 * take a while for many documents. */
export function reembedAllDocuments() {
  return apiFetch<ReembedAllResult>("/api/agent/documents/reembed-all", { method: "POST" });
}
