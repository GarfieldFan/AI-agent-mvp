import { apiFetch } from "@/lib/api";
import type { GeneratedPage } from "@/lib/theme";

export type PageSummary = {
  slug: string;
  created_at: string;
  version_count: number;
  latest_version_at: string | null;
};

export type PageVersionSummary = {
  id: number;
  created_at: string;
  note: string | null;
};

export type SaveVersionResponse = {
  slug: string;
  version: PageVersionSummary;
};

/** Saves `content` as a new version of `slug` (creates the page if it's
 * new). Admin/owner only — see backend/apis/pages.py. */
export function savePageVersion(slug: string, content: GeneratedPage, note?: string) {
  return apiFetch<SaveVersionResponse>(`/api/agent/pages/${encodeURIComponent(slug)}/versions`, {
    method: "POST",
    body: { content, note: note || null },
  });
}

export function listPages() {
  return apiFetch<PageSummary[]>("/api/agent/pages");
}

export function listPageVersions(slug: string) {
  return apiFetch<PageVersionSummary[]>(`/api/agent/pages/${encodeURIComponent(slug)}/versions`);
}

/** Copies an old version's content into a brand-new version on top —
 * never deletes history, so a restore is itself undoable. */
export function restorePageVersion(slug: string, versionId: number) {
  return apiFetch<SaveVersionResponse>(
    `/api/agent/pages/${encodeURIComponent(slug)}/versions/${versionId}/restore`,
    { method: "POST" },
  );
}

/** Deletes a page and every one of its versions — unlike save/restore
 * above, this is destructive and has no undo. Admin/owner only. */
export function deletePage(slug: string) {
  return apiFetch<void>(`/api/agent/pages/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

/** Public — no RBAC. Fetches the slug's current (latest) content, or null
 * on a 404 (caller should fall back to a default template in that case). */
export async function getPublicPage(slug: string): Promise<GeneratedPage | null> {
  try {
    return await apiFetch<GeneratedPage>(`/api/pages/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}
