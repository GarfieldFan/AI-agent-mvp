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

export function listDocuments() {
  return apiFetch<DocumentSummary[]>("/api/agent/documents");
}

export function deleteDocument(id: number) {
  return apiFetch<void>(`/api/agent/documents/${id}`, { method: "DELETE" });
}
