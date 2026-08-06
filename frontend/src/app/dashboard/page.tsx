import type { Metadata } from "next";
import { LayoutDashboard } from "lucide-react";

import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { AgentConsoleSection } from "@/components/modules/agent-console-section";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Authenticated user dashboard.",
};

export default function DashboardPage() {
  return (
    <Container className="space-y-10 py-12">
      <PageHeader
        title="Dashboard"
        description="Role-gated user area. Log in (see the header) as an admin/owner account to unlock the Agent console below — real access is enforced by the backend on each request, never by the frontend alone."
      />

      <EmptyState
        icon={LayoutDashboard}
        title="Account details coming later"
        description="Login/JWT/RBAC is real now (see backend/apis/auth.py) — this page just doesn't show extended account details, ingested documents, or chat history yet."
      />

      <AgentConsoleSection />
    </Container>
  );
}
