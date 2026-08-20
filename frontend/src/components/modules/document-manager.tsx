"use client";

import * as React from "react";
import { FileText, RefreshCw, Trash2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { FileDropzone } from "@/components/common/file-dropzone";
import { Pagination } from "@/components/common/pagination";
import { ApiError } from "@/lib/api";
import { fileToBase64 } from "@/lib/file";
import {
  deleteDocument,
  ingestDocument,
  listDocuments,
  reembedAllDocuments,
  type DocumentSummary,
  type DocumentStatus,
  type ReembedAllResult,
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
const PAGE_SIZE = 20;

export function DocumentManager() {
  const [file, setFile] = React.useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [documents, setDocuments] = React.useState<DocumentSummary[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [staleCount, setStaleCount] = React.useState(0);
  const [listError, setListError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);
  const [reembedStatus, setReembedStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [reembedError, setReembedError] = React.useState<string | null>(null);
  const [reembedResult, setReembedResult] = React.useState<ReembedAllResult | null>(null);

  const refresh = React.useCallback(() => {
    listDocuments(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .then((result) => {
        setDocuments(result.items);
        setTotal(result.total);
        // Across every document, not just this page — see
        // lib/documents.ts's DocumentListResult doc comment.
        setStaleCount(result.needs_reembed_count);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load documents."));
  }, [page]);

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
      // A new document sorts first (most-recent-first order) — jump
      // back to page 1 so it's actually visible.
      if (page === 1) refresh();
      else setPage(1);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed — is the backend reachable?");
      setUploadStatus("error");
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    try {
      await deleteDocument(id);
      // Deleting the only item left on a non-first page would otherwise
      // strand the view on a now-empty page — step back one instead.
      if (documents?.length === 1 && page > 1) {
        setPage((p) => p - 1);
      } else {
        refresh();
      }
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleReembedAll() {
    setReembedStatus("loading");
    setReembedError(null);
    setReembedResult(null);
    try {
      const result = await reembedAllDocuments();
      setReembedResult(result);
      setReembedStatus("idle");
      refresh();
    } catch (err) {
      setReembedError(err instanceof ApiError ? err.message : "Re-embed failed — is the backend reachable?");
      setReembedStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Knowledge base documents</h3>
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
        {staleCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              {staleCount} document{staleCount === 1 ? "" : "s"} embedded under a different provider than
              the one currently selected — re-embed to make {staleCount === 1 ? "it" : "them"} searchable
              again.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReembedAll}
              disabled={reembedStatus === "loading"}
            >
              <RefreshCw className="size-4" />
              {reembedStatus === "loading" ? "Re-embedding…" : "Re-embed all documents"}
            </Button>
          </div>
        ) : null}
        {reembedStatus === "error" && reembedError ? (
          <ErrorMessage description={reembedError} onRetry={() => setReembedStatus("idle")} />
        ) : null}
        {reembedResult ? (
          <p className="text-xs text-muted-foreground">
            Re-embedded {reembedResult.succeeded}/{reembedResult.processed} document
            {reembedResult.processed === 1 ? "" : "s"}
            {reembedResult.failed.length > 0 ? ` — ${reembedResult.failed.length} failed` : ""}.
          </p>
        ) : null}

        {listError ? <ErrorMessage description={listError} onRetry={refresh} /> : null}
        {documents === null && !listError ? <LoadingSpinner label="Loading documents…" /> : null}
        {documents !== null && total === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Upload one above to start building the knowledge base."
          />
        ) : null}
        {total > 0 ? <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} /> : null}
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
              {doc.needs_reembed ? (
                <Badge variant="outline" className="text-[10px]">
                  Needs re-embed
                </Badge>
              ) : null}
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
