/** Plain, serializable nav entry — crosses the Server → Client Component
 * boundary (SiteHeader → NavLink/MobileNav), so no component refs. The
 * backend's stored menu uses {label, href} — lib/nav-menu.ts maps it. */
export type NavItem = {
  title: string;
  href: string;
};

/** Public, visitor-facing navigation — what every visitor sees, logged in
 * or not, until an admin/owner saves their own menu (/editor → Menu, see
 * lib/nav-menu.ts) — this is only the built-in default. Deliberately
 * minimal, WordPress-default-theme style: just Home, plus "About" once an
 * "about" page is saved (`buildPublicNav`). The chatbot
 * is never a nav entry — it's system-level, always available via the
 * floating ChatBubbleWidget mounted in the root layout. */
export const basePublicNav: NavItem[] = [{ title: "Home", href: "/" }];

/** Mirrored by hand in backend/apis/nav_menu.py's get_nav_menu_overview
 * (owner-agent's get_site_menu) — change both together.
 *
 * Public nav for this request: the fixed base entries plus whichever
 * owner-created pages exist. Takes already-resolved facts, not a fetch,
 * so SiteHeader/SiteFooter decide once how to look them up. */
export function buildPublicNav({ hasAboutPage }: { hasAboutPage: boolean }): NavItem[] {
  return hasAboutPage ? [...basePublicNav, { title: "About", href: "/about" }] : basePublicNav;
}
