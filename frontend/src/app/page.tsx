import { SectionRenderer } from "@/components/theme/section-renderer";
import { DefaultHomeAdminNotice } from "@/components/modules/default-home-admin-notice";
import { buildDefaultHomeSections } from "@/config/default-theme";
import { getPublicBusinessProfile } from "@/lib/business-profile";
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

  // No saved "home" page — render the system's default landing page
  // (config/default-theme.ts), personalized with the business profile if
  // one exists. A profile-fetch failure just means the generic copy.
  const profile = await getPublicBusinessProfile().catch(() => undefined);
  return (
    <>
      <DefaultHomeAdminNotice />
      <SectionRenderer sections={buildDefaultHomeSections(profile)} />
    </>
  );
}
