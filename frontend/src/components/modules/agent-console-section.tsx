"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Bot,
  ClipboardCheck,
  Contact,
  Cpu,
  Library,
  Lock,
  MessageSquareText,
  Plug,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/common/empty-state";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { BusinessProfilePanel } from "@/components/modules/business-profile-panel";
import { ChatPromptSettingsPanel } from "@/components/modules/chat-prompt-settings-panel";
import { ChatSessionViewerPanel } from "@/components/modules/chat-session-viewer-panel";
import { CrmPanel } from "@/components/modules/crm-panel";
import { DocumentManager } from "@/components/modules/document-manager";
import { GeoPagePanel } from "@/components/modules/geo-page-panel";
import { IntentSchemaPanel } from "@/components/modules/intent-schema-panel";
import { MapSettingsPanel } from "@/components/modules/map-settings-panel";
import { ModelSettingsPanel } from "@/components/modules/model-settings-panel";
import { MarketingSettingsPanel } from "@/components/modules/marketing-settings-panel";
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
import { StockItemPanel } from "@/components/modules/stock-item-panel";
import { ReportPanel } from "@/components/modules/report-panel";
import { ReviewQueuePanel } from "@/components/modules/review-queue-panel";
import { ScheduledTasksPanel } from "@/components/modules/scheduled-tasks-panel";
import { SetupStatusBanner } from "@/components/modules/setup-status-banner";
import { UserManagementPanel } from "@/components/modules/user-management-panel";
import { TurnstileSettingsPanel } from "@/components/modules/turnstile-settings-panel";
import { ApiError, apiFetch } from "@/lib/api";
import { clearAuth, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

type ConsoleItem = { id: string; label: string; render: () => ReactNode };
type ConsoleSection = { id: string; label: string; icon: LucideIcon; items: ConsoleItem[] };

/** Builds `/dashboard?section=…&item=…` — the selected screen lives in
 * the URL so it survives a refresh, can be linked to (e.g.
 * DefaultHomeAdminNotice → the page generator), and Back works. */
function consoleHref(pathname: string, section: string, item?: string): string {
  const params = new URLSearchParams({ section });
  if (item) params.set("item", item);
  return `${pathname}?${params.toString()}`;
}

/** Role-gated, WordPress-admin-style console (2026-10-31, replaced one
 * long collapsible Accordion of every panel, per direct user feedback): a
 * dark left sidebar of sections, the active section's sub-items listed
 * under it (like WP's "Dashboard → Home / Updates"), and ONE screen
 * rendered at a time on the right. Only the selected panel is mounted, so
 * opening the dashboard doesn't fire every panel's fetches at once.
 *
 * A plain `user` (including anyone not logged in) sees a locked
 * EmptyState instead. The role comes from a real JWT (see lib/auth.ts) —
 * this is purely a UI convenience, the backend re-verifies on every
 * request. */
export function AgentConsoleSection() {
  const { role } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
  // Bumped whenever PageGeneratorPanel's SavePageForm saves a page — tells
  // PageManager to reload (see its own `refreshToken` doc comment). The
  // two are separate screens now, so PageManager also refetches on every
  // visit anyway; kept so that contract stays correct regardless.
  const [pagesRefreshToken, setPagesRefreshToken] = useState(0);

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

  const sections: ConsoleSection[] = [
    {
      id: "model",
      label: "AI model",
      icon: Cpu,
      items: [{ id: "model", label: "AI model", render: () => <ModelSettingsPanel /> }],
    },
    {
      id: "chat-prompts",
      label: "Chat prompts",
      icon: MessageSquareText,
      items: [{ id: "prompts", label: "Chat prompts", render: () => <ChatPromptSettingsPanel /> }],
    },
    {
      id: "knowledge",
      label: "Knowledge base",
      icon: Library,
      items: [
        { id: "documents", label: "Documents", render: () => <DocumentManager /> },
        { id: "scheduled-tasks", label: "Scheduled tasks", render: () => <ScheduledTasksPanel /> },
      ],
    },
    {
      id: "content",
      label: "Content",
      icon: Sparkles,
      items: [
        {
          id: "page-generator",
          label: "Page generator",
          render: () => <PageGeneratorPanel onSaved={() => setPagesRefreshToken((t) => t + 1)} />,
        },
        { id: "pages", label: "Saved pages", render: () => <PageManager refreshToken={pagesRefreshToken} /> },
        { id: "posters", label: "Posters", render: () => <PosterGeneratorPanel /> },
        { id: "geo-page", label: "GEO page", render: () => <GeoPagePanel /> },
      ],
    },
    {
      id: "seo",
      label: "SEO & AI discoverability",
      icon: Search,
      items: [{ id: "business-profile", label: "Business profile", render: () => <BusinessProfilePanel /> }],
    },
    {
      id: "crm",
      label: "CRM & reporting",
      icon: Contact,
      items: [
        { id: "leads", label: "Leads", render: () => <CrmPanel /> },
        { id: "request-types", label: "Request types", render: () => <IntentSchemaPanel /> },
        { id: "reports", label: "Reports", render: () => <ReportPanel /> },
        { id: "chat-history", label: "Chat history", render: () => <ChatSessionViewerPanel /> },
      ],
    },
    {
      id: "review-queues",
      label: "Review queues",
      icon: ClipboardCheck,
      items: [{ id: "queues", label: "Review queues", render: () => <ReviewQueuePanel /> }],
    },
    {
      id: "commerce",
      label: "Products & orders",
      icon: ShoppingBag,
      items: [
        { id: "products", label: "Products", render: () => <ProductPanel /> },
        { id: "stock", label: "Stock", render: () => <StockItemPanel /> },
        { id: "orders", label: "Orders", render: () => <OrderPanel /> },
      ],
    },
    {
      // Split out of "Products & orders" (2026-10-31) — these only lived
      // there for lack of a better home; they're third-party service
      // credentials, not catalog/order management.
      id: "integrations",
      label: "Integrations",
      icon: Plug,
      items: [
        { id: "payments", label: "Payments", render: () => <PaymentSettingsPanel /> },
        { id: "notifications", label: "Email & SMS", render: () => <NotificationSettingsPanel /> },
        { id: "marketing", label: "Marketing", render: () => <MarketingSettingsPanel /> },
        { id: "maps", label: "Maps", render: () => <MapSettingsPanel /> },
      ],
    },
    {
      id: "users",
      label: "Users & access",
      icon: UserCog,
      items: [
        { id: "users", label: "Users", render: () => <UserManagementPanel /> },
        { id: "social-login", label: "Social login", render: () => <OAuthSettingsPanel /> },
      ],
    },
    {
      id: "security",
      label: "Security",
      icon: ShieldCheck,
      items: [
        { id: "bot-verification", label: "Bot verification", render: () => <TurnstileSettingsPanel /> },
        { id: "error-log", label: "Error log", render: () => <ErrorLogPanel /> },
      ],
    },
    ...(canViewOwnerAgent
      ? [
          {
            id: "owner-agent",
            label: "Owner agent",
            icon: Bot,
            items: [{ id: "agent", label: "Owner agent", render: () => <OwnerAgentPanel /> }],
          },
        ]
      : []),
  ];

  // Unknown/missing ids fall back to the first section/item — the model
  // picker, since nothing else works until a model is connected.
  const activeSection = sections.find((s) => s.id === searchParams.get("section")) ?? sections[0];
  const activeItem = activeSection.items.find((i) => i.id === searchParams.get("item")) ?? activeSection.items[0];
  const hasSubItems = activeSection.items.length > 1;

  if (verifying) return <LoadingSpinner label="Checking your session…" className="p-10" />;

  if (!canView) {
    return (
      <EmptyState
        icon={Lock}
        title={sessionExpired ? "Your session has expired" : "Admin/owner access required"}
        description={
          sessionExpired
            ? "You were logged out because your session is no longer valid — log in again (see /login) to continue."
            : "Log in as an admin or owner account (see /login) to manage this site."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <aside className="shrink-0 md:sticky md:top-[calc(var(--site-chrome-h)+1.5rem)] md:w-56">
        <nav
          aria-label="Dashboard sections"
          className="flex gap-1 overflow-x-auto rounded-xl bg-zinc-900 p-2 text-sm text-zinc-300 md:flex-col md:overflow-visible"
        >
          {sections.map((section) => {
            const active = section.id === activeSection.id;
            const Icon = section.icon;
            return (
              <div key={section.id} className="shrink-0">
                <Link
                  href={consoleHref(pathname, section.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 whitespace-nowrap transition-colors hover:bg-zinc-800 hover:text-white",
                    active && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {section.label}
                </Link>
                {/* Sub-items under the active section only, WP-style.
                    Desktop only — on mobile they render as a pill row
                    above the content instead (see below). */}
                {active && hasSubItems ? (
                  <ul className="mt-1 mb-2 hidden space-y-0.5 pl-9 md:block">
                    {section.items.map((item) => (
                      <li key={item.id}>
                        <Link
                          href={consoleHref(pathname, section.id, item.id)}
                          aria-current={item.id === activeItem.id ? "page" : undefined}
                          className={cn(
                            "block rounded px-2 py-1 text-zinc-400 transition-colors hover:text-white",
                            item.id === activeItem.id && "font-medium text-white",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        <SetupStatusBanner />
        <div className="space-y-2 border-b pb-3">
          <h1 className="text-xl font-semibold">
            {activeSection.label}
            {hasSubItems ? <span className="text-muted-foreground"> / {activeItem.label}</span> : null}
          </h1>
          {hasSubItems ? (
            <div className="flex gap-1 overflow-x-auto md:hidden">
              {activeSection.items.map((item) => (
                <Link
                  key={item.id}
                  href={consoleHref(pathname, activeSection.id, item.id)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1 text-xs",
                    item.id === activeItem.id ? "bg-foreground text-background" : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        {/* key: remount on switch so each screen starts fresh, like a real
            page navigation (and the old Accordion's unmount-on-close). */}
        <div key={`${activeSection.id}/${activeItem.id}`}>{activeItem.render()}</div>
      </div>
    </div>
  );
}
