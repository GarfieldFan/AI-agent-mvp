"use client";

import * as React from "react";
import { BarChart3 } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { generateReport, type Report, type ReportType } from "@/lib/reports";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

const TODAY = new Date();
const WEEK_AGO = new Date(TODAY.getTime() - 6 * 24 * 60 * 60 * 1000);

/** Admin/owner only — backend/apis/agent.py's `/agent/reports/generate`,
 * real as of 2026-08-06 (chat-volume) / 2026-09-10 (revenue). Returns
 * structured per-day numbers, charted here directly with recharts — no
 * `report_url`/static file involved, this project has no infrastructure
 * for that and the underlying data is already relational. "RAG query
 * trends" (mentioned in the original stub) still isn't computable —
 * whether a turn used retrieved context was never persisted per message. */
export function ReportPanel() {
  const [reportType, setReportType] = React.useState<ReportType>("chat-volume");
  const [startDate, setStartDate] = React.useState(isoDate(WEEK_AGO));
  const [endDate, setEndDate] = React.useState(isoDate(TODAY));
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<Report | null>(null);

  const generate = React.useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await generateReport(reportType, startDate, endDate);
      setReport(result);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Report generation failed — is the backend reachable?");
      setStatus("error");
    }
  }, [reportType, startDate, endDate]);

  React.useEffect(() => {
    // One-time mount fetch (empty deps — never re-runs, no loop risk); the
    // lint rule can't tell that apart from a genuinely reactive setState
    // sync, so it flags this unconditionally regardless of actual risk —
    // same pattern as geo-page-panel.tsx's matching effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty =
    reportType === "chat-volume"
      ? report?.points.every((p) => !p.session_count && !p.message_count) ?? false
      : report?.points.every((p) => !p.order_count && !p.revenue_total) ?? false;

  const totalSessions = report?.points.reduce((sum, p) => sum + (p.session_count ?? 0), 0) ?? 0;
  const totalMessages = report?.points.reduce((sum, p) => sum + (p.message_count ?? 0), 0) ?? 0;
  const totalOrders = report?.points.reduce((sum, p) => sum + (p.order_count ?? 0), 0) ?? 0;
  const totalRevenue = report?.points.reduce((sum, p) => sum + (p.revenue_total ?? 0), 0) ?? 0;

  return (
    <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Reports</h3>
        <p className="text-xs text-muted-foreground">
          {reportType === "chat-volume"
            ? "New chat sessions and messages per day, from the same data the visitor-conversation log already captures."
            : "Paid-order count and revenue per day."}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Report</Label>
          <Select value={reportType} onValueChange={(v) => v && setReportType(v as ReportType)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat-volume">Chat volume</SelectItem>
              <SelectItem value="revenue">Revenue</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="report-start" className="text-xs text-muted-foreground">
            Start date
          </Label>
          <Input id="report-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="report-end" className="text-xs text-muted-foreground">
            End date
          </Label>
          <Input id="report-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </div>
        <Button onClick={generate} disabled={status === "loading"}>
          Generate
        </Button>
        {status === "loading" ? <LoadingSpinner /> : null}
      </div>

      {status === "error" && error ? <ErrorMessage description={error} onRetry={generate} /> : null}

      {report && isEmpty ? (
        <EmptyState
          icon={BarChart3}
          title={reportType === "chat-volume" ? "No chat activity in this range" : "No paid orders in this range"}
          description={
            reportType === "chat-volume"
              ? "Nobody has used the public chatbot during the selected dates yet."
              : "No orders were paid during the selected dates yet."
          }
        />
      ) : null}

      {report && !isEmpty && reportType === "chat-volume" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {totalSessions} session{totalSessions === 1 ? "" : "s"}, {totalMessages} message
            {totalMessages === 1 ? "" : "s"} in this range.
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={report.points}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="session_count" name="Sessions" stroke="var(--primary)" strokeWidth={2} />
                <Line type="monotone" dataKey="message_count" name="Messages" stroke="#8884d8" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      {report && !isEmpty && reportType === "revenue" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {totalOrders} order{totalOrders === 1 ? "" : "s"}, ${totalRevenue.toFixed(2)} revenue in this range.
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={report.points}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="revenue_total" name="Revenue ($)" stroke="var(--primary)" strokeWidth={2} />
                <Line type="monotone" dataKey="order_count" name="Orders" stroke="#8884d8" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
