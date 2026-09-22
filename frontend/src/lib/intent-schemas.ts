import { ApiError, apiFetch } from "@/lib/api";

/** Owner-configurable structured data collection (2026-08-19) — see
 * backend/models.py's IntentSchema/IntentField docstrings. Generalizes
 * apis/chat.py's old fixed category enum (appointment/quote/claim/
 * inquiry) into something any vertical (insurance, real estate, a
 * clinic, a restaurant, ...) can define for itself: an owner describes
 * a "kind of request" (a schema) and the fields it needs collected, and
 * the public chatbot collects them conversationally across turns without
 * re-asking for anything it already has. */

export type IntentFieldType = "text" | "email" | "phone" | "date" | "number" | "note" | "select";

/** A select field's own choice — {label, value} mirrors lib/types.ts's
 * ChatOption shape (2026-09-22), the other structured-choice contract
 * this app already has. */
export type IntentFieldOption = {
  label: string;
  value: string;
};

export type IntentField = {
  id: number;
  field_key: string;
  label: string;
  field_type: IntentFieldType;
  required: boolean;
  prompt_hint: string | null;
  /** Only meaningful when field_type === "select". */
  options: IntentFieldOption[] | null;
};

/** StructuredIntakeForm's own template shape (2026-09-22) — a section-
 * grouped upfront-form layout over this schema's own already-defined
 * fields, generated once (via proposeFormTemplate below) and stored,
 * not regenerated per visitor. Items reference fields by field_key only
 * (type/required/options stay on IntentField, the single source of
 * truth) — a "label" item is inline static instructional text, not a
 * real collected field. See the backend's models.py IntentSchema
 * docstring for the full design. */
export type FormTemplateItem = {
  kind: "field" | "label";
  field_key?: string | null;
  text?: string | null;
};

export type FormTemplateSection = {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  items: FormTemplateItem[];
};

export type FormTemplate = {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  sections: FormTemplateSection[];
};

export type IntentSchema = {
  id: number;
  key: string;
  label: string;
  description: string;
  fields: IntentField[];
  form_template: FormTemplate | null;
  created_at: string;
};

export type IntentFieldInput = Omit<IntentField, "id">;

export type IntentSchemaInput = {
  key: string;
  label: string;
  description: string;
  fields: IntentFieldInput[];
  /** Full-replace, same as `fields` — an update call must echo back the
   * schema's currently-known form_template (or explicit null) to avoid
   * silently clearing it; see intent-schema-panel.tsx's edit flow. */
  form_template?: FormTemplate | null;
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
  { value: "select", label: "Select (dropdown)" },
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

/** Drafts a section-grouped form_template from this schema's own
 * already-defined fields (2026-09-22) — never saves anything itself,
 * mirrors propose_intent_schema's propose-then-owner-applies posture.
 * Apply the result via setFormTemplate below once the owner reviews it. */
export function proposeFormTemplate(schemaId: number) {
  return apiFetch<{ proposed_template: FormTemplate }>(
    `/api/agent/intent-schemas/${schemaId}/propose-form-template`,
    { method: "POST" },
  );
}

/** Saves ONLY the form_template, without resending the whole field list
 * — what "Apply"/"Save form layout" calls once the owner has reviewed
 * an AI-drafted (or hand-edited) template. `null` clears it, reverting
 * this schema to conversational-only collection. */
export function setFormTemplate(schemaId: number, template: FormTemplate | null) {
  return apiFetch<IntentSchema>(`/api/agent/intent-schemas/${schemaId}/form-template`, {
    method: "PUT",
    body: template,
  });
}

/** Public, no-auth (2026-09-22) — what StructuredIntakeForm fetches to
 * render either a standalone page/CTE-Block form or a chat-embedded one.
 * `form_template: null` means this schema has no upfront-form layout
 * configured yet. `null` overall (a 404) means the schema_key itself
 * doesn't exist. */
export type PublicIntentForm = {
  key: string;
  label: string;
  description: string;
  fields: Omit<IntentField, "id">[];
  form_template: FormTemplate | null;
};

export async function getPublicIntentForm(key: string): Promise<PublicIntentForm | null> {
  try {
    return await apiFetch<PublicIntentForm>(`/api/intent-schemas/${encodeURIComponent(key)}/form`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
