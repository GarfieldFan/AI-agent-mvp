"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, History, Plus, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { ApiError } from "@/lib/api";
import {
  deletePage,
  listPages,
  listPageVersions,
  restorePageVersion,
  savePageVersion,
  type PageSummary,
  type PageVersionSummary,
} from "@/lib/pages";
import { slugify } from "@/lib/slug";

function viewHrefFor(slug: string) {
  return slug === "home" ? "/" : `/p/${encodeURIComponent(slug)}`;
}

function VersionHistory({ slug, onRestored }: { slug: string; onRestored: () => void }) {
  const [versions, setVersions] = React.useState<PageVersionSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [restoringId, setRestoringId] = React.useState<number | null>(null);

  const load = React.useCallback(() => {
    listPageVersions(slug)
      .then((loaded) => {
        setVersions(loaded);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load versions."));
  }, [slug]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleRestore(versionId: number) {
    setRestoringId(versionId);
    try {
      await restorePageVersion(slug, versionId);
      load();
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Restore failed.");
    } finally {
      setRestoringId(null);
    }
  }

  if (error) return <ErrorMessage description={error} onRetry={load} className="mt-2" />;
  if (versions === null) return <LoadingSpinner label="Loading versions…" className="mt-2" />;

  return (
    <ul className="mt-2 space-y-1.5 border-l pl-3">
      {versions.map((version, index) => (
        <li key={version.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            {index === 0 ? <span className="font-medium text-foreground">Current — </span> : null}
            {new Date(version.created_at).toLocaleString()}
            {version.note ? ` · ${version.note}` : ""}
          </span>
          {index !== 0 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => handleRestore(version.id)}
              disabled={restoringId !== null}
            >
              <RotateCcw className="size-3" />
              {restoringId === version.id ? "Restoring…" : "Restore"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Browse every saved page and its version history, with one-click
 * restore. Companion to PageGeneratorPanel's save form — that creates
 * versions, this one lets you see and roll back through them. */
export function PageManager() {
  const [pages, setPages] = React.useState<PageSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = React.useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = React.useState<string | null>(null);

  // "New blank page" (2026-08-19) — the CTE editor (/editor) deliberately
  // only edits *existing* saved content (see CteEditorPanel's own doc
  // comment), and PageGeneratorPanel only ever produces content from a
  // design image/documents — there was genuinely no "start from nothing"
  // path anywhere in the app until this. Saves an empty `sections: []`
  // version to a new slug via the same savePageVersion PageGeneratorPanel
  // already uses; the new slug then shows up in this list and in the CTE
  // editor's own slug datalist (both driven by listPages), ready to
  // load and build up from an empty canvas via its "+" insert gaps.
  const [newSlugInput, setNewSlugInput] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listPages()
      .then((loaded) => {
        setPages(loaded);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load pages."));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleCreateBlank() {
    const slug = slugify(newSlugInput);
    if (!slug) return;
    setCreating(true);
    setCreateError(null);
    try {
      await savePageVersion(slug, { sections: [] }, "Blank page");
      setNewSlugInput("");
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the page.");
    } finally {
      setCreating(false);
    }
  }

  // Unlike Restore (always adds a new version, never destroys history),
  // deleting a page removes every version with no undo — a native
  // confirm() is enough friction for an internal admin tool without
  // needing a whole dialog component just for this one destructive action.
  async function handleDelete(slug: string) {
    if (!window.confirm(`Delete "${slug}" and all ${pages?.find((p) => p.slug === slug)?.version_count ?? ""} of its versions? This cannot be undone.`)) {
      return;
    }
    setDeletingSlug(slug);
    try {
      await deletePage(slug);
      if (expandedSlug === slug) setExpandedSlug(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setDeletingSlug(null);
    }
  }

  const newPageForm = (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="new-page-slug">
          New blank page
        </label>
        <Input
          id="new-page-slug"
          value={newSlugInput}
          onChange={(event) => setNewSlugInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleCreateBlank();
          }}
          placeholder="slug, e.g. summer-promo"
          className="w-56"
        />
      </div>
      <Button size="sm" variant="outline" onClick={handleCreateBlank} disabled={!newSlugInput.trim() || creating}>
        <Plus className="size-4" />
        {creating ? "Creating…" : "Create"}
      </Button>
      {createError ? <p className="w-full text-xs text-destructive">{createError}</p> : null}
      <p className="w-full text-xs text-muted-foreground">
        Creates an empty page, ready to build up from scratch in the editor above via its &quot;+&quot; insert gaps.
      </p>
    </div>
  );

  if (error) return <ErrorMessage description={error} onRetry={load} />;
  if (pages === null) return <LoadingSpinner label="Loading saved pages…" />;

  if (pages.length === 0) {
    return (
      <div className="space-y-3">
        {newPageForm}
        <EmptyState
          icon={History}
          title="No pages saved yet"
          description="Create a blank page above, or generate one above and save it to a slug — either way it'll show up here with its version history."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {newPageForm}
      <div className="space-y-2">
      {pages.map((page) => {
        const expanded = expandedSlug === page.slug;
        return (
          <div key={page.slug} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Link href={viewHrefFor(page.slug)} className="text-sm font-medium underline">
                  {page.slug}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  {page.version_count} version{page.version_count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setExpandedSlug(expanded ? null : page.slug)}
                >
                  {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  History
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => handleDelete(page.slug)}
                  disabled={deletingSlug !== null}
                >
                  <Trash2 className="size-3" />
                  {deletingSlug === page.slug ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
            {expanded ? <VersionHistory slug={page.slug} onRestored={load} /> : null}
          </div>
        );
      })}
      </div>
    </div>
  );
}
