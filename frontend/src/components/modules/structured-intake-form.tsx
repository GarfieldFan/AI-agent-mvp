"use client";

import * as React from "react";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { sendChatMessage } from "@/lib/chat";
import { getPublicIntentForm, type PublicIntentForm } from "@/lib/intent-schemas";
import { getTurnstileConfig } from "@/lib/turnstile";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type StructuredIntakeFormProps = {
  /** IntentSchema.key whose form_template to render. */
  schemaKey: string;
  /** Tighter spacing/typography for the chatbot-embedded rendering
   * (2026-09-22, chat-control-renderer.tsx) — the standalone/CTE-Block
   * rendering uses the roomier default. */
  compact?: boolean;
  /** Called once the submission actually succeeds, with the assistant's
   * confirmation reply text — chat-control-renderer.tsx uses this to
   * push the reply into the visible transcript as a normal message. */
  onSubmitted?: (replyText: string) => void;
};

/** A whole-form, multi-step wizard for an owner-configured IntentSchema
 * (2026-09-22) — the alternative to answering the chatbot's questions
 * turn by turn: every field is shown upfront, grouped into sections by
 * the schema's own form_template (see backend/models.py's IntentSchema
 * docstring), so a long field list (think a tax return, a visa
 * application, an event-registration flow) doesn't overwhelm one page.
 * Client-validates required fields per step, then sends the whole
 * collected set as one `structured_submission` on `POST /api/chat` —
 * the backend writes it to a CrmEntry deterministically, no LLM
 * re-extraction of data that's already known and structured (see
 * backend/apis/chat.py's StructuredSubmissionRequest). Usable both as a
 * standalone page/CTE Block and embedded inline in the chat bubble. */
