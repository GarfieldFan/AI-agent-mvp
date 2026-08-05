import type { Metadata } from "next";

import { SectionRenderer } from "@/components/theme/section-renderer";
import { DEFAULT_ABOUT_SECTIONS } from "@/config/default-theme";
import { getPublicPage } from "@/lib/pages";

export const metadata: Metadata = {
  title: "About",
  description: "Project background, target roles, and technology choices.",
};

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
