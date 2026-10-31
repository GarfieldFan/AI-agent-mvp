"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CteEditorPanel } from "@/components/modules/cte-editor-panel";
import { NavMenuPanel } from "@/components/modules/nav-menu-panel";

export type EditorTab = "pages" | "menu";

/** /editor's two site-building tools: click-to-edit page content, and
 * the public site menu. Kept here rather than in /dashboard so the
 * dashboard stays focused on operations.
 *
 * **Controlled by the URL's `?tab=`**, not an uncontrolled default — a
 * real bug: navigating between `/editor` and `/editor?tab=menu` is the
 * same route, so the component never remounts and an uncontrolled
 * `defaultValue` just ignored the change (a link there looked dead). Clicking a
 * tab writes back to the URL so both stay in sync. Both panels stay
 * mounted (TabsContent keeps them), so switching tabs never loses
 * unsaved edits in either. */
export function EditorTabs({ initialSlug }: { initialSlug?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: EditorTab = searchParams.get("tab") === "menu" ? "menu" : "pages";

  function handleTabChange(next: unknown) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "menu") params.set("tab", "menu");
    else params.delete("tab");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="pages">Pages</TabsTrigger>
        <TabsTrigger value="menu">Menu</TabsTrigger>
      </TabsList>
      <TabsContent value="pages" keepMounted className="pt-4">
        <CteEditorPanel initialSlug={initialSlug} />
      </TabsContent>
      <TabsContent value="menu" keepMounted className="pt-4">
        <NavMenuPanel />
      </TabsContent>
    </Tabs>
  );
}
