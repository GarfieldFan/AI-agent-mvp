"use client";

import { Lock } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { RoleBadge } from "@/components/common/role-badge";
import { CrmPanel } from "@/components/modules/crm-panel";
import { DocumentManager } from "@/components/modules/document-manager";
import { GeoPagePanel } from "@/components/modules/geo-page-panel";
import { ModelSettingsPanel } from "@/components/modules/model-settings-panel";
import { PageGeneratorPanel } from "@/components/modules/page-generator-panel";
import { PageManager } from "@/components/modules/page-manager";
import { PosterGeneratorPanel } from "@/components/modules/poster-generator-panel";
import { ReportPanel } from "@/components/modules/report-panel";
import { useAuth } from "@/lib/auth";

/** Role-gated section: a plain `user` (including anyone not logged in)
 * sees a locked EmptyState, admin/owner see the real agent-console
 * capabilities. The role comes from a real JWT now (see lib/auth.ts) —
 * this is purely a UI convenience, the backend re-verifies on every
 * request.
 *
 * **2026-08-06**: the generic "Reserved capability" stub-card grid
 * (sample-payload `AgentCapabilityCard`s that just exercised the RBAC
 * gate against a still-501 endpoint) is gone — CRM entry capture and
 * report generation, its last two occupants, are both real now
 * (`CrmPanel`/`ReportPanel`), joining `generate_landing_page`/
 * `generate_poster`/`generate_geo_page` before them. Every capability
 * `backend/apis/agent.py` exposes is real as of this point; there's
 * nothing left to reserve a placeholder grid for. */
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
          <ModelSettingsPanel />
          <DocumentManager />
          <GeoPagePanel />
          <PosterGeneratorPanel />
          <PageGeneratorPanel />
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Saved pages</h3>
            <PageManager />
          </div>
          <CrmPanel />
          <ReportPanel />
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
