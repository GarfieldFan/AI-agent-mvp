"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Lock, Plus, RotateCcw, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import type { NavItem } from "@/config/nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getDefaultNavItems, getNavMenu, MAX_MENU_ITEMS, updateNavMenu } from "@/lib/nav-menu";
import { listPages } from "@/lib/pages";

/** Saved-page slug → the public URL it renders at (same convention
 * app/page.tsx / app/about/page.tsx / app/p/[slug] follow). */
function hrefForSlug(slug: string): string {
  if (slug === "home") return "/";
  if (slug === "about") return "/about";
  return `/p/${encodeURIComponent(slug)}`;
}

function titleForSlug(slug: string): string {
  if (slug === "home") return "Home";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Mirrors backend/apis/nav_menu.py's NavMenuItem validator — the backend
// is the real check, this just catches mistakes before a round trip.
function hrefError(href: string): string | null {
  const value = href.trim();
  if (!value) return "Link is required.";
  if (value.startsWith("//")) return "Use a full https:// URL for external links.";
  if (/^(\/|#|https?:\/\/|mailto:|tel:)/i.test(value)) return null;
  return "Must start with /, #, https://, mailto: or tel:";
}

/** Link presets that aren't saved pages — the chat bubble (system-level,
 * opened via "#chat", see ChatBubbleWidget) and the product search page. */
const PRESET_LINKS: NavItem[] = [
  { title: "Products", href: "/search" },
  { title: "Chat with us", href: "#chat" },
];

type Row = NavItem & { key: string };

type LoadedMenu = { items: NavItem[]; isDefault: boolean };

/** The saved menu, or the built-in default when none has been saved. */
async function fetchMenu(): Promise<LoadedMenu> {
  const saved = await getNavMenu();
  return { items: saved ?? (await getDefaultNavItems()), isDefault: saved === null };
}

const withKey = (item: NavItem): Row => ({ ...item, key: crypto.randomUUID() });

/** /editor's "Menu" tab — the WordPress "Menus" equivalent for the public
 * header/footer nav (lib/nav-menu.ts). Admin links (Page Editor,
 * Dashboard) are never part of this — they live in AdminBar. Until a menu
 * is saved, the site uses the built-in default (Home + About once
 * saved); this editor starts from that default so saving it unchanged is
 * a no-op visually. */
export function NavMenuPanel() {
  const { role } = useAuth();
  const canEdit = role === "admin" || role === "owner";

  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [isDefault, setIsDefault] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [pageSlugs, setPageSlugs] = React.useState<string[]>([]);
  const [pagePick, setPagePick] = React.useState<string | null>(null);

  const applyLoaded = React.useCallback((loaded: LoadedMenu) => {
    setRows(loaded.items.map(withKey));
    setIsDefault(loaded.isDefault);
    setDirty(false);
    setLoadError(null);
  }, []);

  const handleLoadError = React.useCallback((err: unknown) => {
    setLoadError(err instanceof ApiError ? err.message : "Failed to load the menu.");
  }, []);

  // setState only inside .then/.catch callbacks — calling a setState-ing
  // function directly from the effect body trips
  // react-hooks/set-state-in-effect.
  React.useEffect(() => {
    if (!canEdit) return;
    fetchMenu().then(applyLoaded).catch(handleLoadError);
    listPages({ limit: 100 })
      .then((result) => setPageSlugs(result.items.map((page) => page.slug)))
      .catch(() => setPageSlugs([]));
  }, [canEdit, applyLoaded, handleLoadError]);

  function retryLoad() {
    setLoadError(null);
    fetchMenu().then(applyLoaded).catch(handleLoadError);
  }

  function change(next: Row[]) {
    setRows(next);
    setDirty(true);
    setSaveStatus("idle");
  }

  function addItem(item: NavItem) {
    if (!rows || rows.length >= MAX_MENU_ITEMS) return;
    change([...rows, withKey(item)]);
  }

  function updateRow(key: string, patch: Partial<NavItem>) {
    if (!rows) return;
    change(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function moveRow(index: number, direction: -1 | 1) {
    if (!rows) return;
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    change(next);
  }

  function removeRow(key: string) {
    if (!rows) return;
    change(rows.filter((row) => row.key !== key));
  }

  const invalid = rows?.some((row) => !row.title.trim() || hrefError(row.href)) ?? false;

  async function save(items: NavItem[] | null) {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const saved = await updateNavMenu(items);
      applyLoaded({ items: saved ?? (await getDefaultNavItems()), isDefault: saved === null });
      setSaveStatus("saved");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  if (!canEdit) {
    return (
      <EmptyState
        icon={Lock}
        title="Admin/owner access required"
        description="Log in as an admin or owner account (see /login) to manage the site menu."
      />
    );
  }

  if (loadError) return <ErrorMessage description={loadError} onRetry={retryLoad} />;
  if (!rows) return <LoadingSpinner label="Loading menu…" />;

  const full = rows.length >= MAX_MENU_ITEMS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Site menu</h2>
            <Badge variant={isDefault ? "outline" : "default"}>{isDefault ? "Default" : "Customized"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            The links visitors see in the site header and footer. Admin links (Dashboard, Page Editor) are never
            shown here — they only appear in the admin bar for signed-in admins and owners.
          </p>
        </div>
      </div>

      <ul className="divide-y rounded-xl border">
        {rows.length === 0 ? (
          <li className="p-4 text-sm text-muted-foreground">
            No links — visitors will see an empty menu. Add one below, or reset to the default.
          </li>
        ) : null}
        {rows.map((row, index) => {
          const error = hrefError(row.href);
          return (
            <li key={row.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`menu-title-${row.key}`} className="text-xs text-muted-foreground">
                    Label
                  </Label>
                  <Input
                    id={`menu-title-${row.key}`}
                    value={row.title}
                    maxLength={60}
                    onChange={(event) => updateRow(row.key, { title: event.target.value })}
                    aria-invalid={!row.title.trim()}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`menu-href-${row.key}`} className="text-xs text-muted-foreground">
                    Link
                  </Label>
                  <Input
                    id={`menu-href-${row.key}`}
                    value={row.href}
                    maxLength={500}
                    onChange={(event) => updateRow(row.key, { href: event.target.value })}
                    aria-invalid={Boolean(error)}
                    placeholder="/p/your-page or https://…"
                  />
                  {error ? <p className="text-xs text-destructive">{error}</p> : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-1 sm:pt-5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move up"
                  onClick={() => moveRow(index, -1)}
                  disabled={index === 0}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  onClick={() => moveRow(index, 1)}
                  disabled={index === rows.length - 1}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => removeRow(row.key)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="space-y-3 rounded-xl border border-dashed p-4">
        <p className="text-sm font-medium">Add a link</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 space-y-1">
            <Label className="text-xs text-muted-foreground">Saved page</Label>
            <Select value={pagePick} onValueChange={(value) => setPagePick(value as string | null)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={pageSlugs.length ? "Pick a page" : "No saved pages yet"} />
              </SelectTrigger>
              <SelectContent>
                {pageSlugs.map((slug) => (
                  <SelectItem key={slug} value={slug}>
                    {slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={!pagePick || full}
            onClick={() => {
              if (!pagePick) return;
              addItem({ title: titleForSlug(pagePick), href: hrefForSlug(pagePick) });
              setPagePick(null);
            }}
          >
            <Plus className="size-4" />
            Add page
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_LINKS.map((preset) => (
            <Button key={preset.href} variant="secondary" size="sm" disabled={full} onClick={() => addItem(preset)}>
              <Plus className="size-3.5" />
              {preset.title}
            </Button>
          ))}
          <Button variant="secondary" size="sm" disabled={full} onClick={() => addItem({ title: "New link", href: "/" })}>
            <Plus className="size-3.5" />
            Custom link
          </Button>
        </div>
        {full ? <p className="text-xs text-muted-foreground">A menu can have at most {MAX_MENU_ITEMS} links.</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => save(rows.map(({ title, href }) => ({ title: title.trim(), href: href.trim() })))}
          disabled={!dirty || invalid || saveStatus === "saving"}
        >
          <Save className="size-4" />
          {saveStatus === "saving" ? "Saving…" : "Save menu"}
        </Button>
        <Button variant="outline" onClick={() => save(null)} disabled={isDefault || saveStatus === "saving"}>
          <RotateCcw className="size-4" />
          Reset to default
        </Button>
        {saveStatus === "saved" ? <span className="text-sm text-muted-foreground">Saved — live on the site now.</span> : null}
        {dirty && saveStatus !== "saving" ? <span className="text-sm text-muted-foreground">Unsaved changes</span> : null}
      </div>
      {saveStatus === "error" && saveError ? <ErrorMessage description={saveError} /> : null}
    </div>
  );
}
