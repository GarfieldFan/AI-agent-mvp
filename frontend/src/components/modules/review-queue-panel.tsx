"use client";

import * as React from "react";
import { Headset, Inbox, Paperclip } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ApiError } from "@/lib/api";
import { listCrmEntries, updateCrmEntryStatus, type CrmEntry } from "@/lib/crm";
import { listIntentViews, type IntentView } from "@/lib/intent-views";

const QUEUE_PAGE_SIZE = 10;

/** Renders owner-agent-generated "review queues" (2026-08-19, see
 * backend/models.py's IntentView docstring and lib/intent-views.ts) —
 * created/adjusted by telling owner-agent what to track in plain
 * language (its `manage_review_queue` tool), not a dashboard form. This
 * panel is purely the read/act side: for each queue, the matching
 * IntentSchema's captured CrmEntry rows, with a status `Select` (options
 * = that queue's own `status_options`) an owner/admin can click through
 * — approve/reject/whatever the agent (or a follow-up command) decided
 * made sense for this kind of request. Deliberately separate from
 * `CrmPanel` (its own top-level accordion group, "Review queues") — the
 * user explicitly asked for this to live somewhere distinct.
 *
 * **Each queue paginates independently** (2026-08-20, `ReviewQueueCard`
 * below) — was a single `listCrmEntries()` fetching every entry across
 * every schema and filtering client-side per queue; now each queue
 * fetches its own page of just its own schema's entries
 * (`intent_schema_id` filter, see the root AGENTS.md), so one queue's
 * page state never affects another's. */
export function ReviewQueuePanel() {
  const [views, setViews] = React.useState<IntentView[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    listIntentViews()
      .then((result) => {
        setViews(result);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load review queues."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!views) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading review queues…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Inbox className="h-5 w-5" />
          Review queues
        </h3>
        <p className="text-xs text-muted-foreground">
          Tell the owner agent what you want to track (&quot;I want to review insurance applications,
          approve or reject them&quot;) — it generates the queue below from your intent schemas. Send it
          another command any time to adjust the statuses.
        </p>
      </div>

      {views.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No review queues yet"
          description="Ask the owner agent to create one for an existing intent schema."
        />
      ) : null}

      {views.map((view) => (
        <ReviewQueueCard key={view.id} view={view} />
      ))}
    </div>
  );
}

/** One queue's own entries + pagination + status controls — split out
 * (2026-08-20) so each queue owns its own page state independently. */
function ReviewQueueCard({ view }: { view: IntentView }) {
  const [entries, setEntries] = React.useState<CrmEntry[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [statusErrorByEntry, setStatusErrorByEntry] = React.useState<Record<string, string>>({});

  const refresh = React.useCallback(() => {
    listCrmEntries({
      intentSchemaId: view.intent_schema_id,
      limit: QUEUE_PAGE_SIZE,
      offset: (page - 1) * QUEUE_PAGE_SIZE,
    })
      .then((result) => {
        setEntries(result.items);
        setTotal(result.total);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load entries."));
  }, [view.intent_schema_id, page]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleStatusChange(entry: CrmEntry, status: string) {
    const previous = entry.status;
    setEntries((prev) => (prev ? prev.map((e) => (e.crm_id === entry.crm_id ? { ...e, status } : e)) : prev));
    try {
      await updateCrmEntryStatus(entry.crm_id, status);
      setStatusErrorByEntry((prev) => {
        const next = { ...prev };
        delete next[entry.crm_id];
        return next;
      });
    } catch (err) {
      setEntries((prev) => (prev ? prev.map((e) => (e.crm_id === entry.crm_id ? { ...e, status: previous } : e)) : prev));
      setStatusErrorByEntry((prev) => ({
        ...prev,
        [entry.crm_id]: err instanceof ApiError ? err.message : "Status update failed.",
      }));
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{view.name}</p>
          <p className="text-xs text-muted-foreground">{view.description}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          {total} entr{total === 1 ? "y" : "ies"}
        </Badge>
      </div>

      {loadError ? <ErrorMessage description={loadError} onRetry={refresh} /> : null}
      {entries === null && !loadError ? <LoadingSpinner label="Loading entries…" /> : null}

      {entries !== null && entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing captured for this schema yet.</p>
      ) : null}

      {entries && entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map((entry) => (
            <details key={entry.crm_id} className="rounded-md border p-2">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                <span className="inline-flex items-center gap-2">
                  {entry.contact_name ? `${entry.contact_name} — ` : ""}
                  {entry.contact_email}
                  {entry.wants_human ? (
                    <Badge variant="destructive" className="gap-1 text-xs">
                      <Headset className="size-3" />
                      Wants human
                    </Badge>
                  ) : null}
                </span>
                <Select value={entry.status} onValueChange={(v) => v && handleStatusChange(entry, v)}>
                  <SelectTrigger className="h-7 w-32 text-xs" onClick={(e) => e.stopPropagation()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {view.status_options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </summary>
              <div className="mt-2 space-y-2 text-xs">
                {statusErrorByEntry[entry.crm_id] ? (
                  <p className="text-destructive">{statusErrorByEntry[entry.crm_id]}</p>
                ) : null}
                <p className="text-muted-foreground">{entry.summary}</p>
                {Object.keys(entry.collected_fields).length > 0 ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-md bg-muted/50 p-2">
                    {view.fields.map((field) =>
                      entry.collected_fields[field.field_key] ? (
                        <React.Fragment key={field.field_key}>
                          <dt className="font-medium text-muted-foreground">{field.label}</dt>
                          <dd className="truncate">{entry.collected_fields[field.field_key]}</dd>
                        </React.Fragment>
                      ) : null,
                    )}
                  </dl>
                ) : null}
                {entry.attachment_url ? (
                  <a
                    href={entry.attachment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                  >
                    <Paperclip className="size-3" />
                    View attached file
                  </a>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {total > QUEUE_PAGE_SIZE ? (
        <Pagination page={page} pageSize={QUEUE_PAGE_SIZE} total={total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
