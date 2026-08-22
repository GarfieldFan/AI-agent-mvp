import type { MetadataRoute } from "next";

import { listPublicPages } from "@/lib/pages";
import { listPublicProducts } from "@/lib/products";

/** Enumerates every publicly-reachable content URL on the site
 * (2026-08-21) — closes the other half of "AI/search crawlers can find
 * everything" alongside robots.ts, see the root AGENTS.md. Runs
 * server-side (this is a Next.js Metadata Route file, not a page), so
 * `listPublicPages()`/`listPublicProducts()` resolve through
 * `INTERNAL_API_URL` automatically (lib/api.ts). Best-effort: if either
 * fetch fails (backend briefly unreachable at build/request time), that
 * section is just omitted rather than failing the whole sitemap —
 * `/`/`/about` are always included regardless, since those two routes
 * always resolve to *something* (a saved page or the hand-authored
 * default template, see app/page.tsx/app/about/page.tsx). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const entries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/about`, changeFrequency: "monthly", priority: 0.6 },
  ];

  try {
    const pages = await listPublicPages();
    for (const page of pages) {
      // "home"/"about" already map to the two fixed routes above — see
      // app/page.tsx/app/about/page.tsx's own slug convention. Every
      // other slug renders at /p/[slug].
      if (page.slug === "home" || page.slug === "about") continue;
      entries.push({
        url: `${siteUrl}/p/${encodeURIComponent(page.slug)}`,
        lastModified: page.updated_at,
        changeFrequency: "monthly",
        priority: 0.5,
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
