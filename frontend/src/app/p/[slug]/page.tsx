import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SectionRenderer } from "@/components/theme/section-renderer";
import { extractPageSummary } from "@/lib/theme";
import { getPublicPage } from "@/lib/pages";

// Same reasoning as app/page.tsx: fetch fresh on every request so a saved
// version shows up immediately, no rebuild needed.
export const dynamic = "force-dynamic";

// 2026-09-08 — closes a real GEO gap: a saved page used to inherit only
// the site-wide default title/description from the root layout, never
// naming the specific page's own content. See lib/theme.ts's
// extractPageSummary and the root AGENTS.md's GEO/business-profile
// section. Falls back to {} (root layout's own default) when the page
// doesn't exist or has no extractable heading/body text.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublicPage(slug);
  if (!page) return {};

  const { title, description } = extractPageSummary(page.sections);
  const trimmed = description ? description.slice(0, 200) : undefined;

  return {
    ...(title ? { title } : {}),
    ...(trimmed ? { description: trimmed } : {}),
    openGraph: {
      ...(title ? { title } : {}),
      ...(trimmed ? { description: trimmed } : {}),
    },
  };
}

export default async function GeneratedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await getPublicPage(slug);

  if (!page) {
    notFound();
  }

  return <SectionRenderer sections={page.sections} accentColor={page.accent_color} />;
}
