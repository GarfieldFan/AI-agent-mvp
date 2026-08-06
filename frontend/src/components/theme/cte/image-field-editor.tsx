"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { FileDropzone } from "@/components/common/file-dropzone";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import { ApiError } from "@/lib/api";
import { fileToBase64 } from "@/lib/file";
import { listMedia, uploadMedia, type MediaItem } from "@/lib/media";
import { generatePoster } from "@/lib/poster";
import type { ThemeImage } from "@/lib/theme";

type ImageFieldEditorProps = {
  value: ThemeImage;
  onChange: (image: ThemeImage) => void;
};

/** The image field's editor UI inside CteEditorPopover's Sheet — four ways
 * to land on a `ThemeImage`: type a URL directly, upload a file, generate
 * one via ComfyUI (reuses lib/poster.ts's generatePoster, same call
 * `PosterGeneratorPanel` makes, with no overlay text), or pick an existing
 * one from the media library (backend/apis/media.py — ComfyUI's own
 * output directory plus previously-uploaded files, merged). Every path
 * just calls `onChange` with a new `ThemeImage` — this component never
 * saves anything itself, CteEditorPopover's own Save button commits
 * whatever `value` ends up being, same as every other field type. */
export function ImageFieldEditor({ value, onChange }: ImageFieldEditorProps) {
  const [tab, setTab] = React.useState("url");
  const [urlDraft, setUrlDraft] = React.useState(value.url === "#" ? "" : value.url);

  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = React.useState<"idle" | "uploading" | "error">("idle");
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const [prompt, setPrompt] = React.useState("");
  const [genStatus, setGenStatus] = React.useState<"idle" | "generating" | "error">("idle");
  const [genError, setGenError] = React.useState<string | null>(null);

  const [libraryItems, setLibraryItems] = React.useState<MediaItem[]>([]);
  const [libraryStatus, setLibraryStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const libraryFetched = React.useRef(false);

  // Fetched on the tab-switch event itself, not a useEffect watching
  // `tab` — an effect calling setState synchronously in its body trips
  // the react-hooks/set-state-in-effect lint rule and risks a cascading
  // render; driving it from the actual user interaction avoids both.
  function handleTabChange(next: string) {
    setTab(next);
    if (next === "library" && !libraryFetched.current) {
      libraryFetched.current = true;
      setLibraryStatus("loading");
      listMedia()
        .then((items) => {
          setLibraryItems(items);
          setLibraryStatus("idle");
        })
        .catch(() => setLibraryStatus("error"));
    }
  }

  async function handleUpload() {
    if (!uploadFile) return;
    setUploadStatus("uploading");
    setUploadError(null);
    try {
      const dataUri = await fileToBase64(uploadFile);
      const result = await uploadMedia(uploadFile.name, dataUri);
      onChange({ url: result.url, alt: value.alt });
      setUploadStatus("idle");
      setUploadFile(null);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed — is the backend reachable?");
      setUploadStatus("error");
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) return;
    setGenStatus("generating");
    setGenError(null);
    try {
      const result = await generatePoster(prompt, "");
      onChange({ url: result.image_url, alt: value.alt || prompt });
      setGenStatus("idle");
    } catch (err) {
      setGenError(err instanceof ApiError ? err.message : "Generation failed — is ComfyUI reachable?");
      setGenStatus("error");
    }
  }

  return (
    <div className="space-y-3">
      <div className="aspect-video w-full overflow-hidden rounded-lg border">
        <ThemeImageBox image={value} />
      </div>
      <Input
        value={value.alt}
        onChange={(event) => onChange({ ...value, alt: event.target.value })}
        placeholder="Alt text"
      />

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList className="w-full">
          <TabsTrigger value="url">URL</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
        </TabsList>

        <TabsContent value="url" className="space-y-2 pt-2">
          <Input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder="https://…" />
          <Button size="sm" onClick={() => onChange({ ...value, url: urlDraft || "#" })}>
            Use this URL
          </Button>
        </TabsContent>

        <TabsContent value="upload" className="space-y-2 pt-2">
          <FileDropzone
            file={uploadFile}
            onFileChange={setUploadFile}
            accept="image/*"
            label="Drag & drop an image, or click to browse"
            disabled={uploadStatus === "uploading"}
          />
          <Button size="sm" onClick={handleUpload} disabled={!uploadFile || uploadStatus === "uploading"}>
            Upload &amp; use
          </Button>
          {uploadStatus === "uploading" ? <LoadingSpinner label="Uploading…" /> : null}
          {uploadStatus === "error" && uploadError ? (
            <ErrorMessage description={uploadError} onRetry={() => setUploadStatus("idle")} />
          ) : null}
        </TabsContent>

        <TabsContent value="generate" className="space-y-2 pt-2">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the image to generate…"
            rows={3}
            disabled={genStatus === "generating"}
          />
          <Button size="sm" onClick={handleGenerate} disabled={!prompt.trim() || genStatus === "generating"}>
            Generate &amp; use
          </Button>
          {genStatus === "generating" ? (
            <LoadingSpinner label="Generating via ComfyUI — budget a minute or two…" />
          ) : null}
          {genStatus === "error" && genError ? (
            <ErrorMessage description={genError} onRetry={() => setGenStatus("idle")} />
          ) : null}
        </TabsContent>

        <TabsContent value="library" className="pt-2">
          {libraryStatus === "loading" ? <LoadingSpinner label="Loading…" /> : null}
          {libraryStatus === "error" ? (
            <ErrorMessage
              description="Could not load the media library."
              onRetry={() => {
                libraryFetched.current = false;
                handleTabChange("library");
              }}
            />
          ) : null}
          {libraryStatus === "idle" && libraryItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing here yet — uploaded and generated images will show up in this list.
            </p>
          ) : null}
          <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
            {libraryItems.map((item) => (
              <button
                key={item.url}
                type="button"
                onClick={() => onChange({ ...value, url: item.url })}
                className="aspect-square overflow-hidden rounded border hover:ring-2 hover:ring-primary"
                title={item.filename}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- library items can come from either backend, host unknown ahead of time, same as ThemeImageBox */}
                <img src={item.url} alt={item.filename} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
