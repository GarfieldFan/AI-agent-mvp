"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Lock, Pencil, RotateCcw, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { CteEditorPopover } from "@/components/theme/cte/cte-editor-popover";
import { CteProvider } from "@/components/theme/cte/cte-context";
import { InsertGap } from "@/components/theme/cte/insert-gap";
import { SectionInsertMenu } from "@/components/theme/cte/section-insert-menu";
import { SectionRenderer } from "@/components/theme/section-renderer";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { appendByPath, insertByPath, moveByPath, removeByPath, setByPath, type CteSelection } from "@/lib/cte";
import { getPublicPage, listPages, savePageVersion, type PageSummary } from "@/lib/pages";
import { slugify } from "@/lib/slug";
import type { GeneratedPage, PageSection } from "@/lib/theme";

/** The real `/editor` UI (replaced the GrapesJS-shaped placeholder,
 * 2026-08-04 — see the root AGENTS.md's CTE section for why GrapesJS
 * itself was traded away for a lightweight, schema-native editor instead).
 *
 * Deliberately edits *existing* saved content only — there's no "start
 * from a blank page" path here, matching "click an element to edit it":
 * generating new content is PageGeneratorPanel's job (/dashboard), this
 * panel's job is fixing up what's already published. Reuses the exact
 * same SectionRenderer every public route renders through, wrapped in a
 * CteProvider (components/theme/cte/) so what you see here is pixel-
 * identical to production, not a separate editor-only preview. */
