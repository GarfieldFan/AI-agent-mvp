"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, History, Plus, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { Pagination } from "@/components/common/pagination";
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
import { useDebouncedSearch } from "@/lib/use-debounced-search";

function viewHrefFor(slug: string) {
  return slug === "home" ? "/" : `/p/${encodeURIComponent(slug)}`;
}

const VERSION_PAGE_SIZE = 20;
const PAGE_LIST_SIZE = 20;

function VersionHistory({ slug, onRestored }: { slug: string; onRestored: () => void }) {
  const [versions, setVersions] = React.useState<PageVersionSummary[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const [restoringId, setRestoringId] = React.useState<number | null>(null);

  const load = React.useCallback(() => {
    listPageVersions(slug, VERSION_PAGE_SIZE, (page - 1) * VERSION_PAGE_SIZE)
      .then((result) => {
        setVersions(result.items);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load versions."));
  }, [slug, page]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleRestore(versionId: number) {
    setRestoringId(versionId);
    try {
      await restorePageVersion(slug, versionId);
      // A restore adds a new version on top (most-recent-first order) —
      // jump back to page 1 so it's actually visible, mirroring
      // ProductPanel/DocumentManager's same "new row sorts first" fix.
      if (page === 1) load();
      else setPage(1);
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
    <div className="mt-2 space-y-2">
      <ul className="space-y-1.5 border-l pl-3">
        {versions.map((version, index) => {
          // "Current" only ever means the single newest version overall
          // — index 0 on page 1, never index 0 of a later page.
          const isCurrent = page === 1 && index === 0;
          return (
            <li key={version.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {isCurrent ? <span className="font-medium text-foreground">Current — </span> : null}
                {new Date(version.created_at).toLocaleString()}
                {version.note ? ` · ${version.note}` : ""}
              </span>
              {!isCurrent ? (
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
          );
        })}
      </ul>
      {total > VERSION_PAGE_SIZE ? (
        <Pagination page={page} pageSize={VERSION_PAGE_SIZE} total={total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}

/** Browse every saved page and its version history, with one-click
 * restore. Companion to PageGeneratorPanel's save form — that creates
 * versions, this one lets you see and roll back through them.
 *
 * Paginated + searchable (2026-09-10) — was a plain unbounded fetch,
 * fine when a site only had a handful of pages but hard to navigate once
 * it accumulates more (a real gap the user flagged directly). Mirrors
 * ChatSessionViewerPanel's debounce-and-reset-page-together pattern
 * (see that component's own doc comment for why the page reset lives
 * inside the same setTimeout rather than a separate effect).
 *
 * `refreshToken` (2026-09-10) — this component and PageGeneratorPanel's
 * own `SavePageForm` are separate sibling components (see
 * agent-console-section.tsx) with independent state; saving a page over
 * there previously left this list showing stale data until a manual page
 * refresh, a real UX gap the user flagged directly. Bumping this prop
 * (any change, the value itself is meaningless) re-fetches the current
 * page — same "shared refresh signal between sibling components"
 * mechanism CrmPanel's own `refreshToken` already uses. */
export function PageManager({ refreshToken }: { refreshToken?: number } = {}) {
  const [pages, setPages] = React.useState<PageSummary[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [searchInput, setSearchInput] = React.useState("");
  const searchText = useDebouncedSearch(searchInput, setPage);
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
  // editor's own browsable page list (both driven by listPages), ready
  // to load and build up from an empty canvas via its "+" insert gaps.
  const [newSlugInput, setNewSlugInput] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listPages({ q: searchText || undefined, limit: PAGE_LIST_SIZE, offset: (page - 1) * PAGE_LIST_SIZE })
      .then((result) => {
        setPages(result.items);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load pages."));
  }, [page, searchText]);

  React.useEffect(() => {
    load();
    // `refreshToken` isn't read inside `load` itself — it's purely a
    // signal from a sibling component that something changed elsewhere,
    // so it belongs in this effect's own deps, not `load`'s.
  }, [load, refreshToken]);

  async function handleCreateBlank() {
    const slug = slugify(newSlugInput);
    if (!slug) return;
    setCreating(true);
    setCreateError(null);
    try {
      await savePageVersion(slug, { sections: [] }, "Blank page");
      setNewSlugInput("");
      // A new page sorts first (most-recent-first) — jump back to page 1
      // and clear any active search so it's actually visible, mirroring
      // ProductPanel's identical "new row sorts first" fix.
      if (page === 1 && !searchText) load();
      else {
        // Clearing searchInput alone still clears the actual filter
        // (searchText, debounced via useDebouncedSearch) within one
        // debounce cycle — a brief, acceptable flicker for this
        // low-frequency admin action, not worth a manual bypass.
        setSearchInput("");
        setPage(1);
      }
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
      // Deleting the last item on a non-first page steps back a page,
      // mirroring ProductPanel's identical fix.
      if (pages && pages.length === 1 && page > 1) setPage(page - 1);
      else load();
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

  if (pages.length === 0 && !searchText) {
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

      <Input
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Search by slug…"
        className="max-w-sm"
      />

      {pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pages match &quot;{searchText}&quot;.</p>
      ) : (
        <div className="space-y-2">
          {pages.map((pageItem) => {
            const expanded = expandedSlug === pageItem.slug;
            return (
              <div key={pageItem.slug} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Link href={viewHrefFor(pageItem.slug)} className="text-sm font-medium underline">
                      {pageItem.slug}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {pageItem.version_count} version{pageItem.version_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setExpandedSlug(expanded ? null : pageItem.slug)}
                    >
                      {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      History
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => handleDelete(pageItem.slug)}
                      disabled={deletingSlug !== null}
                    >
                      <Trash2 className="size-3" />
                      {deletingSlug === pageItem.slug ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </div>
                {expanded ? <VersionHistory slug={pageItem.slug} onRestored={load} /> : null}
              </div>
            );
          })}
        </div>
      )}

      {total > PAGE_LIST_SIZE ? (
        <Pagination page={page} pageSize={PAGE_LIST_SIZE} total={total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
