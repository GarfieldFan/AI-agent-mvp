import { apiFetch } from "@/lib/api";

export type MediaItem = {
  filename: string;
  url: string;
  source: "comfyui" | "upload";
  created_at: string;
};

export type MediaListResult = {
  items: MediaItem[];
  total: number;
};

/** Client for backend/apis/media.py — the CTE image field editor's
 * "Library" and "Upload" tabs (admin/owner only). "Generate" reuses
 * lib/poster.ts's generatePoster directly (with an empty overlay text)
 * rather than duplicating a client here — see ImageFieldEditor.
 * Paginated (2026-08-20, was a plain unbounded fetch — see the root
 * AGENTS.md). */
export function listMedia(limit = 24, offset = 0) {
  return apiFetch<MediaListResult>(`/api/agent/media?limit=${limit}&offset=${offset}`);
}

export function uploadMedia(filename: string, contentBase64: string) {
  return apiFetch<{ filename: string; url: string }>("/api/agent/media/upload", {
    method: "POST",
    body: { filename, content_base64: contentBase64 },
  });
}
