"use client";

import * as React from "react";
import { Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { listCrmEntries, pushCrmEntry, type CrmEntry } from "@/lib/crm";

/** Admin/owner only — backend/apis/agent.py's `/agent/crm/entries`,
 * real as of 2026-08-06 (see models.CrmEntry's doc comment for why this
 * stores leads in this project's own DB rather than pushing to a
 * third-party CRM nobody has an account for). A simple capture form plus
 * a list of what's already been captured, matching DocumentManager's
 * shape — this isn't meant to simulate an intake flow (that would come
 * from real chat-driven intent capture, separately scoped and not built
 * yet), just to prove the pipeline end-to-end. */
export function CrmPanel() {
  const [email, setEmail] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [tagsInput, setTagsInput] = React.useState("");
  const [pushStatus, setPushStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [pushError, setPushError] = React.useState<string | null>(null);

  const [entries, setEntries] = React.useState<CrmEntry[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);

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
      await pushCrmEntry({ contact_email: email.trim(), summary: summary.trim(), tags });
      setEmail("");
      setSummary("");
      setTagsInput("");
      setPushStatus("idle");
      refresh();
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : "Push failed — is the backend reachable?");
      setPushStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">CRM entries</h3>
        <p className="text-xs text-muted-foreground">
          Captures a lead/inquiry into this project&apos;s own database — there&apos;s no third-party CRM account
          configured, so this is a real internal record rather than a live external push.
        </p>
      </div>

      <div className="space-y-2">
        <Input placeholder="Contact email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <Textarea
          placeholder="Summary of the inquiry"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={2}
        />
        <Input
          placeholder="Tags, comma-separated (e.g. hot-lead, enterprise)"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
        />
        <Button onClick={handlePush} disabled={!email.trim() || !summary.trim() || pushStatus === "loading"}>
          Push entry
        </Button>
        {pushStatus === "loading" ? <LoadingSpinner label="Saving…" /> : null}
        {pushStatus === "error" && pushError ? <ErrorMessage description={pushError} onRetry={() => setPushStatus("idle")} /> : null}
      </div>

      <div className="space-y-2 border-t pt-4">
        {listError ? <ErrorMessage description={listError} onRetry={refresh} /> : null}
        {entries === null && !listError ? <LoadingSpinner label="Loading CRM entries…" /> : null}
        {entries && entries.length === 0 ? (
          <EmptyState icon={Users} title="No CRM entries yet" description="Push one above to see it appear here." />
        ) : null}
        {entries?.map((entry) => (
          <div key={entry.crm_id} className="space-y-1 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{entry.contact_email}</p>
              <p className="text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</p>
            </div>
            <p className="text-sm text-muted-foreground">{entry.summary}</p>
            {entry.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
