"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { checkSetupStatus } from "@/lib/setup";

/** Nudges an admin/owner toward `/setup` when no chat model is actually
 * connected yet (2026-09-09) — rendered above the agent console's
 * accordion, `AgentConsoleSection`. Deliberately just a dismissible-by-
 * navigating-away nudge, not a forced redirect: the wizard configures
 * nothing this banner or the dashboard's own panels couldn't already do
 * directly, see `SetupWizard`'s own docstring. Renders nothing while
 * checking, on a check failure, or once a model is actually connected —
 * never nags with a broken/stale banner. */
export function SetupStatusBanner() {
  const [needsSetup, setNeedsSetup] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    checkSetupStatus()
      .then((status) => {
        if (!cancelled) setNeedsSetup(!status.chatConfigured);
      })
      .catch(() => {
        // Best-effort only — a transient backend blip shouldn't nag.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!needsSetup) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4">
      <span className="flex items-center gap-2 text-sm">
        <Sparkles className="h-4 w-4" />
        Your AI isn&apos;t connected yet — run the setup wizard to pick a model and get started.
      </span>
      <Button size="sm" render={<Link href="/setup" />} nativeButton={false}>
        Run setup wizard
      </Button>
    </div>
  );
}
