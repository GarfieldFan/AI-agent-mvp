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
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { generateChatVolumeReport, type ChatVolumeReport } from "@/lib/reports";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

const TODAY = new Date();
const WEEK_AGO = new Date(TODAY.getTime() - 6 * 24 * 60 * 60 * 1000);

/** Admin/owner only — backend/apis/agent.py's `/agent/reports/generate`,
 * real as of 2026-08-06. Returns structured per-day counts (new chat
 * sessions, chat messages), charted here directly with recharts — no
 * `report_url`/static file involved, this project has no infrastructure
 * for that and the underlying data is already relational. Scoped to
 * chat volume only; "RAG query trends" (mentioned in the original stub)
 * isn't computable — whether a turn used retrieved context was never
 * persisted per message. */
export function ReportPanel() {
  const [startDate, setStartDate] = React.useState(isoDate(WEEK_AGO));
  const [endDate, setEndDate] = React.useState(isoDate(TODAY));
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<ChatVolumeReport | null>(null);

  const generate = React.useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await generateChatVolumeReport(startDate, endDate);
      setReport(result);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Report generation failed — is the backend reachable?");
      setStatus("error");
    }
  }, [startDate, endDate]);

  React.useEffect(() => {
    // One-time mount fetch (empty deps — never re-runs, no loop risk); the
    // lint rule can't tell that apart from a genuinely reactive setState
    // sync, so it flags this unconditionally regardless of actual risk —
    // same pattern as geo-page-panel.tsx's matching effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalSessions = report?.points.reduce((sum, p) => sum + p.session_count, 0) ?? 0;
  const totalMessages = report?.points.reduce((sum, p) => sum + p.message_count, 0) ?? 0;

  return (
    <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Chat volume report</h3>
        <p className="text-xs text-muted-foreground">
          New chat sessions and messages per day, from the same data the visitor-conversation log already captures.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
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

      {report && report.points.every((p) => p.session_count === 0 && p.message_count === 0) ? (
        <EmptyState
          icon={BarChart3}
          title="No chat activity in this range"
          description="Nobody has used the public chatbot during the selected dates yet."
        />
      ) : null}

      {report && !report.points.every((p) => p.session_count === 0 && p.message_count === 0) ? (
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
    </div>
  );
}
