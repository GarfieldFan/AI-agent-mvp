import { apiFetch } from "@/lib/api";
import { getPublicPage } from "@/lib/pages";
import { buildPublicNav, type NavItem } from "@/config/nav";

/** backend/apis/nav_menu.py — the owner-editable public menu (WordPress
 * "Menus" equivalent), managed from /editor's Menu tab. `items: null`
 * means never configured: callers fall back to the built-in default. The
 * wire format is {label, href}; this file maps it to NavItem's {title}. */
type WireMenu = { items: { label: string; href: string }[] | null };

export const MAX_MENU_ITEMS = 20;

function fromWire(menu: WireMenu): NavItem[] | null {
  return menu.items ? menu.items.map((item) => ({ title: item.label, href: item.href })) : null;
}

/** Admin/owner. `null` = never configured (built-in default in effect). */
export async function getNavMenu(): Promise<NavItem[] | null> {
  return fromWire(await apiFetch<WireMenu>("/api/agent/nav-menu"));
}

/** `null` resets to the built-in default; `[]` means no public links. */
export async function updateNavMenu(items: NavItem[] | null): Promise<NavItem[] | null> {
  const body = { items: items ? items.map((item) => ({ label: item.title, href: item.href })) : null };
  return fromWire(await apiFetch<WireMenu>("/api/agent/nav-menu", { method: "PUT", body }));
}

/** Public, no-auth. */
export async function getPublicNavMenu(): Promise<NavItem[] | null> {
  return fromWire(await apiFetch<WireMenu>("/api/nav-menu"));
}

/** The built-in default menu: Home, plus About once an "about" page is
 * saved. Also what the Menu editor starts from before anything's saved. */
export async function getDefaultNavItems(): Promise<NavItem[]> {
  return buildPublicNav({ hasAboutPage: Boolean(await getPublicPage("about")) });
}

/** Server-side: the public nav for this request — the owner's saved menu
 * if one exists, otherwise the built-in default. Never throws: a backend
 * hiccup degrades to the default rather than breaking every page. */
export async function resolvePublicNavItems(): Promise<NavItem[]> {
  try {
    const items = await getPublicNavMenu();
    if (items) return items;
  } catch {
    // fall through to the default
  }
  return getDefaultNavItems();
}
