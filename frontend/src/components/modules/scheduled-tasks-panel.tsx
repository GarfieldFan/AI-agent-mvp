"use client";

import * as React from "react";
import { Clock } from "lucide-react";

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
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTaskTypes,
  listScheduledTasks,
  runScheduledTaskNow,
  updateScheduledTask,
  type ScheduledTask,
} from "@/lib/scheduled-tasks";

type Draft = {
  name: string;
  task_type: string;
  task_args_text: string;
  cron_expression: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = { name: "", task_type: "", task_args_text: "{}", cron_expression: "0 3 * * *", enabled: true };

function toDraft(task: ScheduledTask): Draft {
  return {
    name: task.name,
    task_type: task.task_type,
    task_args_text: JSON.stringify(task.task_args ?? {}, null, 2),
    cron_expression: task.cron_expression,
    enabled: task.enabled,
  };
}

/** Owner-facing CRUD for the generic recurring-task engine (2026-08-21,
 * `lib/scheduled-tasks.ts`) — not embed-specific, see the root
 * `AGENTS.md`'s design note. `task_args` is a plain JSON `Textarea`
 * rather than a dynamic per-task_type form — the simplest thing that
 * works at this app's current task-type count (4), matching this app's
 * existing "simplest thing that produces valid data" posture (e.g.
 * `business_hours`'s own plain-Textarea editor). Owner-agent's
 * `manage_scheduled_task` tool is the other interface onto this same
 * table — either can create/adjust a task, neither is more
 * authoritative. */
export function ScheduledTasksPanel() {
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  const [taskTypes, setTaskTypes] = React.useState<string[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const [editingId, setEditingId] = React.useState<number | "new" | null>(null);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [runningId, setRunningId] = React.useState<number | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    Promise.all([listScheduledTasks(), listScheduledTaskTypes()])
      .then(([taskList, types]) => {
        setTasks(taskList);
        setTaskTypes(types);
        setLoadError(null);
        setLoaded(true);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load scheduled tasks."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function startCreate() {
    setDraft({ ...EMPTY_DRAFT, task_type: taskTypes[0] ?? "" });
    setSaveError(null);
    setEditingId("new");
  }

  function startEdit(task: ScheduledTask) {
    setDraft(toDraft(task));
    setSaveError(null);
    setEditingId(task.id);
  }

  async function handleSave() {
    let taskArgs: Record<string, unknown>;
    try {
      taskArgs = draft.task_args_text.trim() ? JSON.parse(draft.task_args_text) : {};
    } catch {
      setSaveError("Task args must be valid JSON (e.g. {} or {\"document_id\": 5}).");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const input = {
        name: draft.name.trim(),
        task_type: draft.task_type,
        task_args: taskArgs,
        cron_expression: draft.cron_expression.trim(),
        enabled: draft.enabled,
      };
      if (editingId === "new") {
        await createScheduledTask(input);
      } else if (editingId !== null) {
        await updateScheduledTask(editingId, input);
      }
      setEditingId(null);
      refresh();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this scheduled task? This can't be undone.")) return;
    try {
      await deleteScheduledTask(id);
      refresh();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  async function handleRunNow(id: number) {
    setRunningId(id);
    setRunError(null);
    try {
      await runScheduledTaskNow(id);
      refresh();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Run failed — is the backend reachable?");
    } finally {
      setRunningId(null);
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
        <LoadingSpinner label="Loading scheduled tasks…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Clock className="h-4 w-4" />
          Scheduled tasks
        </h3>
        <p className="text-xs text-muted-foreground">
          Recurring jobs (cron syntax, e.g. &quot;0 3 * * *&quot; for daily at 3am) — re-sync a URL-
          sourced document, re-embed everything, or clean up stale data on a schedule. Owner-agent can
          also create/adjust these from a plain-language command.
        </p>
      </div>

      {tasks.length === 0 ? (
        <EmptyState title="No scheduled tasks yet" description="Add one below, or ask owner-agent to set one up." />
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{task.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>{task.task_type}</code> · <code>{task.cron_expression}</code>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {task.last_run_status ? (
                    <Badge variant={task.last_run_status === "success" ? "secondary" : "destructive"}>
                      {task.last_run_status === "success" ? "Last run OK" : "Last run failed"}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Never run</Badge>
                  )}
                  <Badge variant={task.enabled ? "secondary" : "outline"}>{task.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
              </div>
              {task.last_run_at ? (
                <p className="text-xs text-muted-foreground">Last run: {new Date(task.last_run_at).toLocaleString()}</p>
              ) : null}
              {task.last_run_status === "error" && task.last_run_error ? (
                <p className="text-xs text-destructive">{task.last_run_error}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => handleRunNow(task.id)} disabled={runningId === task.id}>
                  {runningId === task.id ? "Running…" : "Run now"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => startEdit(task)}>
                  Edit
                </Button>
                <Button size="sm" variant="destructive" onClick={() => handleDelete(task.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {runError ? <ErrorMessage description={runError} onRetry={() => setRunError(null)} /> : null}

      {editingId !== null ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Daily legal-code re-sync" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Task type</Label>
            <Select value={draft.task_type} onValueChange={(v) => v && setDraft((d) => ({ ...d, task_type: v }))}>
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {taskTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Task args (JSON — e.g. <code>{"{\"document_id\": 5}"}</code> for resync_url_document)
            </Label>
            <Textarea
              value={draft.task_args_text}
              onChange={(e) => setDraft((d) => ({ ...d, task_args_text: e.target.value }))}
              rows={3}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cron expression (minute hour day month weekday)</Label>
            <Input
              value={draft.cron_expression}
              onChange={(e) => setDraft((d) => ({ ...d, cron_expression: e.target.value }))}
              placeholder="0 3 * * *"
              className="font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={draft.enabled} onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: Boolean(checked) }))} />
            <Label className="text-xs text-muted-foreground">Enabled</Label>
          </div>
          {saveError ? <ErrorMessage description={saveError} onRetry={() => setSaveError(null)} /> : null}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving || !draft.name.trim() || !draft.task_type || !draft.cron_expression.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={startCreate}>
          Add scheduled task
        </Button>
      )}
    </div>
  );
}
