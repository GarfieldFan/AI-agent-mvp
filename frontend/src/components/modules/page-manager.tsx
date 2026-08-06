"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, History, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { ApiError } from "@/lib/api";
import {
  deletePage,
  listPages,
  listPageVersions,
  restorePageVersion,
  type PageSummary,
  type PageVersionSummary,
} from "@/lib/pages";

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

  if (error) return <ErrorMessage description={error} onRetry={load} />;
  if (pages === null) return <LoadingSpinner label="Loading saved pages…" />;

  if (pages.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No pages saved yet"
        description="Generate a page above and save it to a slug — it'll show up here with its version history."
      />
    );
  }

  return (
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
  );
}
