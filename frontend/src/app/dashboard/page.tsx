import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingSpinner } from "@/components/common/loading-spinner";
import { AgentConsoleSection } from "@/components/modules/agent-console-section";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Site administration.",
};

/** WordPress-admin-style layout: sidebar + one screen at a time (see
 * AgentConsoleSection). Wider than the public pages' max-w-6xl Container
 * so the sidebar doesn't squeeze the panels. Suspense because
 * AgentConsoleSection reads `?section=`/`?item=` via useSearchParams. */
export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-8">
      <Suspense fallback={<LoadingSpinner className="p-10" />}>
        <AgentConsoleSection />
      </Suspense>
    </div>
  );
}
