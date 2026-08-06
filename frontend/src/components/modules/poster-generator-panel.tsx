"use client";

import * as React from "react";
import { ImagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { ApiError } from "@/lib/api";
import { generatePoster } from "@/lib/poster";
import { getIntegrations } from "@/lib/integrations";

/** Real as of 2026-08-04 — text prompt (+ optional overlay text) ->
 * ComfyUI txt2img -> optional real-rendered-text overlay, via
 * backend/apis/agent.py's `generate_poster`. A direct, deterministic
 * pipeline call, no LLM/agent reasoning involved (see the root AGENTS.md
 * for why that distinction mattered for where this ended up living —
 * admin-only structured request, not a chatbot command). Checks ComfyUI
 * reachability once on mount (same `lib/integrations.ts` check the
 * dashboard's capability grid uses) and disables "Generate" with an
 * explanation if it's down, instead of only failing after submit. */
export function PosterGeneratorPanel() {
  const [prompt, setPrompt] = React.useState("");
  const [overlayText, setOverlayText] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [comfyUnavailable, setComfyUnavailable] = React.useState<string | null>(null);

  React.useEffect(() => {
    getIntegrations()
      .then((result) => {
        setComfyUnavailable(
          result.comfyui.available ? null : `ComfyUI isn't reachable (${result.comfyui.detail ?? "unknown error"}).`,
        );
      })
      .catch(() => setComfyUnavailable(null)); // best-effort — don't block the form over a failed check itself
  }, []);

  async function handleGenerate() {
    if (!prompt.trim()) return;
    setStatus("loading");
    setError(null);
    try {
      const result = await generatePoster(prompt, overlayText);
      setImageUrl(result.image_url);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Generation failed — is the backend reachable?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Generate a poster</h3>
        <p className="text-xs text-muted-foreground">
          Text-to-image via ComfyUI, with an optional real text overlay. Slow — budget up to a
          few minutes depending on the GPU.
        </p>
      </div>

      {comfyUnavailable ? <ErrorMessage description={comfyUnavailable} /> : null}

      <div className="space-y-3">
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the image — e.g. a modern minimalist tech office, bright natural light"
          className="min-h-20"
          disabled={status === "loading"}
        />
        <Input
          value={overlayText}
          onChange={(event) => setOverlayText(event.target.value)}
          placeholder="Overlay text (optional) — e.g. We're Hiring"
          disabled={status === "loading"}
        />
      </div>

      <Button
        onClick={handleGenerate}
        disabled={!prompt.trim() || status === "loading" || Boolean(comfyUnavailable)}
      >
        <ImagePlus className="size-4" />
        {status === "loading" ? "Generating…" : "Generate"}
      </Button>

      {status === "loading" ? (
        <LoadingSpinner label="Submitting to ComfyUI and waiting for it to finish…" />
      ) : null}
      {status === "error" && error ? (
        <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
      ) : null}

      {imageUrl && status === "idle" ? (
        // Remote image from ComfyUI's own /view endpoint — no host to
        // allowlist ahead of time, same reasoning as ThemeImageBox using a
        // plain <img> instead of next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="Generated poster" className="max-w-full rounded-lg border" />
      ) : null}
    </div>
  );
}