export function CteEditorPanel() {
  const { role } = useAuth();
  const canEdit = role === "admin" || role === "owner";

  const [pages, setPages] = React.useState<PageSummary[]>([]);
  const [slugInput, setSlugInput] = React.useState("home");
  const [loadedSlug, setLoadedSlug] = React.useState<string | null>(null);
  const [sections, setSections] = React.useState<PageSection[] | null>(null);
  const [accentColor, setAccentColor] = React.useState<string | undefined>(undefined);
  const [dirty, setDirty] = React.useState(false);
  const [selection, setSelection] = React.useState<CteSelection | null>(null);
  // Off by default: a freshly-loaded page should look exactly like the
  // live site until you deliberately opt into editing it — see
  // CteProvider's doc comment for why this replaced an always-on model.
  const [editModeOn, setEditModeOn] = React.useState(false);

  const [loadStatus, setLoadStatus] = React.useState<"idle" | "loading" | "empty" | "error">("idle");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!canEdit) return;
    listPages()
      .then(setPages)
      .catch(() => setPages([]));
  }, [canEdit]);

  // Auto-loads the default slug once on mount so the editor shows
  // something immediately instead of requiring a first, easy-to-miss
  // click on "Load" for the common case — see handleLoad below for why a
  // click was needed at all (any slug other than the default still goes
  // through it). `handleLoad` itself does the setState work, but that
  // happens inside its own call frame, not lexically in this effect's
  // body, so it doesn't trip the set-state-in-effect lint rule.
  React.useEffect(() => {
    if (canEdit) handleLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  async function handleLoad() {
    const slug = slugify(slugInput);
    if (!slug) return;
    setSlugInput(slug);
    setLoadStatus("loading");
    setLoadError(null);
    setSelection(null);
    setEditModeOn(false);
    try {
      const page = await getPublicPage(slug);
      if (!page) {
        setLoadStatus("empty");
        setSections(null);
        return;
      }
      setSections(page.sections);
      setAccentColor(page.accent_color);
      setLoadedSlug(slug);
      setDirty(false);
      setNote("");
      setSaveStatus("idle");
      setLoadStatus("idle");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not reach the backend.");
      setLoadStatus("error");
    }
  }

  function handleFieldSave(value: unknown) {
    if (!selection) return;
    setSections((prev) => {
      if (!prev) return prev;
      // "create" (AddItemButton) means `selection.path` is the array
      // itself and this appends; every other selection replaces whatever
      // is already at `selection.path`.
      const updater = selection.mode === "create" ? appendByPath : setByPath;
      return updater(prev, selection.path, value) as PageSection[];
    });
    setDirty(true);
    setSaveStatus("idle");
    // "create" mode is still a single deliberate Add click, so close the
    // sheet the same way it always did. "edit" mode (2026-08-06) now
    // calls this live on every change (CteEditorPopover's effect) while
    // the sheet stays open — closing here would dismiss it after the
    // very first color/size tweak, defeating the point. It only closes
    // when the admin explicitly dismisses it (onCancel, below).
    if (selection.mode === "create") {
      setSelection(null);
    }
  }

  function handleFieldDelete() {
    if (!selection) return;
    setSections((prev) => (prev ? (removeByPath(prev, selection.path) as PageSection[]) : prev));
    setDirty(true);
    setSaveStatus("idle");
    setSelection(null);
  }

  // Section-level move/delete — added 2026-08-06 at the user's request,
  // matching PageGeneratorPanel's preview (see its LockableSectionPreview)
  // but without that panel's animation/stable-id machinery: this preview
  // already re-renders through the real SectionRenderer per section (see
  // below, via `startIndex`), and a plain index swap/filter is enough —
  // no separate "which section is this" tracking needed since edits here
  // always go straight into `sections`, there's no regenerate-merge step
  // to preserve identity across like PageGeneratorPanel has.
  function handleMoveSection(index: number, direction: -1 | 1) {
    setSections((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
    setSaveStatus("idle");
  }

  function handleDeleteSection(index: number) {
    if (!window.confirm("Remove this section from the page? This only affects the unsaved preview.")) return;
    setSections((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
    setDirty(true);
    setSaveStatus("idle");
  }

  // Section-level insert, 2026-08-06 — the "+" the user asked for, using
  // the same Sheet/picker language as the pencil editor (SectionInsertMenu)
  // instead of a bespoke UI. `insertAt` is the target index in `sections`
  // (0 = before the first section, `sections.length` = after the last) —
  // null means the picker is closed. A plain splice-insert is enough here
  // for the same reason handleMoveSection/handleDeleteSection are plain
  // array ops: there's no regenerate-merge step in this preview that needs
  // stable identity preserved across the edit.
  const [insertAt, setInsertAt] = React.useState<number | null>(null);

  function handleInsertSection(section: PageSection) {
    if (insertAt === null) return;
    const at = insertAt;
    setSections((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next.splice(at, 0, section);
      return next;
    });
    setDirty(true);
    setSaveStatus("idle");
  }

  // Generic, path-based structural editing — 2026-08-06 (CTE part 7),
  // exposed through CteContext (see cte-context.tsx) so any nested
  // renderer (feature-item/cta arrays, ContainerBlock.children at any
  // nesting depth) can move/delete/insert without threading callbacks
  // down as props. Unlike the section-only handlers above (plain index
  // ops on the top-level `sections` state), these go through
  // lib/cte.ts's path-aware moveByPath/removeByPath/insertByPath since
  // the target array can be nested arbitrarily deep.
  function handleMoveItem(itemPath: string, direction: -1 | 1) {
    setSections((prev) => (prev ? (moveByPath(prev, itemPath, direction) as PageSection[]) : prev));
    setDirty(true);
    setSaveStatus("idle");
  }

  function handleRemoveItem(itemPath: string) {
    if (!window.confirm("Remove this item? This only affects the unsaved preview.")) return;
    setSections((prev) => (prev ? (removeByPath(prev, itemPath) as PageSection[]) : prev));
    setDirty(true);
    setSaveStatus("idle");
  }

  function handleInsertAt(arrayPath: string, index: number, value: unknown) {
    setSections((prev) => (prev ? (insertByPath(prev, arrayPath, index, value) as PageSection[]) : prev));
    setDirty(true);
    setSaveStatus("idle");
  }

  async function handleSaveVersion() {
    if (!loadedSlug || !sections) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const content: GeneratedPage = { sections, accent_color: accentColor };
      await savePageVersion(loadedSlug, content, note.trim() || undefined);
      setSaveStatus("saved");
      setDirty(false);
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
        description="Log in as an admin or owner account (see /login) to edit a published page."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border p-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="cte-slug">
            Page slug
          </label>
          <Input
            id="cte-slug"
            list="cte-existing-slugs"
            value={slugInput}
            onChange={(event) => setSlugInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleLoad();
            }}
            placeholder="home, about, summer-promo…"
            className="w-56"
          />
          <datalist id="cte-existing-slugs">
            {pages.map((page) => (
              <option key={page.slug} value={page.slug} />
            ))}
          </datalist>
        </div>
        <Button variant="outline" onClick={handleLoad} disabled={!slugInput.trim() || loadStatus === "loading"}>
          Load
        </Button>
        {loadStatus === "loading" ? <LoadingSpinner label="Loading…" /> : null}
      </div>

      {loadStatus === "empty" ? (
        <EmptyState
          title={`No saved content for "${slugInput.trim()}" yet`}
          description="Generate a page first (Agent console → Page generator on /dashboard) and save it to this slug, then come back here to edit it."
        />
      ) : null}

      {loadStatus === "error" && loadError ? (
        <ErrorMessage description={loadError} onRetry={() => setLoadStatus("idle")} />
      ) : null}

      {sections && loadedSlug ? (
        <div className="space-y-3">
          {saveStatus === "error" && saveError ? (
            <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
          ) : null}

          {/* NOT `overflow-hidden` (only `rounded-xl border`) — 2026-08-06
             real bug: `overflow-hidden` on this wrapper made *it* the
             nearest scroll-containing ancestor for the sticky toolbar
             below, per the CSS spec (any `overflow` value other than
             `visible` establishes one, whether or not it actually
             produces a visible scrollbar). Since this div itself never
             scrolls (it has no bounded height), `position: sticky` had
             nothing to track and the toolbar just scrolled away with the
             page instead of sticking to it. The trade-off: a section
             whose own content somehow extended past this box's rounded
             corners would no longer get clipped — accepted, since real
             section content doesn't do that. */}
          <div className="rounded-xl border">
            {/* Sticky within the preview, not just above it (2026-08-06,
               user request) — a long page used to mean scrolling all the
               way back up just to toggle edit mode or hit Save. `top-14`
               sits it directly below SiteHeader's own sticky h-14 bar
               (see layout/site-header.tsx) rather than overlapping it;
               `z-30` stays under that header's `z-40` for the same
               reason. Solid-ish background (not the old bg-muted/30) so
               scrolled-past section content doesn't show through. */}
            <div className="sticky top-14 z-30 flex flex-wrap items-center justify-between gap-2 rounded-t-xl border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/80">
              <div className="flex items-center gap-2">
                <Switch id="cte-edit-mode" checked={editModeOn} onCheckedChange={setEditModeOn} />
                <Label htmlFor="cte-edit-mode" className="text-sm">
                  Edit mode
                </Label>
                <p className="text-sm text-muted-foreground">
                  {editModeOn
                    ? `Editing ${loadedSlug} — click a pencil badge to edit that field.`
                    : `Previewing ${loadedSlug} as visitors see it — flip the switch to edit.`}
                  {dirty ? " Unsaved changes." : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Optional note"
                  className="w-48"
                />
                <Button size="sm" onClick={handleSaveVersion} disabled={!dirty || saveStatus === "saving"}>
                  <Save className="size-4" />
                  {saveStatus === "saving" ? "Saving…" : "Save as new version"}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleLoad} disabled={loadStatus === "loading"}>
                  <RotateCcw className="size-4" />
                  Reload (discard edits)
                </Button>
              </div>
            </div>

            {saveStatus === "saved" ? (
              <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                Saved as a new version of <code>{loadedSlug}</code> — existing versions stay intact, so this is
                undoable from the Saved pages list on /dashboard.
              </p>
            ) : null}

            <CteProvider
              active={editModeOn}
              onSelect={setSelection}
              onMove={handleMoveItem}
              onRemove={handleRemoveItem}
              onInsertAt={handleInsertAt}
            >
              {editModeOn ? <InsertGap onClick={() => setInsertAt(0)} /> : null}
              {sections.map((section, index) => (
                <React.Fragment key={index}>
                  <div className="group relative">
                    {editModeOn ? (
                      // z-40, not z-20 — 2026-08-06 real bug: now that the
                      // toolbar above is genuinely sticky (z-30, see the
                      // fix note on its wrapper), it actually sits on top
                      // of whatever section content scrolls underneath it,
                      // which it never did while sticky was broken. A
                      // section's own top-2 badge can land at the same
                      // screen position as the stuck toolbar (most visibly
                      // the very first section, right below it) and was
                      // getting painted underneath it — invisible, not
                      // gone. z-40 guarantees it always paints on top.
                      //
                      // opacity-0 group-hover:opacity-100 — 2026-08-06
                      // (CTE part 12), same hover-reveal treatment as
                      // ArrayItemToolbar/InsertGap, for consistency (the
                      // wrapping div above already has `group`).
                      <div className="absolute top-2 left-2 z-40 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                        {section.type === "container" ? (
                          // Folds this container SECTION's own "edit the
                          // whole thing" pencil into the same group as
                          // move/delete, matching the merge already done
                          // for nested container children (2026-08-06,
                          // ArrayItemToolbar's onEdit) — see
                          // SectionRenderer's mergeContainerBadge prop,
                          // which suppresses ContainerBlock's own corner
                          // badge so it isn't offered twice.
                          <button
                            type="button"
                            onClick={() => setSelection({ path: String(index), fieldType: "block-container", value: section })}
                            aria-label="Edit this container"
                            title="Edit this container"
                            // Plain bg-background/90, matching move/delete
                            // — not bg-blue-600 — 2026-08-06 (CTE part 13):
                            // grouped with its neighbors now, a solid
                            // color reads as inconsistent rather than
                            // distinguishing anything (see
                            // ArrayItemToolbar's matching doc comment).
                            className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground"
                          >
                            <Pencil className="size-3" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => handleMoveSection(index, -1)}
                          disabled={index === 0}
                          aria-label="Move section up"
                          title="Move section up"
                          className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        >
                          <ArrowUp className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveSection(index, 1)}
                          disabled={index === sections.length - 1}
                          aria-label="Move section down"
                          title="Move section down"
                          className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        >
                          <ArrowDown className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSection(index)}
                          aria-label="Delete this section"
                          title="Delete this section"
                          className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ) : null}
                    <SectionRenderer
                      sections={[section]}
                      accentColor={accentColor}
                      startIndex={index}
                      mergeContainerBadge
                    />
                  </div>
                  {editModeOn ? <InsertGap onClick={() => setInsertAt(index + 1)} /> : null}
                </React.Fragment>
              ))}
            </CteProvider>
          </div>
        </div>
      ) : null}

      <SectionInsertMenu
        open={insertAt !== null}
        onOpenChange={(open) => { if (!open) setInsertAt(null); }}
        onInsert={handleInsertSection}
      />

      {selection ? (
        <CteEditorPopover
          selection={selection}
          onSave={handleFieldSave}
          onCancel={() => setSelection(null)}
          onDelete={
            selection.mode !== "create" && (selection.fieldType === "feature-item" || selection.fieldType === "cta")
              ? handleFieldDelete
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
