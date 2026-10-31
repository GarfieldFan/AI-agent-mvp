import Link from "next/link";
import { ShoppingCart, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { NavLink } from "@/components/layout/nav-link";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ModeToggle } from "@/components/mode-toggle";
import { AuthStatus } from "@/components/common/auth-status";
import { resolvePublicNavItems } from "@/lib/nav-menu";

export async function SiteHeader() {
  // The owner's saved menu (/editor → Menu), or the built-in default
  // (Home + About once saved). Admin links never live here — see AdminBar.
  const publicItems = await resolvePublicNavItems();

  return (
    // Not sticky itself — app/layout.tsx wraps this and AdminBar in one
    // sticky z-50 container so the two stack (see that comment for the
    // z-index reasoning, originally from a 2026-09-08 /editor tie bug).
    <header className="border-b bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60">
      <Container className="flex h-14 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Sparkles className="size-5 text-primary" />
          <span>AI MVP</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {publicItems.map((item) => (
            <NavLink key={`${item.href}-${item.title}`} href={item.href} title={item.title} />
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
            <MobileNav publicItems={publicItems} />
          </div>
        </div>
      </Container>
    </header>
  );
}
