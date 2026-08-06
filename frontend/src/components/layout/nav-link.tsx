"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

type NavLinkProps = {
  href: string;
  title: string;
  className?: string;
  onNavigate?: () => void;
};

/** Highlights itself when the current route matches its `href`. Shared by
 * the desktop nav bar and the mobile nav sheet so active-state logic lives
 * in exactly one place.
 *
 * Takes plain strings rather than a whole `NavItem` — `NavItem.icon` is a
 * component reference, and this is a Client Component rendered from the
 * (Server Component) SiteHeader, so any prop crossing that boundary must be
 * serializable. */
export function NavLink({ href, title, className, onNavigate }: NavLinkProps) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
        isActive && "text-foreground",
        className,
      )}
    >
      {title}
    </Link>
  );
}
