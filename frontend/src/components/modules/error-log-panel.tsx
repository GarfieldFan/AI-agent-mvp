"use client";

import * as React from "react";
import { Bug, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { listErrorLog, triggerTestError, type ErrorLogEntry } from "@/lib/error-log";

/** Read-only view onto backend/error_alerts.py's basic error log
 * (2026-09-09) — every genuinely unhandled backend error, most-recent-
 * first. Lives in "Products & orders" alongside `NotificationSettingsPanel`
 * (which owns the `alert_email` field this log's alerting reuses) even
 * though it isn't products/orders-specific — no dedicated "system
 * health" group exists yet, same "not X-specific despite living here"
 * posture `ScheduledTasksPanel` already has next to `DocumentManager`. */
export function ErrorLogPanel() {
  const [entries, setEntries] = React.useState<ErrorLogEntry[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [testStatus, setTestStatus] = React.useState<"idle" | "running" | "done">("idle");

  const refresh = React.useCallback(() => {
    listErrorLog()
      .then((result) => {
        setEntries(result);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load the error log."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleTriggerTest() {
    setTestStatus("running");
    try {
      await triggerTestError();
    } catch {
      // Expected — the backend deliberately raises and responds 500.
    }
    setTestStatus("done");
    refresh();
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Bug className="h-4 w-4" />
          Error log
        </h3>
        <p className="text-xs text-muted-foreground">
          Every genuinely unhandled backend error (a crash) — never a routine 4xx. Set an alert email
          above to also get notified by email when one of these happens.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={handleTriggerTest} disabled={testStatus === "running"}>
          {testStatus === "running" ? "Triggering…" : "Trigger test error"}
        </Button>
        {testStatus === "done" ? (
          <span className="text-xs text-muted-foreground">
            Test error triggered — check the list below (and your alert inbox, if configured).
          </span>
        ) : null}
      </div>

      {loadError ? <ErrorMessage description={loadError} onRetry={refresh} /> : null}

      {!entries && !loadError ? <LoadingSpinner label="Loading error log…" /> : null}

      {entries && entries.length === 0 ? (
        <EmptyState icon={Bug} title="No errors logged" description="Nothing here yet — that's a good sign." />
      ) : null}

      {entries && entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <details key={`${entry.timestamp}-${i}`} className="rounded-lg border p-3">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <Badge variant="destructive" className="text-xs">
                  {entry.method} {entry.path}
                </Badge>
                <span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span>
                <span className="font-medium">{entry.error}</span>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {entry.traceback}
              </pre>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}
