"use client";

import * as React from "react";
import Link from "next/link";
import { Search, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { EmptyState } from "@/components/common/empty-state";
import { SectionRenderer } from "@/components/theme/section-renderer";
import { ApiError } from "@/lib/api";
import { generateGeoPage, GEO_PAGE_SLUG } from "@/lib/geo-page";
import { deletePage, getPublicPage, listPageVersions, type PageVersionSummary } from "@/lib/pages";
import type { GeneratedPage } from "@/lib/theme";

/** A single, auto-generated company-profile page meant for search engines
 * and AI systems (GEO — Generative Engine Optimization) to read, not
 * primarily human visitors — see the root AGENTS.md's GEO section for the
 * full rationale. Backed by backend/apis/agent.py's
 * POST /agent/geo-page/generate: pulls every ready-ingested RAG document
 * (see DocumentManager above) and asks a plain text LLM (not vision) to
 * synthesize a factual profile, saved directly to the fixed
 * GEO_PAGE_SLUG — there's exactly one of these, so unlike
 * PageGeneratorPanel there's no slug to pick or a separate save step.
 * Editing/deleting both reuse the already-generic page endpoints —
 * "Edit" links to /editor, which already lists every saved slug
 * (including this one, once generated) in its own picker. */
export function GeoPagePanel() {
  const [current, setCurrent] = React.useState<GeneratedPage | null>(null);
  const [latestVersion, setLatestVersion] = React.useState<PageVersionSummary | null>(null);
  const [loadStatus, setLoadStatus] = React.useState<"loading" | "idle" | "error">("loading");
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [generateStatus, setGenerateStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  const [deleteStatus, setDeleteStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  async function refresh() {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const [page, versions] = await Promise.all([
        getPublicPage(GEO_PAGE_SLUG),
        listPageVersions(GEO_PAGE_SLUG).catch(() => [] as PageVersionSummary[]),
      ]);
      setCurrent(page);
      setLatestVersion(versions[0] ?? null);
      setLoadStatus("idle");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load the SEO/GEO page.");
      setLoadStatus("error");
    }
  }

  React.useEffect(() => {
    // One-time mount fetch (empty deps — never re-runs, no loop risk); the
    // lint rule can't tell that apart from a genuinely reactive setState
    // sync, so it flags this unconditionally regardless of actual risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, []);

  async function handleGenerate() {
    setGenerateStatus("loading");
    setGenerateError(null);
    try {
      await generateGeoPage();
      await refresh();
      setGenerateStatus("idle");
    } catch (err) {
      setGenerateError(
        err instanceof ApiError ? err.message : "Generation failed — is the backend reachable?",
      );
      setGenerateStatus("error");
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete the SEO/GEO page? This removes every saved version, with no undo.")) return;
    setDeleteStatus("loading");
    setDeleteError(null);
    try {
      await deletePage(GEO_PAGE_SLUG);
      await refresh();
      setDeleteStatus("idle");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Delete failed.");
      setDeleteStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">SEO / GEO page</h3>
        <p className="text-xs text-muted-foreground">
          A single auto-generated company-profile page built from every ready
          document in the knowledge base above — meant for search engines and
          AI systems to read, not a visual landing page. Regenerating replaces
          it with a fresh version each time.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleGenerate} disabled={generateStatus === "loading"}>
          <Sparkles className="size-4" />
          {current ? "Regenerate" : "Generate"}
        </Button>
        {current ? (
          <>
            <Button variant="outline" nativeButton={false} render={<Link href="/editor" />}>
              Edit
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href={`/p/${GEO_PAGE_SLUG}`} />}>
              View live
            </Button>
            <Button variant="ghost" onClick={handleDelete} disabled={deleteStatus === "loading"}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </>
        ) : null}
      </div>

      {generateStatus === "loading" ? (
        <LoadingSpinner label="Reading the knowledge base and writing the page…" />
      ) : null}
      {generateStatus === "error" && generateError ? (
        <ErrorMessage description={generateError} onRetry={() => setGenerateStatus("idle")} />
      ) : null}
      {deleteStatus === "error" && deleteError ? (
        <ErrorMessage description={deleteError} onRetry={() => setDeleteStatus("idle")} />
      ) : null}

      {loadStatus === "loading" ? <LoadingSpinner label="Loading current page…" /> : null}
      {loadStatus === "error" && loadError ? <ErrorMessage description={loadError} onRetry={refresh} /> : null}

      {loadStatus === "idle" && !current ? (
        <EmptyState
          icon={Search}
          title="Not generated yet"
          description="Click Generate above — needs at least one document with status Ready in the knowledge base."
        />
      ) : null}

      {current ? (
        <div className="space-y-2">
          {latestVersion ? (
            <p className="text-xs text-muted-foreground">
              Last generated {new Date(latestVersion.created_at).toLocaleString()}
              {latestVersion.note ? ` — ${latestVersion.note}` : ""}
            </p>
          ) : null}
          <div className="overflow-hidden rounded-xl border">
            <div className="border-b bg-muted/50 px-4 py-2 text-sm font-medium">Preview</div>
            <div className="max-h-[24rem] overflow-y-auto">
              <SectionRenderer sections={current.sections} accentColor={current.accent_color} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
