import { apiFetch } from "@/lib/api";

export type MediaItem = {
  filename: string;
  url: string;
  source: "comfyui" | "upload";
  created_at: string;
};

/** Client for backend/apis/media.py — the CTE image field editor's
 * "Library" and "Upload" tabs (admin/owner only). "Generate" reuses
 * lib/poster.ts's generatePoster directly (with an empty overlay text)
 * rather than duplicating a client here — see ImageFieldEditor. */
export function listMedia() {
  return apiFetch<MediaItem[]>("/api/agent/media");
}

export function uploadMedia(filename: string, contentBase64: string) {
  return apiFetch<{ filename: string; url: string }>("/api/agent/media/upload", {
    method: "POST",
    body: { filename, content_base64: contentBase64 },
  });
}
