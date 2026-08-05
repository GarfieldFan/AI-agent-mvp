"use client";

import * as React from "react";
import { Upload, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type FileDropzoneProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Native `<input accept>` filter, e.g. `"image/*"`. */
  accept?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
};

/** Drag-and-drop file picker with click-to-browse as a fallback — first
 * built for `PageGeneratorPanel`'s design-image upload (a plain `<input
 * type="file">` was fiddly to use for that), kept generic enough to reuse
 * anywhere else a file needs picking (poster generation, document ingest,
 * ...). Shows an image preview via a local blob URL when the picked file
 * is an image; otherwise just the filename. */
export function FileDropzone({
  file,
  onFileChange,
  accept,
  label = "Drag & drop a file here, or click to browse",
  disabled = false,
  className,
}: FileDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  // Derived from `file`, not separate state — computed during render, and
  // the effect below only ever handles the cleanup side effect (revoking
  // the previous blob URL), never a setState call, which is what actually
  // avoids the `react-hooks/set-state-in-effect` cascading-render warning
  // this tripped when previewUrl was its own useState+useEffect pair.
  const previewUrl = React.useMemo(() => {
    if (!file || !file.type.startsWith("image/")) return null;
    return URL.createObjectURL(file);
  }, [file]);

  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function pickFile(fileList: FileList | null) {
    onFileChange(fileList?.[0] ?? null);
  }

  function openBrowser() {
    if (!disabled) inputRef.current?.click();
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={openBrowser}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openBrowser();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        if (!disabled) pickFile(event.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
        isDragging ? "border-primary bg-primary/5" : "border-input hover:bg-muted/40",
        disabled && "pointer-events-none cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => pickFile(event.target.files)}
      />

      {previewUrl ? (
        // Local blob: preview URL, not a remote image — next/image doesn't
        // apply here (no host to allowlist, nothing to optimize).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="Selected file preview" className="max-h-40 rounded-lg object-contain" />
      ) : (
        <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
      )}

      {file ? (
        <div className="flex max-w-full items-center gap-1.5 text-sm">
          <span className="truncate">{file.name}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove file"
            onClick={(event) => {
              event.stopPropagation();
              onFileChange(null);
            }}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{label}</p>
      )}
    </div>
  );
}
