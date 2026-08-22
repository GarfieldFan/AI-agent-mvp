import type { MetadataRoute } from "next";

/** Deliberately explicit about AI crawlers, not just a bare `*: allow`
 * (2026-08-21) — the whole point of this app's GEO push (see the root
 * AGENTS.md's business-profile/JSON-LD section) is being readable by AI
 * answer engines, not just traditional search. A bare `Allow: /` for `*`
 * already covers every crawler including these by default, but naming
 * them explicitly makes the intent unambiguous to a human reading this
 * file and future-proofs against any of these vendors ever defaulting to
 * a stricter posture for unlisted-but-not-explicitly-allowed agents.
 * `/dashboard`/`/editor`/`/login`/`/checkout`/`/cart` are owner-only or
 * per-visitor pages with no SEO/GEO value — disallowed so crawl budget
 * goes toward the actually-public content. */
export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const disallow = ["/dashboard", "/editor", "/login", "/checkout", "/cart"];

  const aiCrawlers = [
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "ClaudeBot",
    "anthropic-ai",
    "Claude-Web",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "Bytespider",
  ];

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      ...aiCrawlers.map((userAgent) => ({ userAgent, allow: "/", disallow })),
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
