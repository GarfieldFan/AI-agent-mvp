import { apiFetch } from "@/lib/api";

/** Owner-facing view onto backend/error_alerts.py's basic error log
 * (2026-09-09) — every genuinely unhandled backend error (a crash, not
 * a routine 4xx), most-recent-first. The alert-email address that
 * decides whether one of these also triggers an email lives in
 * `lib/notifications.ts`'s `NotificationSettings.alert_email`. */
export type ErrorLogEntry = {
  timestamp: string;
  method: string;
  path: string;
  error: string;
  traceback: string;
};

export function listErrorLog(limit = 50) {
  return apiFetch<ErrorLogEntry[]>(`/api/agent/error-log?limit=${limit}`);
}

/** Deliberately triggers a real unhandled exception so it flows through
 * the ACTUAL error_alerts.py pipeline (log + cooldown-gated email) —
 * always rejects (the backend responds 500 on purpose), so a caller
 * should treat any thrown ApiError here as "the test ran," not a real
 * failure, then re-check the log/inbox. */
export function triggerTestError() {
  return apiFetch<void>("/api/agent/error-log/test", { method: "POST" });
}
