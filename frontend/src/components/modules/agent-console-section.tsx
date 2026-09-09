"use client";

import { Lock } from "lucide-react";
import { useEffect, useState } from "react";

import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { RoleBadge } from "@/components/common/role-badge";
import { BusinessProfilePanel } from "@/components/modules/business-profile-panel";
import { ChatPromptSettingsPanel } from "@/components/modules/chat-prompt-settings-panel";
import { ChatSessionViewerPanel } from "@/components/modules/chat-session-viewer-panel";
import { CrmPanel } from "@/components/modules/crm-panel";
import { DocumentManager } from "@/components/modules/document-manager";
import { GeoPagePanel } from "@/components/modules/geo-page-panel";
import { IntentSchemaPanel } from "@/components/modules/intent-schema-panel";
import { MapSettingsPanel } from "@/components/modules/map-settings-panel";
import { ModelSettingsPanel } from "@/components/modules/model-settings-panel";
import { NotificationSettingsPanel } from "@/components/modules/notification-settings-panel";
import { ErrorLogPanel } from "@/components/modules/error-log-panel";
import { OAuthSettingsPanel } from "@/components/modules/oauth-settings-panel";
import { OrderPanel } from "@/components/modules/order-panel";
import { OwnerAgentPanel } from "@/components/modules/owner-agent-panel";
import { PageGeneratorPanel } from "@/components/modules/page-generator-panel";
import { PageManager } from "@/components/modules/page-manager";
import { PaymentSettingsPanel } from "@/components/modules/payment-settings-panel";
import { PosterGeneratorPanel } from "@/components/modules/poster-generator-panel";
import { ProductPanel } from "@/components/modules/product-panel";
import { ReportPanel } from "@/components/modules/report-panel";
import { ReviewQueuePanel } from "@/components/modules/review-queue-panel";
import { ScheduledTasksPanel } from "@/components/modules/scheduled-tasks-panel";
import { SetupStatusBanner } from "@/components/modules/setup-status-banner";
import { UserManagementPanel } from "@/components/modules/user-management-panel";
import { TurnstileSettingsPanel } from "@/components/modules/turnstile-settings-panel";
import { ApiError, apiFetch } from "@/lib/api";
import { clearAuth, useAuth } from "@/lib/auth";

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
  // The cached role in localStorage can outlive the token that backs it —
  // e.g. the server's JWT_SECRET rotates, or the token simply expires
  // server-side between page loads. `useAuth()` alone can't tell a real
  // privileged session from a stale one, so on every mount where the
  // cached role *claims* admin/owner, re-verify it against the backend
  // (GET /auth/me, the one route that just echoes back what the token
  // actually decodes to) before rendering any gated panel. This is what
  // makes a rotated/expired session get caught on page refresh, instead
  // of every panel firing a request that comes back 403.
  // Lazily seeded from the role visible at mount — true whenever the
  // cached role *claims* privilege, so a page refresh with a stale token
  // starts out "verifying" instead of flashing gated panels first.
  const [verifying, setVerifying] = useState(() => role !== "user");
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (role === "user") return; // nothing gated to verify

    let cancelled = false;
    apiFetch("/api/auth/me")
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setSessionExpired(true);
          clearAuth();
        }
        // Any other failure (network blip, backend down) is left alone —
        // don't log a real session out over a transient error.
      })
      .finally(() => {
        if (!cancelled) setVerifying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  const canView = !verifying && (role === "admin" || role === "owner");
  // OwnerAgentPanel is gated stricter than the rest of this section — it
  // runs a real LLM tool-calling loop (owner-agent/, a separate isolated
  // service), not a single deterministic pipeline call, so only the owner
  // role can reach it (see owner-agent/deps.py's require_owner, which
  // independently re-checks this on the backend regardless of what this
  // display-only check shows).
  const canViewOwnerAgent = !verifying && role === "owner";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold">Agent console (admin / owner only)</h2>
          <p className="text-sm text-muted-foreground">
            Reserved capabilities a plain `user` chatbot visitor can never
            reach — each is RBAC-gated on the backend.
          </p>
        </div>
        <RoleBadge role={role} />
      </div>

      {verifying ? (
        <LoadingSpinner label="Checking your session…" className="p-10" />
      ) : canView ? (
        <div className="space-y-4">
        <SetupStatusBanner />
        {/* Grouped into a collapsible accordion (2026-08-19) — 8 panels
            stacked flat had grown hard to navigate. `multiple` so more
            than one group can stay open at once (e.g. Model settings open
            while checking Document manager). `defaultValue={["model"]}`
            (2026-09-09, per direct user feedback) — the model picker is
            the one thing almost every session actually needs first
            (nothing else works until a model is connected), so it starts
            open while every other group starts collapsed. */}
        <Accordion multiple defaultValue={["model"]}>
          <AccordionItem value="model">
            <AccordionTrigger>AI model</AccordionTrigger>
            <AccordionPanel>
              <ModelSettingsPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="chat-prompts">
            <AccordionTrigger>Chat prompts</AccordionTrigger>
            <AccordionPanel>
              <ChatPromptSettingsPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="ai-kb">
            <AccordionTrigger>Knowledge base</AccordionTrigger>
            <AccordionPanel>
              <DocumentManager />
              <ScheduledTasksPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="content-gen">
            <AccordionTrigger>Content generation</AccordionTrigger>
            <AccordionPanel>
              <GeoPagePanel />
              <PosterGeneratorPanel />
              <PageGeneratorPanel />
              <div className="space-y-2 rounded-xl border bg-muted/40 p-4">
                <h3 className="text-lg font-semibold">Saved pages</h3>
                <PageManager />
              </div>
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="seo-geo">
            <AccordionTrigger>SEO & AI discoverability</AccordionTrigger>
            <AccordionPanel>
              <BusinessProfilePanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="crm-reporting">
            <AccordionTrigger>CRM & reporting</AccordionTrigger>
            <AccordionPanel>
              <IntentSchemaPanel />
              <CrmPanel />
              <ReportPanel />
              <ChatSessionViewerPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="products-orders">
            <AccordionTrigger>Products & orders</AccordionTrigger>
            <AccordionPanel>
              <ProductPanel />
              <OrderPanel />
              <PaymentSettingsPanel />
              <NotificationSettingsPanel />
              <ErrorLogPanel />
              <MapSettingsPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="review-queues">
            <AccordionTrigger>Review queues</AccordionTrigger>
            <AccordionPanel>
              <ReviewQueuePanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="users-access">
            <AccordionTrigger>Users & access</AccordionTrigger>
            <AccordionPanel>
              <UserManagementPanel />
              <OAuthSettingsPanel />
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="security">
            <AccordionTrigger>Security</AccordionTrigger>
            <AccordionPanel>
              <TurnstileSettingsPanel />
            </AccordionPanel>
          </AccordionItem>

          {canViewOwnerAgent ? (
            <AccordionItem value="owner-agent">
              <AccordionTrigger>Owner agent</AccordionTrigger>
              <AccordionPanel>
                <OwnerAgentPanel />
              </AccordionPanel>
            </AccordionItem>
          ) : null}
        </Accordion>
        </div>
      ) : (
        <EmptyState
          icon={Lock}
          title={sessionExpired ? "Your session has expired" : "Admin/owner access required"}
          description={
            sessionExpired
              ? "You were logged out because your session is no longer valid — log in again (see /login) to continue."
              : "Log in as an admin or owner account (see /login) to see and test these reserved capabilities."
          }
        />
      )}
    </section>
  );
}
