import type { LucideIcon } from "lucide-react";
import { Home, Info, LayoutDashboard, MessagesSquare, MousePointerClick } from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  description: string;
  icon: LucideIcon;
  /** Requires an authenticated session once auth ships (Phase 1). */
  requiresAuth?: boolean;
};

/** Single source of truth for primary navigation — consumed by the header,
 * mobile nav sheet, and footer sitemap so they never drift out of sync. */
export const primaryNav: NavItem[] = [
  {
    title: "Home",
    href: "/",
    description: "Landing page",
    icon: Home,
  },
  {
    title: "About",
    href: "/about",
    description: "About this project",
    icon: Info,
  },
  {
    title: "Chatbot",
    href: "/chat",
    description: "RAG-grounded conversational assistant",
    icon: MessagesSquare,
  },
  {
    title: "Page Editor",
    href: "/editor",
    description: "Click-to-edit (CTE)",
    icon: MousePointerClick,
  },
  {
    title: "Dashboard",
    href: "/dashboard",
    description: "User dashboard",
    icon: LayoutDashboard,
    requiresAuth: true,
  },
];
