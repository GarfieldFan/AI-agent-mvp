import * as React from "react";

import { ApiError } from "@/lib/api";

export type AsyncApplyStatus = "idle" | "saving" | "error";

/** Shared apply-status/error state + try/catch boilerplate for a
 * "review a draft, then Apply or Discard" flow. `run(action)` sets
 * "saving", awaits `action` (which should do the real write(s) AND any
 * of its own success cleanup, e.g. clearing the pending draft state —
 * this hook only owns the status/error pair, never the draft itself),
 * then sets "idle" on success or captures a message on failure, the
 * same `ApiError`-aware fallback every caller already used. `reset()`
 * clears back to "idle" (used by both Discard and an ErrorMessage's
 * `onRetry`).
 *
 * Extracted 2026-09-11 from four hand-copied instances of the identical
 * shape in OwnerAgentPanel's schema/product/stock/business-profile
 * proposal-review cards. */
export function useAsyncApply() {
  const [status, setStatus] = React.useState<AsyncApplyStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(async (action: () => Promise<void>) => {
    setStatus("saving");
    setError(null);
    try {
      await action();
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Apply failed — is the backend reachable?");
      setStatus("error");
    }
  }, []);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { status, error, run, reset };
}
