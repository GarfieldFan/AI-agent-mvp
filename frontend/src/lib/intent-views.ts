import { apiFetch } from "@/lib/api";
import type { IntentField } from "@/lib/intent-schemas";

/** Owner-agent-generated "review queues" over an IntentSchema's captured
 * entries (2026-08-19, see backend/models.py's IntentView docstring).
 * Created/adjusted by owner-agent's `manage_review_queue` tool from a
 * plain-language request, not a dashboard form — this module is
 * deliberately read/delete only, no create/update function, matching
 * that design (see the root AGENTS.md's "Review queues" section for why
 * there's no duplicate manual-creation UI here). */

export type IntentView = {
  id: number;
  intent_schema_id: number;
  schema_key: string;
  schema_label: string;
  name: string;
  description: string;
  status_options: string[];
  fields: IntentField[];
  created_at: string;
};

export function listIntentViews() {
  return apiFetch<IntentView[]>("/api/agent/intent-views");
}

/** No undo — matches deleteIntentSchema's posture. CrmEntry rows under
 * the queue's schema are untouched, they just have nothing rendering
 * them as a queue anymore until a new one is created. */
export function deleteIntentView(id: number) {
  return apiFetch<void>(`/api/agent/intent-views/${id}`, { method: "DELETE" });
}
