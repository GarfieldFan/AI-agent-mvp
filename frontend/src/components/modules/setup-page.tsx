"use client";

import Link from "next/link";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { SetupWizard } from "@/components/modules/setup-wizard";
import { useAuth } from "@/lib/auth";

/** `/setup` — the first-run onboarding wizard (2026-09-09). Gated the
 * same as the rest of the dashboard's agent console (admin OR owner) —
 * see `SetupWizard`'s own docstring for what it actually does. This
 * page is display-only gating (same posture as most of this app besides
 * `AgentConsoleSection`'s extra stale-token re-verification dance): the
 * backend independently re-checks the role on every real request the
 * wizard's embedded `ModelSettingsPanel` makes. */
export function SetupPage() {
  const { role } = useAuth();
  const canView = role === "admin" || role === "owner";

  return (
    <Container className="space-y-8 py-12">
      <PageHeader
        title="Setup wizard"
        description="Connect an AI model and see what to configure next — a guided starting point, not a separate configuration system."
      />

      {canView ? (
        <SetupWizard />
      ) : (
        <EmptyState
          icon={Lock}
          title="Admin or owner access needed"
          description="Log in with an admin or owner account to run the setup wizard."
          action={
            <Button render={<Link href="/login" />} nativeButton={false}>
              Log in
            </Button>
          }
        />
      )}
    </Container>
  );
}
