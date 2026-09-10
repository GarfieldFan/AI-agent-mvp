import Link from "next/link";

import { Container } from "@/components/layout/container";
import { primaryNav } from "@/config/nav";

export function SiteFooter() {
  return (
    <footer className="border-t">
      <Container className="flex flex-col gap-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-semibold">AI MVP</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            An AI-native small-business platform: RAG-grounded chat, agent
            tooling, and an agent-permission security layer running on a
            self-hosted stack.
          </p>
        </div>

        <nav className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-1">
          {primaryNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.title}
            </Link>
          ))}
        </nav>
      </Container>
      <Container className="border-t py-4 text-xs text-muted-foreground">
        © {new Date().getFullYear()} AI MVP. Built with Next.js, FastAPI, and
        a local-first AI stack.
      </Container>
    </footer>
  );
}
