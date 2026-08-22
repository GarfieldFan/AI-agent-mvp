import { buildSiteJsonLd, getPublicBusinessProfile } from "@/lib/business-profile";

/** Server Component, mounted once in the root layout — renders this
 * site's schema.org JSON-LD `<script>` on every page. Was
 * `BusinessProfileJsonLd` (2026-08-21), broadened the same day to
 * `buildSiteJsonLd`: always includes a `WebSite` node (site identity +
 * SearchAction, giving `/search` sitelinks-search-box eligibility) even
 * before any business profile exists, plus a `LocalBusiness` node once
 * one is configured — see lib/business-profile.ts's `buildSiteJsonLd`
 * doc comment for the full design. This is the structured-data half of
 * this app's GEO push; app/robots.ts/sitemap.ts are the crawlability
 * half — see the root AGENTS.md for the full design. Fetch failures are
 * swallowed (falls back to a WebSite-only block built from an empty
 * profile) — a business-profile outage should never take down page
 * rendering site-wide. */
export async function SiteJsonLd() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const emptyProfile = {
    business_name: null,
    business_description: null,
    business_type: null,
    business_email: null,
    business_phone: null,
    business_street_address: null,
    business_locality: null,
    business_region: null,
    business_postal_code: null,
    business_country: null,
    business_url: null,
    business_logo_url: null,
    business_hours: [],
    business_social_links: [],
  };

  let jsonLd: Record<string, unknown>;
  try {
    const profile = await getPublicBusinessProfile();
    jsonLd = buildSiteJsonLd(profile, siteUrl);
  } catch {
    jsonLd = buildSiteJsonLd(emptyProfile, siteUrl);
  }

  // Standard Next.js App Router pattern for JSON-LD — there's no
  // dedicated Metadata API field for arbitrary structured data. jsonLd is
  // built entirely from owner-entered BusinessProfile fields plus this
  // site's own known URL (JSON.stringify of a plain data object), never
  // from unsanitized third-party HTML.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />;
}
