"use client";

import * as React from "react";
import { FileText, ListChecks, Plus, Sparkles, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { slugifyKey } from "@/lib/slug";
import {
  createIntentSchema,
  deleteIntentSchema,
  FIELD_TYPE_OPTIONS,
  listIntentSchemas,
  proposeFormTemplate,
  updateIntentSchema,
  type FormTemplate,
  type IntentField,
  type IntentFieldInput,
  type IntentFieldType,
  type IntentSchema,
  type IntentSchemaInput,
} from "@/lib/intent-schemas";

function blankField(): IntentFieldInput {
  return { field_key: "", label: "", field_type: "text", required: true, prompt_hint: "", options: null };
}

/** "Label | value" per line, "Label" alone means value === label —
 * the simplest text-editable shape for a select field's own choices,
 * avoiding a repeatable label+value row editor for what's realistically
 * a handful of options. */
function optionsToText(options: IntentField["options"]): string {
  return (options ?? []).map((o) => (o.label === o.value ? o.label : `${o.label} | ${o.value}`)).join("\n");
}

function parseOptionsText(text: string): IntentField["options"] {
  const options = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, value] = line.split("|").map((p) => p.trim());
      return { label, value: value || label };
    });
  return options.length > 0 ? options : null;
}

function draftFromSchema(schema: IntentSchema): IntentSchemaInput {
  return {
    key: schema.key,
    label: schema.label,
    description: schema.description,
    fields: schema.fields.map((f) => ({
      field_key: f.field_key,
      label: f.label,
      field_type: f.field_type,
      required: f.required,
      prompt_hint: f.prompt_hint ?? "",
      options: f.options,
    })),
    form_template: schema.form_template,
  };
}

const BLANK_DRAFT: IntentSchemaInput = {
  key: "",
  label: "",
  description: "",
  fields: [blankField()],
  form_template: null,
};

/** Owner-configurable structured data collection (2026-08-19) — see
 * backend/models.py's IntentSchema/IntentField docstrings and
 * apis/chat.py's `_lead_extraction_system_prompt`. The owner defines a
 * "kind of request" (e.g. "Insurance claim") and the fields it needs
 * collected (e.g. policy number, incident date); the public chatbot
 * picks up on those definitions live and collects them conversationally
 * across turns, without re-asking for anything already given — see
 * `CrmPanel`'s per-entry `collected_fields` rendering for the result.
 * This is the general mechanism the "insurance" example was built and
 * verified against — nothing here is insurance-specific, so a different
 * vertical (real estate, a clinic, a restaurant, ...) is just filling in
 * this same form again, not new code. */
