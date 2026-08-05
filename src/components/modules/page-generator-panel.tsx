"use client";

import * as React from "react";
import Link from "next/link";
import { Save, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { FileDropzone } from "@/components/common/file-dropzone";
import { SectionRenderer } from "@/components/theme/section-renderer";
import { apiFetch, ApiError } from "@/lib/api";
import { fileToBase64 } from "@/lib/file";
import { listPages, savePageVersion, type PageSummary } from "@/lib/pages";
import { slugify } from "@/lib/slug";
import type { GeneratedPage } from "@/lib/theme";

function viewHrefFor(slug: string) {
  return slug === "home" ? "/" : `/p/${encodeURIComponent(slug)}`;
}

/** Lets you park a generated result onto a slug — "home" overwrites (via a
 * new version, never destructively) the live homepage, anything else
 * lives at /p/[slug]. Rendered under the preview once a generation
 * exists; see backend/apis/pages.py for the storage side. */
function SavePageForm({ content }: { content: GeneratedPage }) {
  const [slug, setSlug] = React.useState("");
  const [note, setNote] = React.useState("");
  const [pages, setPages] = React.useState<PageSummary[]>([]);
  const [status, setStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    listPages()
      .then(setPages)
      .catch(() => setPages([]));
  }, []);

  async function handleSave() {
    const normalized = slugify(slug);
    if (!normalized) return;
    setSlug(normalized);
    setStatus("saving");
    setError(null);
    try {
      await savePageVersion(normalized, content, note.trim() || undefined);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground">Save this generation to a page</p>
      <div className="flex flex-wrap gap-2">
        <Input
          list="existing-page-slugs"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setStatus("idle");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSave();
          }}
          placeholder="Page slug — e.g. home, about, summer-promo"
          className="max-w-xs"
        />
        <datalist id="existing-page-slugs">
          {pages.map((page) => (
            <option key={page.slug} value={page.slug} />
          ))}
        </datalist>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional note (e.g. 'fixed hero image')"
          className="max-w-xs"
        />
        <Button size="sm" variant="outline" onClick={handleSave} disabled={!slug.trim() || status === "saving"}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      {status === "saving" ? <LoadingSpinner label="Saving…" /> : null}
      {status === "error" && error ? (
        <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
      ) : null}
      {status === "saved" ? (
        <p className="text-xs text-muted-foreground">
          Saved as a new version of <code>{slug.trim()}</code> —{" "}
          <Link href={viewHrefFor(slug.trim())} className="underline">
            view it live
          </Link>
          . Existing pages get a new version on top, never overwritten — full history stays intact.
        </p>
      ) : null}
    </div>
  );
}

/** The one agent-console capability that's actually real (see
 * backend/apis/agent.py's generate_landing_page) — upload a design image,
 * a vision LLM (qwen3.6) turns it into a PageSection[], previewed here via
 * the same SectionRenderer any saved page renders through. Not landing-
 * page-specific despite the endpoint's name — SavePageForm below can park
 * a generation onto any slug (home, about, a promo page, ...), so this is
 * a general page generator, not just a landing-page one. */
export function PageGeneratorPanel() {
  const [file, setFile] = React.useState<File | null>(null);
  const [notes, setNotes] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<GeneratedPage | null>(null);

  async function handleGenerate() {
    if (!file) return;
    setStatus("loading");
    setError(null);
    try {
      const dataUri = await fileToBase64(file);
      const response = await apiFetch<GeneratedPage>("/api/agent/landing-page/generate", {
        method: "POST",
        body: { design_image_base64: dataUri, notes },
      });
      setResult(response);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Generation failed — is the backend reachable?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Page generator</h3>
        <p className="text-xs text-muted-foreground">
          Upload a design image (mockup, screenshot, even a rough sketch). A
          vision LLM (qwen3.6) turns it into page sections, previewed below
          — save it to a slug to publish it (see below).
        </p>
      </div>

      <FileDropzone
        file={file}
        onFileChange={setFile}
        accept="image/*"
        label="Drag & drop a design image here, or click to browse"
        disabled={status === "loading"}
      />
      <Textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Optional notes for the generator (e.g. tone, must-keep copy)…"
        disabled={status === "loading"}
      />
      <Button onClick={handleGenerate} disabled={!file || status === "loading"}>
        <Wand2 className="size-4" />
        Generate
      </Button>

      {status === "loading" ? (
        <LoadingSpinner label="Generating with qwen3.6 — vision + a 36B model takes about 1-2 minutes…" />
      ) : null}

      {status === "error" && error ? (
        <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
      ) : null}

      {result ? (
        <>
          <div className="overflow-hidden rounded-xl border">
            <div className="border-b bg-muted/50 px-4 py-2 text-sm font-medium">
              Preview (not published)
            </div>
            <div className="max-h-[36rem] overflow-y-auto">
              <SectionRenderer sections={result.sections} accentColor={result.accent_color} />
            </div>
          </div>
          <SavePageForm content={result} />
        </>
      ) : null}
    </div>
  );
}
