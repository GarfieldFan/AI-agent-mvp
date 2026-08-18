"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Lock, Save, Trash2, Unlock, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { FileDropzone } from "@/components/common/file-dropzone";
import { SectionRenderer } from "@/components/theme/section-renderer";
import { apiFetch, ApiError } from "@/lib/api";
import { fileToBase64 } from "@/lib/file";
import { getModelSettings } from "@/lib/models";
import { listPages, savePageVersion, type PageSummary } from "@/lib/pages";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/utils";
import type { GeneratedPage, PageSection } from "@/lib/theme";

function viewHrefFor(slug: string) {
  return slug === "home" ? "/" : `/p/${encodeURIComponent(slug)}`;
}

/** A generated section plus a client-only, per-preview-session id — the
 * schema itself has no stable per-section id (the vision LLM's output is
 * a fresh array every generation), so this exists purely to give React
 * — and framer-motion's layout/exit animations — something stable to key
 * on across a manual move/delete/regenerate-merge, instead of the array
 * index moving out from under a section every time the order changes. */
type PreviewItem = { id: string; section: PageSection };

function withIds(sections: PageSection[]): PreviewItem[] {
  return sections.map((section) => ({ id: crypto.randomUUID(), section }));
}

/** Regenerating re-analyzes the whole image from scratch every time — the
 * vision LLM has no notion of "redo just this one section," so there's no
 * way to make locking actually cheaper/faster (see the root AGENTS.md's
 * CTE/block-schema section for why: the model can't reliably be trusted
 * to "echo a section back unchanged" either, so asking it to respect
 * locks itself was ruled out in favor of this). What locking *does* buy:
 * a bad regeneration can never overwrite a section you already liked.
 * Still positional, not content-aware — a locked item is placed at the
 * *same index* it occupied before, in the new array, not matched by what
 * it actually contains. If the new generation reorders/inserts sections,
 * a locked item can land next to the wrong neighbor. Deliberately not
 * solved with something smarter (e.g. matching by section `type`): the
 * schema has no stable id, and type-only matching is ambiguous the
 * moment a page has two sections of the same type — this project has
 * repeatedly found that kind of heuristic unreliable beyond simple
 * index/threshold rules. Use the move/delete tools below to fix ordering
 * by hand when a regenerate lands a locked section in a bad spot. If the
 * new generation comes back with fewer sections than a locked index, the
 * locked item is appended at the end rather than silently dropped. */
function mergeLockedSections(
  oldItems: PreviewItem[],
  newSections: PageSection[],
  lockedIds: Set<string>,
): PreviewItem[] {
  const merged = withIds(newSections);
  const overflow: PreviewItem[] = [];
  oldItems.forEach((item, index) => {
    if (!lockedIds.has(item.id)) return;
    if (index < merged.length) {
      merged[index] = item;
    } else {
      overflow.push(item);
    }
  });
  return [...merged, ...overflow];
}

/** Swaps two adjacent preview items (manual reordering — the model has no
 * notion of "move this section," so this is purely a local edit, same
 * spirit as delete below). Since each item carries its own id, a locked
 * item's lock (tracked by id, see `lockedIds` state) automatically stays
 * attached to it wherever it moves — no separate remapping needed.
 * No-op at either edge of the array. */
function moveItem(items: PreviewItem[], index: number, direction: -1 | 1): PreviewItem[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Removes a preview item outright — for a section the model keeps
 * getting wrong that's easier to drop and rebuild by hand (e.g. via CTE,
 * after saving) than to keep regenerating for. */
function deleteItem(items: PreviewItem[], index: number): PreviewItem[] {
  return items.filter((_, i) => i !== index);
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

function ToolbarIconButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** One preview item, individually lockable/movable/deletable. Renders
 * through the exact same `SectionRenderer` a full page uses (called with
 * a single-element array) — the toolbar is purely a UI overlay, it
 * doesn't change how the section itself renders.
 *
 * Wrapped in `motion.div` with `layout` so a move (a plain array swap in
 * the parent) animates into its new position instead of just snapping
 * there — without this, reordering was disorienting: the DOM node at a
 * given screen position just silently swapped content, so a moved
 * section visually "vanished" from where you clicked and reappeared
 * elsewhere with no way to track where it went. `layout` only works
 * because each item now has a stable `id` (see `PreviewItem` above) used
 * as its React `key` — with the old index-based `key`, React reused the
 * same DOM node across a swap and just patched its content in place,
 * giving `layout` nothing to actually animate. The `initial`/`exit`
 * height+opacity animation (paired with the parent's `AnimatePresence`)
 * gives Delete the same "watch it happen" feedback instead of an
 * instant, jarring disappearance. */
function LockableSectionPreview({
  item,
  index,
  total,
  locked,
  accentColor,
  onToggleLock,
  onMove,
  onDelete,
}: {
  item: PreviewItem;
  index: number;
  total: number;
  locked: boolean;
  accentColor?: string;
  onToggleLock: (id: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (index: number) => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ layout: { duration: 0.25, ease: "easeInOut" }, opacity: { duration: 0.2 }, height: { duration: 0.2 } }}
      className="group relative overflow-hidden"
    >
      <div
        className={cn(
          "absolute top-2 right-2 z-10 flex items-center gap-1 transition",
          !locked && "opacity-0 group-hover:opacity-100",
        )}
      >
        <ToolbarIconButton onClick={() => onMove(index, -1)} disabled={index === 0} label="Move section up">
          <ArrowUp className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton onClick={() => onMove(index, 1)} disabled={index === total - 1} label="Move section down">
          <ArrowDown className="size-3" />
        </ToolbarIconButton>
        <button
          type="button"
          onClick={() => onToggleLock(item.id)}
          aria-label={locked ? "Unlock this section — regenerating may replace it" : "Lock this section so regenerating won't replace it"}
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium shadow transition",
            locked ? "bg-primary text-primary-foreground" : "bg-background/90 text-muted-foreground hover:bg-background",
          )}
        >
          {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
          {locked ? "Locked" : "Lock"}
        </button>
        <ToolbarIconButton onClick={() => onDelete(index)} label="Delete this section">
          <Trash2 className="size-3" />
        </ToolbarIconButton>
      </div>
      <SectionRenderer sections={[item.section]} accentColor={accentColor} />
    </motion.div>
  );
}

