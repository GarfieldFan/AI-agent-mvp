import type { Metadata } from "next";

import { SectionRenderer } from "@/components/theme/section-renderer";
import { DEFAULT_ABOUT_SECTIONS } from "@/config/default-theme";
import { extractPageSummary } from "@/lib/theme";
import { getPublicPage } from "@/lib/pages";

const FALLBACK_TITLE = "About";
const FALLBACK_DESCRIPTION = "Project background and technology choices.";

// 2026-09-08 — was a static `export const metadata` with hardcoded
// placeholder copy; now reflects the actual saved "about" content
// once the owner has customized it (same extractPageSummary this app's
// other content pages use), falling back to the original static copy
// for an unconfigured/default install. See the root AGENTS.md's GEO/
// business-profile section.
export async function generateMetadata(): Promise<Metadata> {
  const saved = await getPublicPage("about");
  const { title, description } = extractPageSummary(saved?.sections ?? DEFAULT_ABOUT_SECTIONS);
  const trimmed = description ? description.slice(0, 200) : undefined;

  return {
    title: title || FALLBACK_TITLE,
    description: trimmed || FALLBACK_DESCRIPTION,
    openGraph: {
      title: title || FALLBACK_TITLE,
      description: trimmed || FALLBACK_DESCRIPTION,
    },
  };
}

// Same reasoning as app/page.tsx: fetch fresh on every request so a saved
// "about" version shows up immediately, no rebuild needed. Falls back to
// DEFAULT_ABOUT_SECTIONS (never a blank page) until one's been saved.
export const dynamic = "force-dynamic";

export default async function AboutPage() {
  const saved = await getPublicPage("about");

  if (saved) {
    return <SectionRenderer sections={saved.sections} accentColor={saved.accent_color} />;
  }

  return <SectionRenderer sections={DEFAULT_ABOUT_SECTIONS} />;
}
