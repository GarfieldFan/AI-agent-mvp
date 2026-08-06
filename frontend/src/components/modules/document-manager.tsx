"use client";

import * as React from "react";
import { FileText, Trash2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ApiError } from "@/lib/api";
import { fileToBase64 } from "@/lib/file";
import {
  deleteDocument,
  ingestDocument,
  listDocuments,
  type DocumentSummary,
  type DocumentStatus,
} from "@/lib/documents";

const STATUS_BADGE: Record<DocumentStatus, { label: string; variant: "outline" | "secondary" | "default" | "destructive" }> = {
  pending: { label: "Pending", variant: "outline" },
  processing: { label: "Processing", variant: "secondary" },
  ready: { label: "Ready", variant: "default" },
  error: { label: "Error", variant: "destructive" },
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** RAG document management (backend/apis/documents.py) — upload feeds the
 * ingest pipeline (parse -> chunk -> embed -> store), synchronously, so
 * "Upload" doesn't resolve until it's actually done or failed. Admin/owner
 * only; the public chatbot (/chat) only ever *reads* what's ingested here,
 * via backend/retrieval.py — see the root AGENTS.md's 2026-08-04 note on
 * merging the old standalone /knowledge page into the main chatbot. */
export function DocumentManager() {
  const [file, setFile] = React.useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [documents, setDocuments] = React.useState<DocumentSummary[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const refresh = React.useCallback(() => {
    listDocuments()
      .then((docs) => {
        setDocuments(docs);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load documents."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleUpload() {
    if (!file) return;
    setUploadStatus("loading");
    setUploadError(null);
    try {
      const dataUri = await fileToBase64(file);
      await ingestDocument(file.name, file.type, dataUri);
      setFile(null);
      setUploadStatus("idle");
      refresh();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed — is the backend reachable?");
      setUploadStatus("error");
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    try {
      await deleteDocument(id);
      refresh();
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Knowledge base documents</h3>
        <p className="text-xs text-muted-foreground">
          Upload a PDF, DOCX, Markdown, or text file — it&apos;s parsed, chunked, and
          embedded into the RAG vector store. The public <code>/chat</code> chatbot
          draws on these when a visitor asks something relevant.
        </p>
      </div>

      <FileDropzone
        file={file}
        onFileChange={setFile}
        accept=".pdf,.docx,.md,.txt,application/pdf,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        label="Drag & drop a document here, or click to browse"
        disabled={uploadStatus === "loading"}
      />
      <Button onClick={handleUpload} disabled={!file || uploadStatus === "loading"}>
        <UploadCloud className="size-4" />
        Upload
      </Button>

      {uploadStatus === "loading" ? (
        <LoadingSpinner label="Parsing, chunking, and embedding — this can take a little while…" />
      ) : null}
      {uploadStatus === "error" && uploadError ? (
        <ErrorMessage description={uploadError} onRetry={() => setUploadStatus("idle")} />
      ) : null}

      <div className="space-y-2 border-t pt-4">
        {listError ? <ErrorMessage description={listError} onRetry={refresh} /> : null}
        {documents === null && !listError ? <LoadingSpinner label="Loading documents…" /> : null}
        {documents && documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Upload one above to start building the knowledge base."
          />
        ) : null}
        {documents?.map((doc) => (
          <div key={doc.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="flex min-w-0 items-start gap-2">
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{doc.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {formatSize(doc.size_bytes)}
                  {doc.status === "ready" ? ` · ${doc.chunk_count} chunks` : ""}
                  {doc.status === "error" && doc.error_message ? ` · ${doc.error_message}` : ""}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={STATUS_BADGE[doc.status].variant}>{STATUS_BADGE[doc.status].label}</Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${doc.filename}`}
                onClick={() => handleDelete(doc.id)}
                disabled={deletingId !== null}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
