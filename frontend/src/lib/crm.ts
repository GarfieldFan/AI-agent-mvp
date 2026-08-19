import { apiFetch } from "@/lib/api";

// Was a fixed "new" | "contacted" | "closed" union — widened 2026-08-19
// alongside IntentView/ReviewQueuePanel (see lib/intent-views.ts):
// a review queue defines its own status vocabulary (e.g. "pending"/
// "approved"/"rejected"), enforced by whichever Select is actually
// rendering it, not a closed type here. The original three still work
// fine as plain strings.
export type CrmStatus = string;

export type CrmEntry = {
  crm_id: string;
  contact_email: string;
  /** Best-effort, filled in by backend/chat_attachments.py's automatic
   * extraction off an attached file when legible there — null otherwise. */
  contact_name: string | null;
  contact_phone: string | null;
  summary: string;
  tags: string[];
  category: string | null;
  status: CrmStatus;
  /** Set when apis/chat.py's automatic capture ran on a turn that carried
   * a POST /api/chat/upload attachment — a link onto that file, never a
   * raw upload from this panel's own manual-entry form. */
  attachment_url: string | null;
  /** Accumulated owner-triggered deep-scan results (POST
   * /agent/crm/entries/{id}/scan, or the owner-agent's scan_crm_attachment
   * tool) — timestamped, newest appended, never overwritten. Null until
   * the first scan. */
  analysis_notes: string | null;
  created_at: string;
  /** Owner-configurable structured collection (2026-08-19, see
   * lib/intent-schemas.ts) — null for entries captured the old
   * fixed-category way. Pair with `listIntentSchemas()` to resolve
   * `collected_fields`' keys into real labels. */
  intent_schema_id: number | null;
  collected_fields: Record<string, string>;
};

/** Admin/owner only — see backend/apis/agent.py. Stores the entry in this
 * project's own DB (no third-party CRM account exists to push into — see
 * models.CrmEntry's doc comment). */
export function pushCrmEntry(entry: {
  contact_email: string;
  summary: string;
  tags: string[];
  category?: string | null;
}) {
  return apiFetch<CrmEntry>("/api/agent/crm/entries", { method: "POST", body: entry });
}

export function listCrmEntries() {
  return apiFetch<CrmEntry[]>("/api/agent/crm/entries");
}

/** The one mutation a captured lead supports — moving it through
 * new -> contacted -> closed as admin/owner follow up. */
export function updateCrmEntryStatus(crmId: string, status: CrmStatus) {
  return apiFetch<CrmEntry>(`/api/agent/crm/entries/${crmId}/status`, {
    method: "PATCH",
    body: { status },
  });
}

/** No undo — removes the entry and (best-effort) its attached file. Added
 * 2026-08-08 alongside backend/chat_attachments.py's cleanup work: there
 * was no way to clear a spam/junk/test lead before this. */
export function deleteCrmEntry(crmId: string) {
  return apiFetch<void>(`/api/agent/crm/entries/${crmId}`, { method: "DELETE" });
}

export type CleanupUploadsResult = {
  scanned: number;
  orphaned: number;
  deleted: number;
  freed_bytes: number;
  deleted_files: string[];
};

/** Scans backend/chat_attachments.py's upload storage for files nothing
 * references anymore (no CrmEntry, no chat transcript) and removes them —
 * `dryRun: true` previews what would be deleted without touching disk. */
export function cleanupChatUploads(options: { olderThanHours?: number; dryRun?: boolean } = {}) {
  return apiFetch<CleanupUploadsResult>("/api/agent/storage/cleanup-uploads", {
    method: "POST",
    body: { older_than_hours: options.olderThanHours ?? 24, dry_run: options.dryRun ?? false },
  });
}
