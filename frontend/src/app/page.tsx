import { SectionRenderer } from "@/components/theme/section-renderer";
import { DEFAULT_HOME_SECTIONS } from "@/config/default-theme";
import { getPublicPage } from "@/lib/pages";

// Fetches fresh on every request rather than being statically generated
// at build time — the whole point of the "home" slug is that saving a
// new version through the admin generator should show up without a
// rebuild/redeploy. See lib/pages.ts's getPublicPage for the fallback
// behavior (null on 404, not an exception).
export const dynamic = "force-dynamic";

export default async function Home() {
  const saved = await getPublicPage("home");

  if (saved) {
    return <SectionRenderer sections={saved.sections} accentColor={saved.accent_color} />;
  }

  return <SectionRenderer sections={DEFAULT_HOME_SECTIONS} />;
}
