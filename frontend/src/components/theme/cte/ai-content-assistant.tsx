"use client";

import * as React from "react";
import { ArrowUp, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { collectFillableFields, requestAiFillContent, type FillableField } from "@/lib/page-ai-fill";
import { generatePoster } from "@/lib/poster";
import type { PageSection } from "@/lib/theme";

type ImageJobStatus = "idle" | "queued" | "running" | "done" | "error";

type ImageJob = {
  path: string;
  label: string;
  prompt: string;
  status: ImageJobStatus;
  errorMessage?: string;
  resultUrl?: string;
};

type QueueEntry = { path: string; prompt: string };

type AiContentAssistantProps = {
  sections: PageSection[];
  /** Applies one field's generated value into the live (unsaved) editing
   * state, mirroring CteEditorPanel's own setByPath-based handlers.
   * `richText` (when set) means the field was already a RichText object
   * with its own color/size/weight — the caller preserves those and only
   * replaces `content`. */
  onApplyText: (path: string, value: string, richText?: FillableField["richText"]) => void;
  onApplyTextList: (path: string, values: string[]) => void;
  onApplyImage: (path: string, url: string) => void;
  /** Whether CTE edit mode is currently on. This component must stay
   * MOUNTED regardless (2026-09-08 fix, a real bug the user hit): the
   * caller used to conditionally render this whole component on
   * `editModeOn`, which meant simply toggling edit mode off to preview
   * the result — the natural way to check generated content without
   * leaving /editor — destroyed every bit of this component's own state
   * (the image job queue, each job's status/result, the text pass's
   * `reasoning`), even though the actual page content it had already
   * applied survived fine (that lives in the parent's `sections` state).
   * Same "stay mounted, hide the affordance instead of unmounting the
   * subtree" fix `ChatBubbleWidget` already established for its own
   * open/closed toggle. Only the trigger button (and auto-closing an
   * already-open sheet) reacts to this — the image-generation queue
   * keeps draining in the background either way, matching the "don't
   * have to babysit it" design already documented for it. */
  active: boolean;
};

/** The floating "AI fill content" assistant — once the owner has arranged
 * a page's layout by hand, this fills it in. Two phases in one Sheet:
 *
 * 1. One whole-page prompt (`POST /agent/pages/ai-fill-content`) fills
 *    every text/text-list field it finds directly into the live editing
 *    state — same "apply immediately, still editable before Save" posture
 *    as every other CTE edit, see the root AGENTS.md's CTE section.
 * 2. Every image slot that call found gets its own row here — a
 *    generation prompt (pre-filled from the AI's suggestion, editable), a
 *    status, and its own Generate button — appearing only once step 1 has
 *    run, per the confirmed design. Images are deliberately never
 *    auto-generated: each is enqueued on click and processed one at a
 *    time (ComfyUI/most image providers have no business running more
 *    than one job at once — see resource_broker.py), with a real queue: a
 *    still-waiting row can be bumped to the front ("Generate next") or
 *    cancelled before it starts. */
export function AiContentAssistant({
  sections,
  onApplyText,
  onApplyTextList,
  onApplyImage,
  active,
}: AiContentAssistantProps) {
  const [open, setOpen] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [textStatus, setTextStatus] = React.useState<"idle" | "loading" | "done" | "error">("idle");
  const [textError, setTextError] = React.useState<string | null>(null);
  const [filledCount, setFilledCount] = React.useState(0);

  const [jobs, setJobs] = React.useState<ImageJob[]>([]);
  const [queue, setQueue] = React.useState<QueueEntry[]>([]);
  const [processingPath, setProcessingPath] = React.useState<string | null>(null);

  async function handleGenerateText() {
    if (!prompt.trim()) return;
    setTextStatus("loading");
    setTextError(null);
    try {
      const fillable = collectFillableFields(sections);
      const { fields } = await requestAiFillContent(prompt, fillable);
      const byPath = new Map(fields.map((f) => [f.path, f.value]));
      const nextJobs: ImageJob[] = [];
      let applied = 0;
      for (const field of fillable) {
        const value = byPath.get(field.path);
        if (field.kind === "image") {
          nextJobs.push({ path: field.path, label: field.label, prompt: value ?? "", status: "idle" });
          continue;
        }
        if (value === undefined) continue;
        applied += 1;
        if (field.kind === "text-list") {
          onApplyTextList(
            field.path,
            value.split("|").map((s) => s.trim()).filter(Boolean),
          );
        } else {
          onApplyText(field.path, value, field.richText);
        }
      }
      setJobs(nextJobs);
      setFilledCount(applied);
      setTextStatus("done");
    } catch (err) {
      setTextError(err instanceof ApiError ? err.message : "Could not reach the backend.");
      setTextStatus("error");
    }
  }

  function enqueue(path: string, promptText: string) {
    if (!promptText.trim()) return;
    setJobs((prev) => prev.map((j) => (j.path === path ? { ...j, status: "queued", errorMessage: undefined } : j)));
    setQueue((prev) => (prev.some((q) => q.path === path) ? prev : [...prev, { path, prompt: promptText }]));
  }

  function bumpToFront(path: string) {
    setQueue((prev) => {
      const entry = prev.find((q) => q.path === path);
      if (!entry) return prev;
      return [entry, ...prev.filter((q) => q.path !== path)];
    });
  }

  function cancelQueued(path: string) {
    setQueue((prev) => prev.filter((q) => q.path !== path));
    setJobs((prev) => prev.map((j) => (j.path === path ? { ...j, status: "idle" } : j)));
  }

  function updateJobPrompt(path: string, next: string) {
    setJobs((prev) => prev.map((j) => (j.path === path ? { ...j, prompt: next } : j)));
    setQueue((prev) => prev.map((q) => (q.path === path ? { ...q, prompt: next } : q)));
  }

  // Sequential worker: one image job at a time. Every state update lives
  // inside the locally-defined async function the effect merely calls
  // (none run synchronously in the effect body itself) — same fix shape
  // login-form.tsx's own OAuth-callback effect already established for
  // react-hooks/set-state-in-effect, see the root AGENTS.md.
  React.useEffect(() => {
    if (processingPath !== null || queue.length === 0) return;
    const next = queue[0];

    void (async () => {
      setQueue((prev) => prev.slice(1));
      setProcessingPath(next.path);
      setJobs((prev) => prev.map((j) => (j.path === next.path ? { ...j, status: "running" } : j)));
      try {
        const result = await generatePoster(next.prompt, "");
        onApplyImage(next.path, result.image_url);
        setJobs((prev) =>
          prev.map((j) => (j.path === next.path ? { ...j, status: "done", resultUrl: result.image_url } : j)),
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Generation failed — is the image provider reachable?";
        setJobs((prev) => prev.map((j) => (j.path === next.path ? { ...j, status: "error", errorMessage: message } : j)));
      } finally {
        setProcessingPath(null);
      }
    })();
  }, [processingPath, queue, onApplyImage]);

  return (
    <>
      {active ? (
        <Button type="button" onClick={() => setOpen(true)} className="fixed bottom-6 left-6 z-40 rounded-full shadow-lg">
          <Sparkles className="size-4" />
          AI fill content
        </Button>
      ) : null}

      {/* `open={open && active}` — a derived value, not a synced-via-effect
         one — closes this sheet the instant edit mode turns off (it's
         supposed to read as a clean, undecorated preview) with no
         `useEffect`/setState needed. `onOpenChange` still writes to the
         real `open` state on an explicit close, so state (jobs, prompt,
         reasoning) is never touched by this — only what's currently
         visible is. */}
      <Sheet open={open && active} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>AI fill content</SheetTitle>
            <p className="text-sm text-muted-foreground">
              Describe what this page is about — the AI writes copy for every text field in the layout you&apos;ve
              already built, without changing that layout. Applies straight into your unsaved edits, so you can
              still tweak anything by hand before saving.
            </p>
          </SheetHeader>

          <div className="space-y-3 px-4">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="e.g. A cozy neighborhood coffee shop specializing in hand-poured pour-over coffee and fresh pastries…"
              rows={4}
              disabled={textStatus === "loading"}
            />
            <Button onClick={handleGenerateText} disabled={!prompt.trim() || textStatus === "loading"}>
              {textStatus === "loading" ? "Writing…" : textStatus === "done" ? "Regenerate text" : "Generate text"}
            </Button>
            {textStatus === "loading" ? <LoadingSpinner label="Writing content for this layout…" /> : null}
            {textStatus === "error" && textError ? (
              <ErrorMessage description={textError} onRetry={() => setTextStatus("idle")} />
            ) : null}
            {textStatus === "done" ? (
              <p className="text-xs text-muted-foreground">
                Filled {filledCount} field{filledCount === 1 ? "" : "s"}. Review the page behind this panel, then
                generate images below (or close this and edit any field by hand, same as always).
              </p>
            ) : null}
          </div>

          {jobs.length > 0 ? (
            <div className="space-y-2 border-t px-4 pt-3">
              <p className="text-sm font-medium">Images ({jobs.length})</p>
              <p className="text-xs text-muted-foreground">
                Generated one at a time — click Generate on a row when you&apos;re ready for it. A row already
                waiting can be moved to the front instead of generated in list order.
              </p>
              <div className="space-y-3">
                {jobs.map((job) => (
                  <div key={job.path} className="space-y-1.5 rounded-lg border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">{job.label}</p>
                      {job.status === "queued" ? <Badge variant="outline">Queued</Badge> : null}
                      {job.status === "running" ? <Badge>Generating…</Badge> : null}
                      {job.status === "done" ? <Badge variant="secondary">Done</Badge> : null}
                      {job.status === "error" ? <Badge variant="destructive">Failed</Badge> : null}
                    </div>
                    {job.status === "done" && job.resultUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- generated image's host isn't known ahead of time
                      <img src={job.resultUrl} alt={job.label} className="h-24 w-full rounded object-cover" />
                    ) : null}
                    <Input
                      value={job.prompt}
                      onChange={(event) => updateJobPrompt(job.path, event.target.value)}
                      placeholder="Describe the image to generate…"
                      disabled={job.status === "running"}
                    />
                    {job.status === "error" && job.errorMessage ? (
                      <p className="text-xs text-destructive">{job.errorMessage}</p>
                    ) : null}
                    <div className="flex gap-2">
                      {job.status === "queued" ? (
                        <>
                          {queue[0]?.path !== job.path ? (
                            <Button size="sm" variant="outline" onClick={() => bumpToFront(job.path)}>
                              <ArrowUp className="size-3" />
                              Generate next
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => cancelQueued(job.path)}>
                            <X className="size-3" />
                            Cancel
                          </Button>
                        </>
                      ) : job.status !== "running" ? (
                        <Button size="sm" onClick={() => enqueue(job.path, job.prompt)} disabled={!job.prompt.trim()}>
                          {job.status === "done" ? "Regenerate" : job.status === "error" ? "Retry" : "Generate"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <SheetFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
