import Link from "next/link";
import { ShoppingCart, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { NavLink } from "@/components/layout/nav-link";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ModeToggle } from "@/components/mode-toggle";
import { AuthStatus } from "@/components/common/auth-status";
import { primaryNav } from "@/config/nav";

export function SiteHeader() {
  return (
    // z-50 (2026-09-08, was z-40) — this header is the one persistent,
    // global piece of chrome every route sits under; it needs to
    // outrank anything a page itself renders, not just tie with it. It
    // was tied with /editor's own per-section hover toolbar (also
    // z-40) — CSS resolves an exact z-index tie by DOM order, and that
    // toolbar renders later in the tree, so on a tie it was winning and
    // painting over this header whenever the two visually coincided
    // (the same class of bug fixed in cte-editor-panel.tsx's own sticky
    // toolbar just above this — see the root AGENTS.md's CTE section).
    // Now ties with Sheet's own z-50 (shadcn/ui) instead — an open Sheet
    // is portalled near the end of <body>, so it still wins that tie and
    // correctly covers the header too while it's open, which is the
    // actually-wanted behavior for a modal-style editor panel.
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60">
      <Container className="flex h-14 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Sparkles className="size-5 text-primary" />
          <span>AI MVP</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {primaryNav.map((item) => (
            <NavLink key={item.href} href={item.href} title={item.title} />
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* No live item-count badge — that would need a cart fetch on
              every page load just for a header icon; /cart itself always
              shows the real count. */}
          <Button variant="ghost" size="icon" aria-label="Cart" nativeButton={false} render={<Link href="/cart" />}>
            <ShoppingCart className="size-4" />
          </Button>
          <AuthStatus />
          <ModeToggle />
          <div className="md:hidden">
            <MobileNav />
          </div>
        </div>
      </Container>
    </header>
  );
}
