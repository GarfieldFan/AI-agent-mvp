"use client";

import * as React from "react";
import { Bot } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { runOwnerAgentCommand, type OwnerAgentRunResult } from "@/lib/owner-agent";

/** Owner only (see owner-agent/deps.py — stricter than every other panel
 * in this section, which are admin OR owner). Sends a natural-language
 * command to the owner-agent container's `POST /run`, a real LLM
 * tool-calling loop over a fixed 5-tool allowlist (poster generation, CRM
 * capture/list, chat-volume reporting, GEO page regeneration) — the first
 * capability in this app where the model itself decides which action(s) to
 * take, not a single deterministic pipeline call. Renders the full step
 * trace so a run's reasoning is visible, not just its final answer. */
export function OwnerAgentPanel() {
  const [command, setCommand] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<OwnerAgentRunResult | null>(null);

  async function handleRun() {
    if (!command.trim()) return;
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      const runResult = await runOwnerAgentCommand(command.trim());
      setResult(runResult);
      setStatus("idle");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Run failed — is the owner-agent service reachable?",
      );
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Bot className="h-5 w-5" />
          Owner agent
        </h3>
        <p className="text-xs text-muted-foreground">
          Type a command in plain language — a real LLM tool-calling loop, running in its own
          isolated worker service, decides which actions to take (generate a poster, capture or
          list CRM entries, run a chat-volume report, regenerate the GEO page) and in what order.
        </p>
      </div>

      <div className="space-y-2">
        <Textarea
          placeholder="e.g. Generate a promo poster with the text '限时优惠', then log a CRM entry for jane@example.com about it"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          rows={3}
        />
        <Button onClick={handleRun} disabled={!command.trim() || status === "loading"}>
          Run
        </Button>
        {status === "loading" ? <LoadingSpinner label="Agent is working — this can take a few minutes if it generates an image…" /> : null}
        {status === "error" && error ? (
          <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
        ) : null}
      </div>

      {result ? (
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Final answer</p>
              <Badge variant={result.stopped_reason === "final_answer" ? "secondary" : "destructive"}>
                {result.stopped_reason}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{result.final_answer}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Step trace</p>
            {result.steps.map((step) => (
              <div key={step.index} className="space-y-1 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {step.index}
                    </Badge>
                    <span className="text-sm font-medium">{step.tool ?? step.type}</span>
                  </div>
                  {step.type === "tool_call" ? (
                    <Badge variant={step.ok ? "secondary" : "destructive"} className="text-xs">
                      {step.ok ? "ok" : "error"}
                    </Badge>
                  ) : null}
                </div>
                {step.thought ? <p className="text-xs text-muted-foreground">{step.thought}</p> : null}
                {Object.keys(step.args ?? {}).length > 0 ? (
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(step.args, null, 2)}
                  </pre>
                ) : null}
                {step.result ? (
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(step.result, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
