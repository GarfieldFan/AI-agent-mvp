import { apiFetch } from "@/lib/api";

/** Owner-facing marketing/CRM platform settings (2026-09-21, backend/apis/
 * marketing.py) — same write-only-secret shape as lib/notifications.ts's
 * NotificationSettings: `mailchimp_api_key`/`hubspot_access_token` are
 * never echoed back, only `*_set` booleans say whether one is saved.
 * Unlike notifications.ts's ephemeral test-send, there's no side-effect-
 * free "test" mode here — a real sync IS the verification step, since
 * both platforms' whole job is upserting a real contact record. See
 * `syncCrmEntryToMarketing` below and the root AGENTS.md's marketing-sync
 * section for the full design (a deterministic code-level sync, never an
 * LLM-constructed request — owner-agent's own `sync_crm_entry_to_marketing`
 * tool calls this exact same endpoint). */
export type MarketingSettings = {
  marketing_provider: "test" | "mailchimp" | "hubspot";
  mailchimp_audience_id: string | null;
  mailchimp_api_key_set: boolean;
  hubspot_access_token_set: boolean;
};

export type MarketingSettingsInput = {
  marketing_provider: "test" | "mailchimp" | "hubspot";
  mailchimp_audience_id?: string | null;
  /** Omit to leave the previously-saved key alone. */
  mailchimp_api_key?: string;
  hubspot_access_token?: string;
};

export function getMarketingSettings() {
  return apiFetch<MarketingSettings>("/api/agent/marketing-settings");
}

export function updateMarketingSettings(input: MarketingSettingsInput) {
  return apiFetch<MarketingSettings>("/api/agent/marketing-settings", { method: "PUT", body: input });
}

export type SyncCrmEntryResult = {
  /** Which provider actually handled the sync — "test" means nothing
   * was really pushed anywhere, so a caller can tell a real sync apart
   * from a no-op even though both return 200. */
  provider: string;
  result: Record<string, unknown>;
};

/** Pushes one captured lead's contact info to the owner's configured
 * marketing platform — see `CrmPanel`'s "Sync to marketing platform"
 * button. `crmId` is a string, matching `lib/crm.ts`'s own convention
 * for every other per-entry call in that file. */
export function syncCrmEntryToMarketing(crmId: string) {
  return apiFetch<SyncCrmEntryResult>(`/api/agent/crm/entries/${crmId}/sync-to-marketing`, { method: "POST" });
}
