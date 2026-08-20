import { getAuthToken } from "@/lib/auth";
import { apiFetch, ApiError } from "@/lib/api";

/** Base URL of the owner-agent service (see ../../docker-compose.yml) —
 * a separate container from the FastAPI backend (see root AGENTS.md's
 * Phase 6 note on why a real tool-calling loop must not run inside
 * `backend`). Unlike lib/api.ts's API_BASE_URL, this only ever needs the
 * browser-facing variant: the owner-agent panel is a client component with
 * no page-load SSR fetch, so there's no Server Component call to route
 * through Docker DNS. */
const OWNER_AGENT_URL = process.env.NEXT_PUBLIC_OWNER_AGENT_URL ?? "http://localhost:8100";

export type OwnerAgentStep = {
  index: number;
  type: "tool_call" | "final_answer" | "parse_error";
  thought: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  ok: boolean | null;
  text: string | null;
};

export type OwnerAgentRunResult = {
  final_answer: string;
  stopped_reason: "final_answer" | "max_iterations" | "timeout";
  steps: OwnerAgentStep[];
};

export type OwnerAgentRunSummary = {
  id: number;
  owner_email: string;
  command: string;
  final_answer: string;
  stopped_reason: string;
  steps: OwnerAgentStep[];
  created_at: string;
};

/** Owner only — see owner-agent/deps.py, stricter than every other
 * agent-console capability (admin OR owner). Runs a real LLM tool-calling
 * loop against a fixed allowlist of 9 backend actions (owner-agent/tools.py);
 * can take minutes if it calls generate_poster or generate_landing_page. */
export async function runOwnerAgentCommand(command: string): Promise<OwnerAgentRunResult> {
  const token = getAuthToken();

  const response = await fetch(`${OWNER_AGENT_URL}/run`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ command }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => undefined);
    throw new ApiError(
      response.status,
      (errorBody as { detail?: string })?.detail ?? response.statusText,
      errorBody,
    );
  }

  return (await response.json()) as OwnerAgentRunResult;
}

export type OwnerAgentRunListResult = {
  items: OwnerAgentRunSummary[];
  total: number;
};

/** Queryable run history (2026-08-19, backend/models.py's
 * OwnerAgentRun) — goes through the regular backend (lib/api.ts's
 * apiFetch), not the owner-agent service directly, since this is
 * backend's own table, not owner-agent's own state. Most-recent-first.
 * Really paginated now (2026-08-20, was a hard `limit=50` cap with no
 * way to see older runs at all — see the root AGENTS.md). */
export function listOwnerAgentRuns(limit = 20, offset = 0) {
  return apiFetch<OwnerAgentRunListResult>(`/api/agent/owner-agent/runs?limit=${limit}&offset=${offset}`);
}
