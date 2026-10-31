import type { MetadataRoute } from "next";

import { listPublicPages, pageHrefForSlug } from "@/lib/pages";
import { listPublicProducts } from "@/lib/products";

/** Enumerates every publicly-reachable content URL on the site
 * (2026-08-21) — closes the other half of "AI/search crawlers can find
 * everything" alongside robots.ts, see the root AGENTS.md. Runs
 * server-side (this is a Next.js Metadata Route file, not a page), so
 * `listPublicPages()`/`listPublicProducts()` resolve through
 * `INTERNAL_API_URL` automatically (lib/api.ts). Best-effort: if either
 * fetch fails (backend briefly unreachable at build/request time), that
 * section is just omitted rather than failing the whole sitemap — `/` is
 * always included regardless (it always resolves to a saved page or the
 * system default landing page, see app/page.tsx). `/about` is only listed
 * once an "about" page has actually been saved — there's no default one
 * anymore, so it 404s until then. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const entries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 },
  ];

  try {
    const pages = await listPublicPages();
    for (const page of pages) {
      // "home" is already the root entry above.
      if (page.slug === "home") continue;
      entries.push({
        url: `${siteUrl}${pageHrefForSlug(page.slug)}`,
        lastModified: page.updated_at,
        changeFrequency: "monthly",
        priority: page.slug === "about" ? 0.6 : 0.5,
      });
    }
  } catch {
    // Best-effort — see this file's own doc comment.
  }

  try {
    const products = await listPublicProducts();
    for (const product of products) {
      entries.push({
        url: `${siteUrl}/products/${product.id}`,
        changeFrequency: "weekly",
        priority: 0.7,
      });
    }
  } catch {
    // Best-effort — see this file's own doc comment.
  }

  return entries;
}
