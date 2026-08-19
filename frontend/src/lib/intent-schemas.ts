import { apiFetch } from "@/lib/api";

/** Owner-configurable structured data collection (2026-08-19) — see
 * backend/models.py's IntentSchema/IntentField docstrings. Generalizes
 * apis/chat.py's old fixed category enum (appointment/quote/claim/
 * inquiry) into something any vertical (insurance, real estate, a
 * clinic, a restaurant, ...) can define for itself: an owner describes
 * a "kind of request" (a schema) and the fields it needs collected, and
 * the public chatbot collects them conversationally across turns without
 * re-asking for anything it already has. */

export type IntentFieldType = "text" | "email" | "phone" | "date" | "number" | "note";

export type IntentField = {
  id: number;
  field_key: string;
  label: string;
  field_type: IntentFieldType;
  required: boolean;
  prompt_hint: string | null;
};

export type IntentSchema = {
  id: number;
  key: string;
  label: string;
  description: string;
  fields: IntentField[];
  created_at: string;
};

export type IntentFieldInput = Omit<IntentField, "id">;

export type IntentSchemaInput = {
  key: string;
  label: string;
  description: string;
  fields: IntentFieldInput[];
};

/** Shared between IntentSchemaPanel's own editor and OwnerAgentPanel's
 * schema-proposal review form (2026-08-19) — one list, not two copies
 * that could drift. */
export const FIELD_TYPE_OPTIONS: { value: IntentFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "note", label: "Note (long text)" },
];

export function listIntentSchemas() {
  return apiFetch<IntentSchema[]>("/api/agent/intent-schemas");
}

export function createIntentSchema(input: IntentSchemaInput) {
  return apiFetch<IntentSchema>("/api/agent/intent-schemas", { method: "POST", body: input });
}

export function updateIntentSchema(id: number, input: IntentSchemaInput) {
  return apiFetch<IntentSchema>(`/api/agent/intent-schemas/${id}`, { method: "PUT", body: input });
}

/** No undo — CrmEntry rows that reference this schema keep their
 * collected_fields (a historical record), they just lose the link back
 * to a schema that no longer exists. */
export function deleteIntentSchema(id: number) {
  return apiFetch<void>(`/api/agent/intent-schemas/${id}`, { method: "DELETE" });
}
