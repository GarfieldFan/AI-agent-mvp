import { apiFetch } from "@/lib/api";

/** Admin/owner only — see backend/apis/agent.py's `generate_poster`. Real
 * as of 2026-08-04: submits a ComfyUI text-to-image job, waits for it to
 * finish, and (if `overlayText` is non-empty) composites real rendered
 * text onto the result. Slow — budget up to ~1-3 minutes depending on the
 * GPU, same order of magnitude as generate_landing_page. */
export function generatePoster(prompt: string, overlayText: string) {
  return apiFetch<{ image_url: string }>("/api/agent/poster/generate", {
    method: "POST",
    body: { prompt, overlay_text: overlayText },
  });
}
