"use client";

import * as React from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Loader2, MousePointerClick, Pencil, type LucideIcon } from "lucide-react";

import { isStaffRole, useAuth } from "@/lib/auth";
import { slugForPagePath } from "@/lib/pages";
import { cn } from "@/lib/utils";

/** Swaps the link's icon for a spinner while its navigation is pending —
 * /dashboard in particular is heavy and can take a few seconds to
 * compile in dev, which otherwise reads as "the click did nothing". */
function LinkIcon({ icon: Icon }: { icon: LucideIcon }) {
  const { pending } = useLinkStatus();
  return pending ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />;
}

const LINK_CLASS =
  "flex items-center gap-1.5 rounded px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white";

/** WordPress-admin-bar-style strip above the site header, rendered only
 * for an admin/owner session — the one place backend links (Dashboard,
 * Page Editor — the site menu is a tab inside it) live, so the public header/menu stays purely
 * visitor-facing. Display-only gating: every backend route re-verifies.
 *
 * Sets `data-admin-bar` on <html> while shown so `--site-chrome-h`
 * (globals.css) grows to include this bar — anything sticky under the
 * site chrome (CteEditorPanel's toolbar) offsets by that variable. */
export function AdminBar() {
  const { token, role } = useAuth();
  const pathname = usePathname();
  const visible = Boolean(token) && isStaffRole(role);

  React.useEffect(() => {
    if (!visible) return;
    document.documentElement.dataset.adminBar = "";
    return () => {
      delete document.documentElement.dataset.adminBar;
    };
  }, [visible]);

  if (!visible) return null;

  const editSlug = slugForPagePath(pathname);

  return (
    <div className="h-9 border-b border-zinc-800 bg-zinc-900 text-xs">
      <div className="mx-auto flex h-full max-w-6xl items-center gap-1 overflow-x-auto px-4 whitespace-nowrap">
        <Link href="/dashboard" className={cn(LINK_CLASS, pathname.startsWith("/dashboard") && "bg-zinc-800 text-white")}>
          <LinkIcon icon={LayoutDashboard} />
          Dashboard
        </Link>
        <Link href="/editor" className={cn(LINK_CLASS, pathname === "/editor" && "bg-zinc-800 text-white")}>
          <LinkIcon icon={MousePointerClick} />
          Page Editor
        </Link>
        {editSlug ? (
          <Link
            href={`/editor?slug=${encodeURIComponent(editSlug)}`}
            className={cn(LINK_CLASS, "ml-auto text-zinc-100")}
          >
            <LinkIcon icon={Pencil} />
            Edit this page
          </Link>
        ) : null}
      </div>
    </div>
  );
}
