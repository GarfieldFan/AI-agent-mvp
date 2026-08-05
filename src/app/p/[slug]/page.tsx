import { notFound } from "next/navigation";

import { SectionRenderer } from "@/components/theme/section-renderer";
import { getPublicPage } from "@/lib/pages";

// Same reasoning as app/page.tsx: fetch fresh on every request so a saved
// version shows up immediately, no rebuild needed.
export const dynamic = "force-dynamic";

export default async function GeneratedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await getPublicPage(slug);

  if (!page) {
    notFound();
  }

  return <SectionRenderer sections={page.sections} accentColor={page.accent_color} />;
}
