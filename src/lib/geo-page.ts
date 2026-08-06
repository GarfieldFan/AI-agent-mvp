import { apiFetch } from "@/lib/api";
import type { PageSection } from "@/lib/theme";

export const GEO_PAGE_SLUG = "seo";

export type GenerateGeoPageResponse = {
  slug: string;
  sections: PageSection[];
  document_count: number;
  version_id: number;
};

/** Client for backend/apis/agent.py's POST /agent/geo-page/generate —
 * admin/owner only. No request body: it always regenerates from every
 * ready-ingested RAG document and saves directly to GEO_PAGE_SLUG, so
 * there's no per-call config to send. */
export function generateGeoPage() {
  return apiFetch<GenerateGeoPageResponse>("/api/agent/geo-page/generate", { method: "POST" });
}
