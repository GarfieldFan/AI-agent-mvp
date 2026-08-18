"use client";

import * as React from "react";
import { Paperclip, Trash2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import {
  cleanupChatUploads,
  deleteCrmEntry,
  listCrmEntries,
  pushCrmEntry,
  updateCrmEntryStatus,
  type CleanupUploadsResult,
  type CrmEntry,
  type CrmStatus,
} from "@/lib/crm";

// Fixed display order + labels for the known categories apis/chat.py's
// automatic capture and this panel's manual form both use. Anything else
// (older rows from before `category` existed, or a freeform value) falls
// into the "Other" bucket below rather than being dropped.
const CATEGORY_GROUPS: { key: string; label: string }[] = [
  { key: "appointment", label: "Appointments" },
  { key: "quote", label: "Quotes" },
  { key: "claim", label: "Claims" },
  { key: "inquiry", label: "Inquiries" },
];

const CATEGORY_FORM_OPTIONS = [
  { value: "none", label: "No category" },
  ...CATEGORY_GROUPS.map((g) => ({ value: g.key, label: g.label.replace(/s$/, "") })),
];

const STATUS_OPTIONS: { value: CrmStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "closed", label: "Closed" },
];

function groupByCategory(entries: CrmEntry[]) {
  const groups = new Map<string, CrmEntry[]>();
  for (const entry of entries) {
    const key = entry.category && CATEGORY_GROUPS.some((g) => g.key === entry.category) ? entry.category : "other";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

/** Admin/owner only — backend/apis/agent.py's `/agent/crm/entries`,
 * real as of 2026-08-06 (see models.CrmEntry's doc comment for why this
 * stores leads in this project's own DB rather than pushing to a
 * third-party CRM nobody has an account for). Grouped by category
 * (appointment/quote/claim/inquiry) since apis/chat.py's automatic
 * chat-driven capture (2026-08-08) means most rows now arrive from the
 * public chatbot, not this panel's manual form — admin/owner need to
 * scan by kind of request and move each one through new -> contacted ->
 * closed, not just read a flat list. */
export function CrmPanel() {
  const [email, setEmail] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [tagsInput, setTagsInput] = React.useState("");
  const [category, setCategory] = React.useState("none");
  const [pushStatus, setPushStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [pushError, setPushError] = React.useState<string | null>(null);

  const [entries, setEntries] = React.useState<CrmEntry[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [statusErrorByEntry, setStatusErrorByEntry] = React.useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const [cleanupStatus, setCleanupStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [cleanupError, setCleanupError] = React.useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = React.useState<CleanupUploadsResult | null>(null);

  const refresh = React.useCallback(() => {
    listCrmEntries()
      .then((result) => {
        setEntries(result);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load CRM entries."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handlePush() {
    if (!email.trim() || !summary.trim()) return;
    setPushStatus("loading");
    setPushError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      await pushCrmEntry({
        contact_email: email.trim(),
        summary: summary.trim(),
        tags,
        category: category === "none" ? null : category,
      });
      setEmail("");
      setSummary("");
      setTagsInput("");
      setCategory("none");
      setPushStatus("idle");
      refresh();
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : "Push failed — is the backend reachable?");
      setPushStatus("error");
    }
  }

  async function handleDelete(entry: CrmEntry) {
    if (!window.confirm(`Delete the lead from ${entry.contact_email}? This also removes its attached file, if any. This cannot be undone.`)) {
      return;
    }
    setDeletingId(entry.crm_id);
    try {
      await deleteCrmEntry(entry.crm_id);
      setEntries((prev) => prev?.filter((e) => e.crm_id !== entry.crm_id) ?? prev);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Failed to delete entry.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleCleanup() {
    setCleanupStatus("loading");
    setCleanupError(null);
    try {
      const result = await cleanupChatUploads();
      setCleanupResult(result);
      setCleanupStatus("idle");
    } catch (err) {
      setCleanupError(err instanceof ApiError ? err.message : "Cleanup failed — is the backend reachable?");
      setCleanupStatus("error");
    }
  }

  async function handleStatusChange(entry: CrmEntry, status: CrmStatus) {
    const previous = entries;
    setEntries((prev) => prev?.map((e) => (e.crm_id === entry.crm_id ? { ...e, status } : e)) ?? prev);
    setStatusErrorByEntry((prev) => ({ ...prev, [entry.crm_id]: "" }));
    try {
      await updateCrmEntryStatus(entry.crm_id, status);
    } catch (err) {
      setEntries(previous); // roll back the optimistic update
      setStatusErrorByEntry((prev) => ({
        ...prev,
        [entry.crm_id]: err instanceof ApiError ? err.message : "Failed to update status.",
      }));
    }
  }

  const groups = entries ? groupByCategory(entries) : null;
  const orderedGroups = groups
    ? [...CATEGORY_GROUPS, { key: "other", label: "Other" }].filter((g) => (groups.get(g.key)?.length ?? 0) > 0)
    : [];

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">Leads</h3>
          <p className="text-xs text-muted-foreground">
            Captured automatically from the public chatbot (appointments, quotes, claims, general inquiries) or added
            here by hand — stored in this project&apos;s own database, no third-party CRM account configured.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleCleanup} disabled={cleanupStatus === "loading"}>
          {cleanupStatus === "loading" ? "Scanning…" : "Clean up unused uploads"}
        </Button>
      </div>
      {cleanupError ? <ErrorMessage description={cleanupError} onRetry={() => setCleanupStatus("idle")} /> : null}
      {cleanupResult ? (
        <p className="text-xs text-muted-foreground">
          Scanned {cleanupResult.scanned} file{cleanupResult.scanned === 1 ? "" : "s"} — removed{" "}
          {cleanupResult.deleted} orphaned upload{cleanupResult.deleted === 1 ? "" : "s"}
          {cleanupResult.deleted > 0 ? ` (${(cleanupResult.freed_bytes / 1024).toFixed(0)} KB freed)` : ""}.
          Only files older than 24h with no lead or chat transcript referencing them are ever touched.
        </p>
      ) : null}

      <div className="space-y-2">
        <Input placeholder="Contact email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <Textarea
          placeholder="Summary of the inquiry"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={2}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={category} onValueChange={(v) => v && setCategory(v)}>
            <SelectTrigger className="sm:w-48">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_FORM_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Tags, comma-separated (e.g. hot-lead, enterprise)"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            className="flex-1"
          />
        </div>
        <Button onClick={handlePush} disabled={!email.trim() || !summary.trim() || pushStatus === "loading"}>
          Push entry
        </Button>
        {pushStatus === "loading" ? <LoadingSpinner label="Saving…" /> : null}
        {pushStatus === "error" && pushError ? <ErrorMessage description={pushError} onRetry={() => setPushStatus("idle")} /> : null}
      </div>

      <div className="space-y-4 border-t pt-4">
        {listError ? <ErrorMessage description={listError} onRetry={refresh} /> : null}
        {entries === null && !listError ? <LoadingSpinner label="Loading leads…" /> : null}
        {entries && entries.length === 0 ? (
          <EmptyState icon={Users} title="No leads yet" description="Captured chatbot leads or manual entries will appear here." />
        ) : null}

        {orderedGroups.map((group) => (
          <div key={group.key} className="space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h4>
              <Badge variant="secondary" className="text-xs">
                {groups?.get(group.key)?.length ?? 0}
              </Badge>
            </div>
            <div className="space-y-2">
              {groups?.get(group.key)?.map((entry) => (
                <div key={entry.crm_id} className="space-y-1 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {entry.contact_name ? `${entry.contact_name} — ` : ""}
                      {entry.contact_email}
                      {entry.contact_phone ? (
                        <span className="ml-2 font-normal text-muted-foreground">{entry.contact_phone}</span>
                      ) : null}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</p>
                      <Select value={entry.status} onValueChange={(v) => v && handleStatusChange(entry, v as CrmStatus)}>
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete entry"
                        disabled={deletingId === entry.crm_id}
                        onClick={() => handleDelete(entry)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{entry.summary}</p>
                  {entry.attachment_url ? (
                    <a
                      href={entry.attachment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                    >
                      <Paperclip className="size-3" />
                      View attached file
                    </a>
                  ) : null}
                  {entry.analysis_notes ? (
                    <details className="rounded-md bg-muted/50 p-2 text-xs">
                      <summary className="cursor-pointer font-medium text-muted-foreground">
                        Deep-scan notes
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.analysis_notes}</p>
                    </details>
                  ) : null}
                  {entry.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {entry.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {statusErrorByEntry[entry.crm_id] ? (
                    <p className="text-xs text-destructive">{statusErrorByEntry[entry.crm_id]}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
