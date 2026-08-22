import { apiFetch } from "@/lib/api";

/** Generic recurring-task CRUD (2026-08-21, backend/scheduler.py +
 * backend/apis/scheduled_tasks.py) — not embed-specific, see the root
 * AGENTS.md's design note. Two independent interfaces write to the same
 * underlying table: this API (for direct dashboard editing) and owner-
 * agent's `manage_scheduled_task` tool (for "just tell it what you
 * want"). */
export type ScheduledTask = {
  id: number;
  name: string;
  task_type: string;
  task_args: Record<string, unknown>;
  cron_expression: string;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: "success" | "error" | null;
  last_run_error: string | null;
  created_by: string | null;
  created_at: string;
};

export type ScheduledTaskInput = {
  name: string;
  task_type: string;
  task_args: Record<string, unknown>;
  cron_expression: string;
  enabled: boolean;
};

/** Deliberately unpaginated — owner-curated, a handful of rows in
 * practice, same reasoning as lib/pages.ts's listPages. */
export function listScheduledTasks() {
  return apiFetch<ScheduledTask[]>("/api/agent/scheduled-tasks");
}

/** The current TASK_REGISTRY's keys, live from the backend — never
 * hardcoded here, so a new task type registered server-side shows up in
 * the picker with no frontend change needed. */
export function listScheduledTaskTypes() {
  return apiFetch<string[]>("/api/agent/scheduled-task-types");
}

/** Create-or-update BY NAME — mirrors the backend's own upsert
 * semantics (see apis/scheduled_tasks.py's create_scheduled_task
 * docstring): saving with a name that already exists updates that row
 * in place rather than creating a duplicate. */
export function createScheduledTask(input: ScheduledTaskInput) {
  return apiFetch<ScheduledTask>("/api/agent/scheduled-tasks", { method: "POST", body: input });
}

export function updateScheduledTask(id: number, input: ScheduledTaskInput) {
  return apiFetch<ScheduledTask>(`/api/agent/scheduled-tasks/${id}`, { method: "PUT", body: input });
}

export function deleteScheduledTask(id: number) {
  return apiFetch<void>(`/api/agent/scheduled-tasks/${id}`, { method: "DELETE" });
}

/** Runs the task immediately, bypassing its cron schedule — can take a
 * while for a slow task type (e.g. resync_url_document against a large
 * document), same "budget minutes, not seconds" tradeoff as poster
 * generation. */
export function runScheduledTaskNow(id: number) {
  return apiFetch<ScheduledTask>(`/api/agent/scheduled-tasks/${id}/run-now`, { method: "POST" });
}
