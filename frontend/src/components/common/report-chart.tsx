"use client";

import { BarChart3 } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyState } from "@/components/common/empty-state";
import type { Report } from "@/lib/reports";

/** Shared recharts rendering for a generated Report (2026-09-10, split
 * out of report-panel.tsx once OwnerAgentPanel needed the identical
 * chart inline in a chat result) — one place to get the chart shape
 * right, used both by ReportPanel's own dashboard section and by
 * OwnerAgentPanel rendering a `generate_report` tool call's result
 * directly in the conversation, so a report looks the same whether the
 * owner asked for it via the form or via a chat command. */
export function ReportChart({ report }: { report: Report }) {
  const isEmpty =
    report.report_type === "chat-volume"
      ? report.points.every((p) => !p.session_count && !p.message_count)
      : report.points.every((p) => !p.order_count && !p.revenue_total);

  if (isEmpty) {
    return (
      <EmptyState
        icon={BarChart3}
        title={report.report_type === "chat-volume" ? "No chat activity in this range" : "No paid orders in this range"}
        description={
          report.report_type === "chat-volume"
            ? "Nobody has used the public chatbot during the selected dates yet."
            : "No orders were paid during the selected dates yet."
        }
      />
    );
  }

  const totalSessions = report.points.reduce((sum, p) => sum + (p.session_count ?? 0), 0);
  const totalMessages = report.points.reduce((sum, p) => sum + (p.message_count ?? 0), 0);
  const totalOrders = report.points.reduce((sum, p) => sum + (p.order_count ?? 0), 0);
  const totalRevenue = report.points.reduce((sum, p) => sum + (p.revenue_total ?? 0), 0);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {report.report_type === "chat-volume"
          ? `${totalSessions} session${totalSessions === 1 ? "" : "s"}, ${totalMessages} message${totalMessages === 1 ? "" : "s"} in this range.`
          : `${totalOrders} order${totalOrders === 1 ? "" : "s"}, $${totalRevenue.toFixed(2)} revenue in this range.`}
      </p>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={report.points}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {report.report_type === "chat-volume" ? (
              <>
                <Line type="monotone" dataKey="session_count" name="Sessions" stroke="var(--primary)" strokeWidth={2} />
                <Line type="monotone" dataKey="message_count" name="Messages" stroke="#8884d8" strokeWidth={2} />
              </>
            ) : (
              <>
                <Line type="monotone" dataKey="revenue_total" name="Revenue ($)" stroke="var(--primary)" strokeWidth={2} />
                <Line type="monotone" dataKey="order_count" name="Orders" stroke="#8884d8" strokeWidth={2} />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
