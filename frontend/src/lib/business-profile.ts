import { apiFetch } from "@/lib/api";

/** The structured "who/where/how to reach us" facts this app publishes as
 * schema.org LocalBusiness JSON-LD (2026-08-21, backend/apis/
 * business_profile.py) — see the root AGENTS.md's "Map embed gate"-
 * adjacent "GEO/business profile" section for the full design. No
 * secrets here, unlike payments.ts/notifications.ts/maps.ts — every
 * field is meant to be publicly crawlable. */
export type BusinessProfile = {
  business_name: string | null;
  business_description: string | null;
  business_type: string | null;
  business_email: string | null;
  business_phone: string | null;
  business_street_address: string | null;
  business_locality: string | null;
  business_region: string | null;
  business_postal_code: string | null;
  business_country: string | null;
  business_url: string | null;
  business_logo_url: string | null;
  business_hours: string[];
  business_social_links: string[];
};

export type BusinessProfileInput = Omit<BusinessProfile, "business_url"> & {
  business_url?: string | null;
};

export function getBusinessProfile() {
  return apiFetch<BusinessProfile>("/api/agent/business-profile");
}

export function updateBusinessProfile(input: BusinessProfileInput) {
  return apiFetch<BusinessProfile>("/api/agent/business-profile", { method: "PUT", body: input });
}

export type SuggestBusinessProfileResult = {
  suggestion: BusinessProfile;
  document_count: number;
};

/** LLM-drafted values from ingested RAG documents — never saves anything
 * itself (mirrors lib/intent-schemas.ts's propose-then-owner-applies
 * pattern). BusinessProfilePanel pre-fills its form from the result; the
 * owner still has to review and click Save. */
export function suggestBusinessProfile() {
  return apiFetch<SuggestBusinessProfileResult>("/api/agent/business-profile/suggest", { method: "POST" });
}

/** Public, no-auth — what the frontend's own JSON-LD injection and
 * sitemap/metadata generation call server-side. Same shape as
 * getBusinessProfile() above, just no admin token needed. */
export function getPublicBusinessProfile() {
  return apiFetch<BusinessProfile>("/api/business-profile");
}

/** Builds a schema.org LocalBusiness JSON-LD object from a BusinessProfile
 * — pure formatting, no network I/O, so it's usable from both a Server
 * Component (root layout) and, if ever needed, client-side. Returns null
 * when there's not even a business_name to anchor the entity on — an
 * empty/near-empty JSON-LD block would be worse than none at all (a
 * "LocalBusiness" with no name is not a fact worth publishing).
 *
 * `siteUrl` is the caller's own resolved absolute origin (NEXT_PUBLIC_SITE_URL
 * or per-request), used as a fallback for "url"/"@id" when the profile's
 * own business_url is unset — the backend already applies the equivalent
 * FRONTEND_PUBLIC_URL fallback server-side, this is a second, harmless
 * belt-and-suspenders fallback for whatever reaches this function. */
export function buildLocalBusinessJsonLd(profile: BusinessProfile, siteUrl: string): Record<string, unknown> | null {
  if (!profile.business_name) return null;

  const url = profile.business_url || siteUrl;
  const address =
    profile.business_street_address || profile.business_locality || profile.business_region
      ? {
          "@type": "PostalAddress",
          ...(profile.business_street_address ? { streetAddress: profile.business_street_address } : {}),
          ...(profile.business_locality ? { addressLocality: profile.business_locality } : {}),
          ...(profile.business_region ? { addressRegion: profile.business_region } : {}),
          ...(profile.business_postal_code ? { postalCode: profile.business_postal_code } : {}),
          ...(profile.business_country ? { addressCountry: profile.business_country } : {}),
        }
      : undefined;

  return {
    "@context": "https://schema.org",
    "@type": profile.business_type || "LocalBusiness",
    name: profile.business_name,
    ...(profile.business_description ? { description: profile.business_description } : {}),
    url,
    "@id": url,
    ...(profile.business_email ? { email: profile.business_email } : {}),
    ...(profile.business_phone ? { telephone: profile.business_phone } : {}),
    ...(address ? { address } : {}),
    ...(profile.business_logo_url ? { image: profile.business_logo_url, logo: profile.business_logo_url } : {}),
    ...(profile.business_hours.length > 0 ? { openingHours: profile.business_hours } : {}),
    ...(profile.business_social_links.length > 0 ? { sameAs: profile.business_social_links } : {}),
  };
}

/** Builds the full site-wide JSON-LD graph (2026-08-21) — always includes
 * a `WebSite` node (site identity + a `SearchAction` pointing at this
 * app's real `/search` route, the structured-data hook Google uses to
 * decide whether to offer a sitelinks search box) plus a `LocalBusiness`
 * node once a business profile is configured, linked via `publisher`.
 * Unlike `buildLocalBusinessJsonLd` alone, this never returns null — the
 * WebSite half has real value (search-box eligibility, site identity for
 * an AI/search crawler) even before any business-profile fact exists,
 * so it's worth publishing from day one, not gated on GEO setup being
 * finished. `SiteJsonLd` (components/layout/site-json-ld.tsx) is the
 * only real caller. */
export function buildSiteJsonLd(profile: BusinessProfile, siteUrl: string): Record<string, unknown> {
  const website: Record<string, unknown> = {
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    url: siteUrl,
    name: profile.business_name || "Site",
    potentialAction: {
      "@type": "SearchAction",
      target: `${siteUrl}/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };

  const business = buildLocalBusinessJsonLd(profile, siteUrl);
  if (!business) {
    return { "@context": "https://schema.org", "@graph": [website] };
  }

  // @graph entries share the top-level "@context" — each node's own
  // isn't repeated inside the array (schema.org/Google's own examples
  // never nest @context inside @graph items).
  const businessNode = { ...business };
  delete businessNode["@context"];
  return {
    "@context": "https://schema.org",
    "@graph": [
      { ...businessNode, "@id": `${siteUrl}/#business` },
      { ...website, publisher: { "@id": `${siteUrl}/#business` } },
    ],
  };
}
