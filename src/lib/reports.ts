import { apiFetch } from "@/lib/api";

export type ReportDayPoint = {
  date: string;
  session_count: number;
  message_count: number;
};

export type ChatVolumeReport = {
  report_type: "chat-volume";
  start_date: string;
  end_date: string;
  points: ReportDayPoint[];
};

/** Admin/owner only — see backend/apis/agent.py. Returns structured
 * per-day data for the caller to chart directly; there's no static
 * report-file generation in this project, so unlike the name might
 * suggest there's no URL to a rendered file here. */
export function generateChatVolumeReport(startDate: string, endDate: string) {
  return apiFetch<ChatVolumeReport>("/api/agent/reports/generate", {
    method: "POST",
    body: { report_type: "chat-volume", start_date: startDate, end_date: endDate },
  });
}