export function StructuredIntakeForm({ schemaKey, compact, onSubmitted }: StructuredIntakeFormProps) {
  const [form, setForm] = React.useState<PublicIntentForm | null | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [stepIndex, setStepIndex] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [touchedStep, setTouchedStep] = React.useState(false);
  const [submitStatus, setSubmitStatus] = React.useState<"idle" | "submitting" | "error">("idle");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submittedReply, setSubmittedReply] = React.useState<string | null>(null);

  const [turnstileSiteKey, setTurnstileSiteKey] = React.useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = React.useState("");

  const load = React.useCallback(() => {
    getPublicIntentForm(schemaKey)
      .then((result) => {
        setForm(result);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load this form."));
  }, [schemaKey]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    getTurnstileConfig()
      .then((config) => setTurnstileSiteKey(config.enabled ? config.site_key : null))
      .catch(() => setTurnstileSiteKey(null));
  }, []);

  const fieldsByKey = React.useMemo(() => {
    const map = new Map<string, PublicIntentForm["fields"][number]>();
    (form?.fields ?? []).forEach((f) => map.set(f.field_key, f));
    return map;
  }, [form]);

  const sections = form?.form_template?.sections ?? [];
  const currentSection = sections[stepIndex];
  const isLastStep = stepIndex === sections.length - 1;
  const needsTurnstile = !!turnstileSiteKey;

  function setValue(fieldKey: string, value: string) {
    setValues((v) => ({ ...v, [fieldKey]: value }));
  }

  function missingRequiredInSection(index: number): string[] {
    const section = sections[index];
    if (!section) return [];
    return section.items
      .filter((item) => item.kind === "field" && item.field_key)
      .map((item) => fieldsByKey.get(item.field_key!))
      .filter((field): field is PublicIntentForm["fields"][number] => !!field && field.required)
      .filter((field) => !values[field.field_key]?.trim())
      .map((field) => field.label);
  }

  function invalidFormatInSection(index: number): string[] {
    const section = sections[index];
    if (!section) return [];
    const problems: string[] = [];
    for (const item of section.items) {
      if (item.kind !== "field" || !item.field_key) continue;
      const field = fieldsByKey.get(item.field_key);
      const value = values[item.field_key]?.trim();
      if (!field || !value) continue;
      if (field.field_type === "email" && !EMAIL_RE.test(value)) problems.push(`${field.label} isn't a valid email.`);
    }
    return problems;
  }

  function handleNext() {
    setTouchedStep(true);
    const missing = missingRequiredInSection(stepIndex);
    const invalid = invalidFormatInSection(stepIndex);
    if (missing.length > 0 || invalid.length > 0) return;
    setTouchedStep(false);
    setStepIndex((i) => Math.min(i + 1, sections.length - 1));
  }

  function handleBack() {
    setTouchedStep(false);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  async function handleSubmit() {
    setTouchedStep(true);
    // Re-validate EVERY step, not just the current one — a visitor could
    // in principle reach here without ever having clicked Next past an
    // earlier, now-invalid step (e.g. cleared a value after moving on).
    const allMissing = sections.flatMap((_, i) => missingRequiredInSection(i));
    const allInvalid = sections.flatMap((_, i) => invalidFormatInSection(i));
    if (allMissing.length > 0 || allInvalid.length > 0) {
      const firstBadStep = sections.findIndex(
        (_, i) => missingRequiredInSection(i).length > 0 || invalidFormatInSection(i).length > 0,
      );
      if (firstBadStep >= 0) setStepIndex(firstBadStep);
      return;
    }
    if (needsTurnstile && !turnstileToken) return;

    setSubmitStatus("submitting");
    setSubmitError(null);
    try {
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value.trim()) fields[key] = value.trim();
      }
      const response = await sendChatMessage(
        `I've completed the ${form?.label ?? "intake"} form.`,
        [],
        undefined,
        turnstileToken || undefined,
        { schema_key: schemaKey, fields },
      );
      setSubmittedReply(response.reply);
      setSubmitStatus("idle");
      onSubmitted?.(response.reply);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Couldn't submit this form — please try again.");
      setSubmitStatus("error");
    }
  }

  if (form === undefined) {
    return (
      <div className={cn("rounded-xl border p-4", compact && "border-0 p-2")}>
        <LoadingSpinner label="Loading form…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={cn("rounded-xl border p-4", compact && "border-0 p-2")}>
        <ErrorMessage description={loadError} onRetry={load} />
      </div>
    );
  }

  if (!form || !form.form_template || sections.length === 0) {
    return (
      <div className={cn("rounded-xl border p-4", compact && "border-0 p-2")}>
        <EmptyState title="Form not available" description="This request type doesn't have an upfront form set up yet." />
      </div>
    );
  }

  if (submittedReply !== null) {
    return (
      <div className={cn("space-y-2 rounded-xl border p-4", compact && "border-0 p-2")}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="size-4 text-emerald-600" />
          Submitted
        </div>
        <p className="text-sm text-muted-foreground">{submittedReply}</p>
      </div>
    );
  }

  const missingNow = touchedStep ? missingRequiredInSection(stepIndex) : [];
  const invalidNow = touchedStep ? invalidFormatInSection(stepIndex) : [];

  return (
    <div className={cn("space-y-4 rounded-xl border p-4", compact && "space-y-3 border-0 p-2")}>
      <div className="space-y-1">
        <h3 className={cn("font-semibold", compact ? "text-base" : "text-lg")}>{form.form_template.title}</h3>
        {form.form_template.subtitle ? (
          <p className="text-sm text-muted-foreground">{form.form_template.subtitle}</p>
        ) : null}
        {form.form_template.description ? (
          <p className="text-xs text-muted-foreground">{form.form_template.description}</p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        Step {stepIndex + 1} of {sections.length}
        {currentSection ? ` — ${currentSection.title}` : ""}
      </p>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className="h-1.5 rounded-full bg-primary transition-all"
          style={{ width: `${((stepIndex + 1) / sections.length) * 100}%` }}
        />
      </div>

      {currentSection ? (
        <div className="space-y-3">
          {currentSection.subtitle ? <p className="text-sm font-medium">{currentSection.subtitle}</p> : null}
          {currentSection.description ? (
            <p className="text-xs text-muted-foreground">{currentSection.description}</p>
          ) : null}
          {currentSection.items.map((item, i) => {
            if (item.kind === "label") {
              return (
                <p key={i} className="text-xs italic text-muted-foreground">
                  {item.text}
                </p>
              );
            }
            const field = item.field_key ? fieldsByKey.get(item.field_key) : undefined;
            if (!field) return null;
            const value = values[field.field_key] ?? "";
            return (
              <div key={field.field_key} className="space-y-1">
                <Label className="text-sm">
                  {field.label}
                  {field.required ? <span className="text-destructive"> *</span> : null}
                </Label>
                {field.field_type === "note" ? (
                  <Textarea rows={3} value={value} onChange={(e) => setValue(field.field_key, e.target.value)} />
                ) : field.field_type === "select" ? (
                  <Select value={value || undefined} onValueChange={(v) => v && setValue(field.field_key, v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose one" />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={
                      field.field_type === "email"
                        ? "email"
                        : field.field_type === "number"
                          ? "number"
                          : field.field_type === "date"
                            ? "date"
                            : "text"
                    }
                    value={value}
                    onChange={(e) => setValue(field.field_key, e.target.value)}
                  />
                )}
                {field.prompt_hint ? <p className="text-xs text-muted-foreground">{field.prompt_hint}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {missingNow.length > 0 ? (
        <p className="text-xs text-destructive">Please fill in: {missingNow.join(", ")}.</p>
      ) : null}
      {invalidNow.length > 0 ? (
        <p className="text-xs text-destructive">{invalidNow.join(" ")}</p>
      ) : null}

      {isLastStep && needsTurnstile ? <TurnstileWidget siteKey={turnstileSiteKey!} onToken={setTurnstileToken} /> : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={handleBack} disabled={stepIndex === 0}>
          <ChevronLeft className="size-3.5" />
          Back
        </Button>
        {isLastStep ? (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitStatus === "submitting" || (needsTurnstile && !turnstileToken)}
          >
            {submitStatus === "submitting" ? "Submitting…" : "Submit"}
          </Button>
        ) : (
          <Button size="sm" onClick={handleNext}>
            Next
            <ChevronRight className="size-3.5" />
          </Button>
        )}
      </div>
      {submitStatus === "error" && submitError ? (
        <ErrorMessage description={submitError} onRetry={() => setSubmitStatus("idle")} />
      ) : null}
    </div>
  );
}