export function IntentSchemaPanel() {
  const [schemas, setSchemas] = React.useState<IntentSchema[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const [editingId, setEditingId] = React.useState<number | "new" | null>(null);
  const [draft, setDraft] = React.useState<IntentSchemaInput>(BLANK_DRAFT);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // field_key, like the schema's own top-level key, is auto-derived from
  // the field's label rather than typed — but only for a field that's NEW
  // in this editing session; a field that already existed when editing
  // started keeps its key locked (CrmEntry.collected_fields rows already
  // reference it by that exact key, so silently changing it would orphan
  // already-collected data). Captured once per edit session, not derived
  // from `draft` on every render, since draft.fields itself gets mutated
  // as the owner types.
  const existingFieldKeysRef = React.useRef<Set<string>>(new Set());

  const refresh = React.useCallback(() => {
    listIntentSchemas()
      .then((result) => {
        setSchemas(result);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load intent schemas."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function startCreate() {
    setDraft(BLANK_DRAFT);
    existingFieldKeysRef.current = new Set();
    setEditingId("new");
    setSaveStatus("idle");
    setSaveError(null);
  }

  function startEdit(schema: IntentSchema) {
    setDraft(draftFromSchema(schema));
    existingFieldKeysRef.current = new Set(schema.fields.map((f) => f.field_key));
    setEditingId(schema.id);
    setSaveStatus("idle");
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function updateFieldAt(index: number, patch: Partial<IntentFieldInput>) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  }

  function removeFieldAt(index: number) {
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }));
  }

  function addField() {
    setDraft((d) => ({ ...d, fields: [...d.fields, blankField()] }));
  }

  async function handleSave() {
    if (!draft.key.trim() || !draft.label.trim() || editingId === null) return;
    setSaveStatus("saving");
    setSaveError(null);
    const payload: IntentSchemaInput = {
      key: draft.key.trim(),
      label: draft.label.trim(),
      description: draft.description.trim(),
      fields: draft.fields
        .filter((f) => f.field_key.trim() && f.label.trim())
        .map((f) => ({ ...f, field_key: f.field_key.trim(), label: f.label.trim(), prompt_hint: f.prompt_hint?.trim() || null })),
      // Full-replace, same as fields — echoed back unchanged unless the
      // Upfront form editor below actually touched it, so an ordinary
      // field/label edit can never silently wipe an already-saved
      // form_template.
      form_template: draft.form_template ?? null,
    };
    try {
      if (editingId === "new") {
        await createIntentSchema(payload);
      } else {
        await updateIntentSchema(editingId, payload);
      }
      setEditingId(null);
      refresh();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleDelete(schema: IntentSchema) {
    if (!window.confirm(`Delete the "${schema.label}" schema? Already-captured leads keep their data.`)) return;
    setDeletingId(schema.id);
    try {
      await deleteIntentSchema(schema.id);
      refresh();
    } catch {
      // Best-effort — a failed delete just leaves the schema in the list, no separate error UI needed here.
    } finally {
      setDeletingId(null);
    }
  }

  if (listError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={listError} onRetry={refresh} />
      </div>
    );
  }

  if (!schemas) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading intent schemas…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <ListChecks className="h-5 w-5" />
          Intent schemas
        </h3>
        <p className="text-xs text-muted-foreground">
          Define what information the chatbot should collect for a kind of request (e.g. an insurance
          claim needs a policy number and incident date). It collects these conversationally across
          turns, in this same chat session, without re-asking for anything already given.
        </p>
      </div>

      {schemas.length === 0 && editingId === null ? (
        <EmptyState
          icon={ListChecks}
          title="No intent schemas yet"
          description="Without one, the chatbot falls back to its original appointment/quote/claim/inquiry categories."
        />
      ) : null}

      <div className="space-y-2">
        {schemas.map((schema) =>
          editingId === schema.id ? null : (
            <div key={schema.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{schema.label}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>{schema.key}</code> — {schema.description}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => startEdit(schema)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Delete schema"
                    disabled={deletingId === schema.id}
                    onClick={() => handleDelete(schema)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              {schema.fields.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {schema.fields.map((f: IntentField) => (
                    <Badge key={f.id} variant={f.required ? "secondary" : "outline"} className="text-xs">
                      {f.label}
                      {f.required ? "" : " (optional)"}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>

      {editingId !== null ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Key (stable id — auto-generated from the label{editingId !== "new" ? ", locked once created" : ""})
              </Label>
              <Input value={draft.key} disabled className="font-mono text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Label (shown to the owner)</Label>
              <Input
                value={draft.label}
                onChange={(e) => {
                  const label = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    label,
                    // Only auto-derive on create — once a schema exists,
                    // its key is a stable id other things reference (e.g.
                    // owner-agent's manage_review_queue looks it up by
                    // key), so editing the label afterward must never
                    // silently change it.
                    key: editingId === "new" ? slugifyKey(label) : d.key,
                  }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                This is what the AI reads to decide whether a visitor&apos;s request is something this
                business handles — be specific (e.g. &quot;Home insurance application&quot;, not just
                &quot;Application&quot;).
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Description (tells the model when this schema applies)
            </Label>
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Fields to collect</Label>
            {draft.fields.map((field, i) => (
              <div key={i} className="space-y-1.5">
                <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-2">
                  <Input
                    placeholder="field_key (auto)"
                    value={field.field_key}
                    disabled
                    className="font-mono text-muted-foreground"
                  />
                  <Input
                    placeholder="Label"
                    value={field.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      // Only auto-derive for a field that's new in this
                      // editing session — a field that already existed has
                      // its key locked, same reasoning as the schema-level
                      // key above (something else may already reference it
                      // by that exact key).
                      const isExisting = existingFieldKeysRef.current.has(field.field_key);
                      updateFieldAt(i, { label, field_key: isExisting ? field.field_key : slugifyKey(label) });
                    }}
                  />
                  <Select
                    value={field.field_type}
                    onValueChange={(v) => v && updateFieldAt(i, { field_type: v as IntentFieldType })}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={field.required}
                      onCheckedChange={(checked) => updateFieldAt(i, { required: checked })}
                    />
                    <Label className="text-xs text-muted-foreground">Required</Label>
                  </div>
                  <Button variant="ghost" size="icon-xs" aria-label="Remove field" onClick={() => removeFieldAt(i)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {field.field_type === "select" ? (
                  <div className="space-y-1 pl-1">
                    <Label className="text-xs text-muted-foreground">
                      Options — one per line, &quot;Label | value&quot; (or just &quot;Label&quot; if the stored
                      value should match what&apos;s shown)
                    </Label>
                    <Textarea
                      rows={3}
                      placeholder={"Australia | AU\nNew Zealand | NZ"}
                      value={optionsToText(field.options)}
                      onChange={(e) => updateFieldAt(i, { options: parseOptionsText(e.target.value) })}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addField}>
              <Plus className="size-4" />
              Add field
            </Button>
          </div>

          <FormTemplateEditor
            schemaId={editingId === "new" ? null : editingId}
            template={draft.form_template ?? null}
            onChange={(template) => setDraft((d) => ({ ...d, form_template: template }))}
          />

          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!draft.key.trim() || !draft.label.trim() || saveStatus === "saving"}>
              {saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
          {saveStatus === "error" && saveError ? (
            <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
          ) : null}
        </div>
      ) : (
        <Button variant="outline" onClick={startCreate}>
          <Plus className="size-4" />
          New intent schema
        </Button>
      )}
    </div>
  );
}

type FormTemplateEditorProps = {
  /** null for a schema that hasn't been saved yet — proposeFormTemplate
   * needs a real schema id (and its already-saved fields) to run against. */
  schemaId: number | null;
  template: FormTemplate | null;
  onChange: (template: FormTemplate | null) => void;
};

/** "Upfront form" section of the schema editor (2026-09-22) — lets the
 * owner turn on StructuredIntakeForm for this schema: an AI-drafted,
 * section-grouped layout the owner accepts, regenerates, or removes.
 * Deliberately no manual section/field-reassignment editor in this round
 * (regenerate-or-remove only) — the same "AI drafts, owner applies, no
 * separate manual editor" posture this app already holds for
 * order_status_options/shipping_allowed_regions, not a gap. Manually
 * fine-tuning a proposed layout is still possible via the backend's own
 * PUT .../form-template endpoint if a real need for it shows up later. */
function FormTemplateEditor({ schemaId, template, onChange }: FormTemplateEditorProps) {
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  async function suggest() {
    if (schemaId === null) return;
    setStatus("loading");
    setError(null);
    try {
      const result = await proposeFormTemplate(schemaId);
      onChange(result.proposed_template);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't draft a form layout — is a chat model configured?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-medium">Upfront form (optional)</p>
      </div>
      <p className="text-xs text-muted-foreground">
        A whole-form wizard a visitor fills out in one go (sections of fields, e.g. Personal details,
        Address), instead of answering the chatbot&apos;s questions turn by turn. Drafted by AI from this
        schema&apos;s own already-saved fields — save field changes above first if you&apos;ve just edited
        them.
      </p>

      {schemaId === null ? (
        <p className="text-xs text-muted-foreground italic">Save this schema first, then come back to add one.</p>
      ) : template ? (
        <div className="space-y-2">
          <div className="space-y-1 rounded-md bg-muted/40 p-2">
            <p className="text-sm font-medium">{template.title}</p>
            {template.subtitle ? <p className="text-xs text-muted-foreground">{template.subtitle}</p> : null}
            {template.sections.map((section, i) => (
              <div key={i} className="pt-1">
                <p className="text-xs font-medium">{section.title}</p>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {section.items.map((item, j) =>
                    item.kind === "field" ? (
                      <Badge key={j} variant="outline" className="text-xs">
                        {item.field_key}
                      </Badge>
                    ) : (
                      <Badge key={j} variant="secondary" className="text-xs italic">
                        {item.text}
                      </Badge>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={suggest} disabled={status === "loading"}>
              <Sparkles className="size-3.5" />
              {status === "loading" ? "Regenerating…" : "Regenerate"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              Remove form
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={suggest} disabled={status === "loading"}>
          <Sparkles className="size-3.5" />
          {status === "loading" ? "Drafting…" : "Suggest form layout"}
        </Button>
      )}
      {status === "error" && error ? <ErrorMessage description={error} onRetry={() => setStatus("idle")} /> : null}
    </div>
  );
}
