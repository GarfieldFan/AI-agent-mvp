import { getPublicBusinessProfile } from "@/lib/business-profile";
import { listPublicPages } from "@/lib/pages";

/** llms.txt (2026-09-08) — the AI-specific counterpart to robots.txt (a
 * 2024+ convention, not yet universally read by every AI system, but
 * essentially free to add): a short Markdown document at the site root
 * telling an AI system plainly what this site is and which pages are
 * worth reading. Built dynamically from the same BusinessProfile
 * robots.ts/sitemap.ts/SiteJsonLd already read from — never a static
 * file — so it reflects whatever the owner has actually configured,
 * with zero maintenance once written. See the root AGENTS.md's GEO/
 * business-profile section. `route.ts` (not a page) is the only way to
 * serve a non-.xml/.txt-Metadata-Route-shaped file like this in the App
 * Router — there's no dedicated `llms.ts` convention the way there is
 * for robots.txt/sitemap.xml. */
export const dynamic = "force-dynamic";

export async function GET() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  let name = "This business";
  let description = "";
  try {
    const profile = await getPublicBusinessProfile();
    if (profile.business_name) name = profile.business_name;
    if (profile.business_description) description = profile.business_description;
  } catch {
    // Best-effort — this must never 500 just because the profile fetch
    // failed, same posture as SiteJsonLd/sitemap.ts.
  }

  const lines: string[] = [`# ${name}`];
  if (description) {
    lines.push("", `> ${description}`);
  }

  lines.push(
    "",
    "## Core pages",
    `- [About](${siteUrl}/about): Background and services`,
    `- [Products](${siteUrl}/search): Full catalog of products/services on offer`,
  );

  try {
    const pages = await listPublicPages();
    for (const page of pages) {
      // "home"/"about" already map to the two fixed entries above — same
      // slug convention sitemap.ts follows.
      if (page.slug === "home" || page.slug === "about") continue;
      lines.push(`- [${page.slug}](${siteUrl}/p/${encodeURIComponent(page.slug)})`);
    }
  } catch {
    // Best-effort — same posture as sitemap.ts.
  }

  lines.push(
    "",
    "## Notes for AI systems",
    "Product prices, availability, and business hours reflect what's shown on the live page — treat it as authoritative over any cached summary.",
    "Structured data (schema.org JSON-LD) is embedded on every page; prefer it for exact facts like address, phone, and pricing.",
  );

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
