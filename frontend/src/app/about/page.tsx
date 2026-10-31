import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SectionRenderer } from "@/components/theme/section-renderer";
import { extractPageSummary } from "@/lib/theme";
import { getPublicPage } from "@/lib/pages";

const FALLBACK_TITLE = "About";

// No built-in About content — this route only exists once an admin/owner
// has saved an "about" page (PageGeneratorPanel's save form, or
// PageManager's "New blank page" + /editor). Until then it 404s, and
// "About" stays out of the public nav (config/nav.ts's buildPublicNav).
export async function generateMetadata(): Promise<Metadata> {
  const saved = await getPublicPage("about");
  if (!saved) return { title: FALLBACK_TITLE };

  const { title, description } = extractPageSummary(saved.sections);
  const trimmed = description ? description.slice(0, 200) : undefined;

  return {
    title: title || FALLBACK_TITLE,
    description: trimmed,
    openGraph: { title: title || FALLBACK_TITLE, description: trimmed },
  };
}

// Same reasoning as app/page.tsx: fetch fresh on every request so a saved
// "about" version shows up immediately, no rebuild needed.
export const dynamic = "force-dynamic";

export default async function AboutPage() {
  const saved = await getPublicPage("about");
  if (!saved) notFound();

  return <SectionRenderer sections={saved.sections} accentColor={saved.accent_color} />;
}
