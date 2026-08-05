"use client";

import * as React from "react";
import { Lock, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { CteEditorPopover } from "@/components/theme/cte/cte-editor-popover";
import { CteProvider } from "@/components/theme/cte/cte-context";
import { SectionRenderer } from "@/components/theme/section-renderer";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { appendByPath, removeByPath, setByPath, type CteSelection } from "@/lib/cte";
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
    setSelection(null);
  }

  function handleFieldDelete() {
    if (!selection) return;
    setSections((prev) => (prev ? (removeByPath(prev, selection.path) as PageSection[]) : prev));
    setDirty(true);
    setSaveStatus("idle");
    setSelection(null);
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
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-4 py-2">
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
                Save as new version
              </Button>
              <Button size="sm" variant="ghost" onClick={handleLoad} disabled={loadStatus === "loading"}>
                <RotateCcw className="size-4" />
                Reload (discard edits)
              </Button>
            </div>
          </div>

          {saveStatus === "saving" ? <LoadingSpinner label="Saving…" /> : null}
          {saveStatus === "error" && saveError ? (
            <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
          ) : null}
          {saveStatus === "saved" ? (
            <p className="text-xs text-muted-foreground">
              Saved as a new version of <code>{loadedSlug}</code> — existing versions stay intact, so this is
              undoable from the Saved pages list on /dashboard.
            </p>
          ) : null}

          <div className="overflow-hidden rounded-xl border">
            <CteProvider active={editModeOn} onSelect={setSelection}>
              <SectionRenderer sections={sections} accentColor={accentColor} />
            </CteProvider>
          </div>
        </div>
      ) : null}

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
