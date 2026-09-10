import { apiFetch } from "@/lib/api";

export type ReportDayPoint = {
  date: string;
  session_count: number | null;
  message_count: number | null;
  /** Revenue report only (2026-09-10) — null on a chat-volume point. */
  order_count: number | null;
  revenue_total: number | null;
};

export type ReportType = "chat-volume" | "revenue";

export type Report = {
  report_type: ReportType;
  start_date: string;
  end_date: string;
  points: ReportDayPoint[];
};

/** Admin/owner only — see backend/apis/agent.py. Returns structured
 * per-day data for the caller to chart directly; there's no static
 * report-file generation in this project, so unlike the name might
 * suggest there's no URL to a rendered file here. "revenue" (2026-09-10)
 * is the second report type — order_count/revenue_total per day, paid
 * orders only. */
export function generateReport(reportType: ReportType, startDate: string, endDate: string) {
  return apiFetch<Report>("/api/agent/reports/generate", {
    method: "POST",
    body: { report_type: reportType, start_date: startDate, end_date: endDate },
  });
}