/** The one agent-console capability that's actually real (see
 * backend/apis/agent.py's generate_landing_page) — upload a design image,
 * a vision LLM (whichever the owner has selected in Model settings, see
 * `visionLabel` below — was hardcoded to "qwen3.6" until 2026-08-19, wrong
 * ever since vision generation became provider-agnostic) turns it into a
 * PageSection[], previewed here via the same SectionRenderer any saved
 * page renders through. Not landing-page-specific despite the endpoint's
 * name — SavePageForm below can park a generation onto any slug (home,
 * about, a promo page, ...), so this is a general page generator, not
 * just a landing-page one. */
export function PageGeneratorPanel() {
  const [file, setFile] = React.useState<File | null>(null);
  const [notes, setNotes] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<PreviewItem[] | null>(null);
  const [accentColor, setAccentColor] = React.useState<string | undefined>(undefined);
  const [lockedIds, setLockedIds] = React.useState<Set<string>>(new Set());
  // Display only — reflects whatever's actually configured in Model
  // settings, not a fixed model name. Null until loaded (or if the
  // fetch fails, e.g. logged out) falls back to a generic label below.
  const [visionLabel, setVisionLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    getModelSettings()
      .then((settings) => {
        if (!cancelled) setVisionLabel(`${settings.vision_provider} / ${settings.vision_model}`);
      })
      .catch(() => {
        // Non-critical — the label just falls back to a generic phrase below.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reassembled from `items`/`accentColor` on every render rather than
  // stored directly — `items` (with its stable per-item ids, see
  // `PreviewItem` above) is the actual source of truth for the preview
  // and its animations; this is only what SavePageForm needs to persist.
  const result: GeneratedPage | null = items ? { sections: items.map((item) => item.section), accent_color: accentColor } : null;

  function toggleLock(id: string) {
    setLockedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleFileChange(nextFile: File | null) {
    setFile(nextFile);
    setItems(null);
    setAccentColor(undefined);
    setLockedIds(new Set());
  }

  function handleMoveSection(index: number, direction: -1 | 1) {
    if (!items) return;
    setItems(moveItem(items, index, direction));
  }

  function handleDeleteSection(index: number) {
    if (!items) return;
    if (!window.confirm("Remove this section from the preview? This only affects the unsaved preview.")) return;
    const removed = items[index];
    setItems(deleteItem(items, index));
    if (removed && lockedIds.has(removed.id)) {
      const next = new Set(lockedIds);
      next.delete(removed.id);
      setLockedIds(next);
    }
  }

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
      const nextItems =
        items && lockedIds.size > 0 ? mergeLockedSections(items, response.sections, lockedIds) : withIds(response.sections);
      setItems(nextItems);
      setAccentColor(response.accent_color);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Generation failed — is the backend reachable?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Page generator</h3>
        <p className="text-xs text-muted-foreground">
          Upload a design image (mockup, screenshot, even a rough sketch). A
          vision LLM ({visionLabel ?? "your configured vision model"}) turns it
          into page sections, previewed below — save it to a slug to publish
          it (see below).
        </p>
      </div>

      <FileDropzone
        file={file}
        onFileChange={handleFileChange}
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
      <div className="flex items-center gap-3">
        <Button onClick={handleGenerate} disabled={!file || status === "loading"}>
          <Wand2 className="size-4" />
          {result ? "Regenerate" : "Generate"}
        </Button>
        {result && lockedIds.size > 0 ? (
          <p className="text-xs text-muted-foreground">
            {lockedIds.size} section{lockedIds.size === 1 ? "" : "s"} locked — kept as-is on regenerate.
          </p>
        ) : null}
      </div>

      {status === "loading" ? (
        <LoadingSpinner
          label={`Generating with ${visionLabel ?? "your configured vision model"} — vision + a full page schema can take a few minutes for a large local model…`}
        />
      ) : null}

      {status === "error" && error ? (
        <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
      ) : null}

      {result ? (
        <>
          <div className="overflow-hidden rounded-xl border">
            <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-2 text-sm font-medium">
              <span>Preview (not published)</span>
              <span className="text-xs font-normal text-muted-foreground">
                Hover a section to lock, reorder, or delete it
              </span>
            </div>
            <div className="max-h-[36rem] space-y-1 overflow-y-auto">
              <AnimatePresence initial={false} mode="popLayout">
                {(items ?? []).map((item, index) => (
                  <LockableSectionPreview
                    key={item.id}
                    item={item}
                    index={index}
                    total={items?.length ?? 0}
                    locked={lockedIds.has(item.id)}
                    accentColor={accentColor}
                    onToggleLock={toggleLock}
                    onMove={handleMoveSection}
                    onDelete={handleDeleteSection}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
          <SavePageForm content={result} />
        </>
      ) : null}
    </div>
  );
}
