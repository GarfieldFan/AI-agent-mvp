"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Lock, Users, BarChart3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { RoleBadge } from "@/components/common/role-badge";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { PageGeneratorPanel } from "@/components/modules/page-generator-panel";
import { PageManager } from "@/components/modules/page-manager";
import { DocumentManager } from "@/components/modules/document-manager";
import { ModelSettingsPanel } from "@/components/modules/model-settings-panel";
import { PosterGeneratorPanel } from "@/components/modules/poster-generator-panel";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type AgentCapability = {
  icon: LucideIcon;
  title: string;
  description: string;
  endpoint: string;
  // Minimal request body matching the endpoint's Pydantic model, so
  // "Try it" exercises the RBAC gate cleanly instead of failing on 422
  // body validation first.
  samplePayload: unknown;
};

// Mirrors backend/apis/agent.py — minus generate_landing_page, document
// ingestion, and poster generation, all real now (see
// PageGeneratorPanel/DocumentManager/PosterGeneratorPanel below) and
// pulled out of this generic sample-payload grid for the same reason:
// they need real input (an image, a document, a prompt), not a throwaway
// payload. The rest are still gated 501 stubs; "Try it" calls the real
// endpoint (with the logged-in user's JWT attached automatically by
// apiFetch — see lib/auth.ts) so you can see the RBAC gate itself
// working: 403 as `user`, 501 as `admin`/`owner`.
const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    icon: Users,
    title: "Push CRM entry",
    description: "Send a captured lead/inquiry to a third-party CRM.",
    endpoint: "/api/agent/crm/entries",
    samplePayload: { contact_email: "lead@example.com", summary: "Interested in enterprise plan", tags: ["hot-lead"] },
  },
  {
    icon: BarChart3,
    title: "Generate report",
    description: "Operational report/chart (chat volume, RAG query trends).",
    endpoint: "/api/agent/reports/generate",
    samplePayload: { report_type: "chat-volume", date_range: "2026-07" },
  },
];

function AgentCapabilityCard({ capability }: { capability: AgentCapability }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  async function tryIt() {
    setPending(true);
    setResult(null);
    try {
      await apiFetch(capability.endpoint, { method: "POST", body: capability.samplePayload });
      setResult("200 — unexpectedly implemented?");
    } catch (err) {
      if (err instanceof ApiError) {
        setResult(`${err.status} — ${err.message}`);
      } else {
        setResult("Request failed — is the backend running?");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <capability.icon className="size-6 text-primary" aria-hidden="true" />
          <Badge variant="outline" className="text-xs text-muted-foreground">
            Reserved
          </Badge>
        </div>
        <CardTitle className="text-base">{capability.title}</CardTitle>
        <CardDescription>{capability.description}</CardDescription>
        <code className="block pt-1 text-xs text-muted-foreground">
          POST {capability.endpoint}
        </code>
      </CardHeader>
      <div className="flex items-center gap-2 px-(--card-spacing) pb-(--card-spacing)">
        <Button size="sm" variant="outline" onClick={tryIt} disabled={pending}>
          Try it
        </Button>
        {pending ? <LoadingSpinner /> : null}
        {result ? <span className="text-xs text-muted-foreground">{result}</span> : null}
      </div>
    </Card>
  );
}

/** Role-gated section: a plain `user` (including anyone not logged in)
 * sees a locked EmptyState, admin/owner see the reserved capability cards
 * and can call the real (stub) backend routes to exercise the RBAC gate
 * live. The role comes from a real JWT now (see lib/auth.ts) — this is
 * purely a UI convenience, the backend re-verifies on every request. */
export function AgentConsoleSection() {
  const { role } = useAuth();
  const canView = role === "admin" || role === "owner";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Agent console (admin / owner only)</h2>
          <p className="text-sm text-muted-foreground">
            Reserved capabilities a plain `user` chatbot visitor can never
            reach — each is RBAC-gated on the backend.
          </p>
        </div>
        <RoleBadge role={role} />
      </div>

      {canView ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AGENT_CAPABILITIES.map((capability) => (
              <AgentCapabilityCard key={capability.title} capability={capability} />
            ))}
          </div>
          <ModelSettingsPanel />
          <DocumentManager />
          <PosterGeneratorPanel />
          <PageGeneratorPanel />
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Saved pages</h3>
            <PageManager />
          </div>
        </div>
      ) : (
        <EmptyState
          icon={Lock}
          title="Admin/owner access required"
          description="Log in as an admin or owner account (see /login) to see and test these reserved capabilities."
        />
      )}
    </section>
  );
}
