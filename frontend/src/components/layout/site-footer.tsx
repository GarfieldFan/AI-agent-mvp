import Link from "next/link";

import { Container } from "@/components/layout/container";
import { resolvePublicNavItems } from "@/lib/nav-menu";

/** Public nav only — admin links never appear in the footer sitemap, even
 * for a logged-in admin (they live in the header). */
export async function SiteFooter() {
  const publicItems = await resolvePublicNavItems();

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
          {publicItems.map((item) => (
            <Link
              key={`${item.href}-${item.title}`}
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
