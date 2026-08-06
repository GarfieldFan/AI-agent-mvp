import { apiFetch } from "@/lib/api";

export type CrmEntry = {
  crm_id: string;
  contact_email: string;
  summary: string;
  tags: string[];
  created_at: string;
};

/** Admin/owner only — see backend/apis/agent.py. Stores the entry in this
 * project's own DB (no third-party CRM account exists to push into — see
 * models.CrmEntry's doc comment). */
export function pushCrmEntry(entry: { contact_email: string; summary: string; tags: string[] }) {
  return apiFetch<CrmEntry>("/api/agent/crm/entries", { method: "POST", body: entry });
}

export function listCrmEntries() {
  return apiFetch<CrmEntry[]>("/api/agent/crm/entries");
}
