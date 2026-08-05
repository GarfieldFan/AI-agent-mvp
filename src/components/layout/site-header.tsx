import Link from "next/link";
import { Sparkles } from "lucide-react";

import { Container } from "@/components/layout/container";
import { NavLink } from "@/components/layout/nav-link";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ModeToggle } from "@/components/mode-toggle";
import { AuthStatus } from "@/components/common/auth-status";
import { primaryNav } from "@/config/nav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60">
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
