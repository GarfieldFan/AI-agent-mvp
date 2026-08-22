"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ImageFieldEditor } from "@/components/theme/cte/image-field-editor";
import { ApiError } from "@/lib/api";
import {
  getBusinessProfile,
  suggestBusinessProfile,
  updateBusinessProfile,
  type BusinessProfile,
} from "@/lib/business-profile";

type Draft = Omit<BusinessProfile, "business_hours" | "business_social_links"> & {
  business_hours_text: string;
  business_social_links_text: string;
};

function toDraft(profile: BusinessProfile): Draft {
  const { business_hours, business_social_links, ...rest } = profile;
  return {
    ...rest,
    business_hours_text: business_hours.join("\n"),
    business_social_links_text: business_social_links.join("\n"),
  };
}

const EMPTY_DRAFT: Draft = {
  business_name: null,
  business_description: null,
  business_type: null,
  business_email: null,
  business_phone: null,
  business_street_address: null,
  business_locality: null,
  business_region: null,
  business_postal_code: null,
  business_country: null,
  business_url: null,
  business_logo_url: null,
  business_hours_text: "",
  business_social_links_text: "",
};

/** Owner-facing structured "who/where/how to reach us" facts (2026-08-21,
 * backend/apis/business_profile.py) — the input this app's GEO push needs:
 * a schema.org LocalBusiness JSON-LD block (BusinessProfileJsonLd,
 * mounted in the root layout) built from exactly what's saved here.
 * Deliberately a plain form the owner fills in and confirms themselves —
 * see backend/models.py's AppSettings docstring for why this is never
 * LLM-written directly. The "Suggest from documents" button pre-fills the
 * form from ingested RAG documents (mirrors IntentSchemaPanel's own
 * propose-then-owner-applies pattern) but never saves anything on its
 * own — the owner still has to review and click Save. */
export function BusinessProfilePanel() {
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  const [suggestStatus, setSuggestStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  const [suggestNote, setSuggestNote] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getBusinessProfile()
      .then((result) => {
        setDraft(toDraft(result));
        setLoadError(null);
        setLoaded(true);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load business profile."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateBusinessProfile({
        ...draft,
        business_hours: draft.business_hours_text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        business_social_links: draft.business_social_links_text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      setDraft(toDraft(result));
      setSaveStatus("idle");
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleSuggest() {
    setSuggestStatus("loading");
    setSuggestError(null);
    setSuggestNote(null);
    try {
      const result = await suggestBusinessProfile();
      if (result.document_count === 0) {
        setSuggestNote("No ingested documents to suggest from yet — upload some in Documents first.");
        setSuggestStatus("idle");
        return;
      }
      setDraft((d) => ({
        ...d,
        business_name: result.suggestion.business_name ?? d.business_name,
        business_description: result.suggestion.business_description ?? d.business_description,
        business_type: result.suggestion.business_type ?? d.business_type,
        business_email: result.suggestion.business_email ?? d.business_email,
        business_phone: result.suggestion.business_phone ?? d.business_phone,
        business_street_address: result.suggestion.business_street_address ?? d.business_street_address,
        business_locality: result.suggestion.business_locality ?? d.business_locality,
        business_region: result.suggestion.business_region ?? d.business_region,
        business_postal_code: result.suggestion.business_postal_code ?? d.business_postal_code,
        business_country: result.suggestion.business_country ?? d.business_country,
        business_hours_text:
          result.suggestion.business_hours.length > 0
            ? result.suggestion.business_hours.join("\n")
            : d.business_hours_text,
      }));
      setSuggestNote(
        `Filled in from ${result.document_count} document(s) — review everything below before saving; nothing was invented that isn't stated in your documents.`,
      );
      setSuggestStatus("idle");
    } catch (err) {
      setSuggestError(err instanceof ApiError ? err.message : "Suggest failed — is the backend reachable?");
      setSuggestStatus("error");
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading business profile…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Business profile</h3>
        <p className="text-xs text-muted-foreground">
          Published as machine-readable structured data (schema.org LocalBusiness JSON-LD) on every
          page — what lets AI systems and search engines answer questions about your business
          accurately, e.g. citing the right name and phone number instead of nothing at all. Only
          what you save here is ever published; nothing is guessed automatically.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleSuggest} disabled={suggestStatus === "loading"}>
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          {suggestStatus === "loading" ? "Reading documents…" : "Suggest from documents"}
        </Button>
        {suggestNote ? <span className="text-xs text-muted-foreground">{suggestNote}</span> : null}
      </div>
      {suggestStatus === "error" && suggestError ? (
        <ErrorMessage description={suggestError} onRetry={() => setSuggestStatus("idle")} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Business name</Label>
          <Input
            value={draft.business_name ?? ""}
            onChange={(e) => setField("business_name", e.target.value || null)}
            placeholder="Acme Plumbing"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Business type</Label>
          <Input
            value={draft.business_type ?? ""}
            onChange={(e) => setField("business_type", e.target.value || null)}
            placeholder="e.g. Plumber, Restaurant, Dentist — defaults to LocalBusiness"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Description</Label>
        <Textarea
          value={draft.business_description ?? ""}
          onChange={(e) => setField("business_description", e.target.value || null)}
          placeholder="One or two factual sentences describing what the business does."
          rows={2}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Email</Label>
          <Input
            value={draft.business_email ?? ""}
            onChange={(e) => setField("business_email", e.target.value || null)}
            placeholder="hello@example.com"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <Input
            value={draft.business_phone ?? ""}
            onChange={(e) => setField("business_phone", e.target.value || null)}
            placeholder="+1-555-010-2000"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Street address</Label>
        <Input
          value={draft.business_street_address ?? ""}
          onChange={(e) => setField("business_street_address", e.target.value || null)}
          placeholder="123 Main St"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">City</Label>
          <Input value={draft.business_locality ?? ""} onChange={(e) => setField("business_locality", e.target.value || null)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">State/region</Label>
          <Input value={draft.business_region ?? ""} onChange={(e) => setField("business_region", e.target.value || null)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Postal code</Label>
          <Input
            value={draft.business_postal_code ?? ""}
            onChange={(e) => setField("business_postal_code", e.target.value || null)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Country</Label>
          <Input value={draft.business_country ?? ""} onChange={(e) => setField("business_country", e.target.value || null)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Website URL</Label>
        <Input
          value={draft.business_url ?? ""}
          onChange={(e) => setField("business_url", e.target.value || null)}
          placeholder={draft.business_url || "defaults to this site's own address"}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Logo (optional)</Label>
        <ImageFieldEditor
          value={{ url: draft.business_logo_url || "#", alt: draft.business_name || "Business logo" }}
          onChange={(image) => setField("business_logo_url", image.url === "#" ? null : image.url)}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Hours (optional)</Label>
        <Textarea
          value={draft.business_hours_text}
          onChange={(e) => setField("business_hours_text", e.target.value)}
          placeholder={"One line per range, e.g.:\nMo-Fr 09:00-17:00\nSa 10:00-14:00"}
          rows={3}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Other profiles (optional)</Label>
        <Textarea
          value={draft.business_social_links_text}
          onChange={(e) => setField("business_social_links_text", e.target.value)}
          placeholder={"One URL per line — Google Business Profile, Yelp, Facebook, etc.\nhttps://www.facebook.com/yourbusiness"}
          rows={2}
        />
      </div>

      <div className="flex items-center gap-2 border-t pt-4">
        <Button onClick={handleSave} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save"}
        </Button>
        {savedAt && saveStatus === "idle" ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
      {saveStatus === "error" && saveError ? (
        <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
      ) : null}
    </div>
  );
}
