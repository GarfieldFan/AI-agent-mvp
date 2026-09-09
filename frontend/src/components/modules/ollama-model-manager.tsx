"use client";

import * as React from "react";
import { Check, Download, Trash2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { patchModelSettings } from "@/lib/models";
import {
  createCustomModel,
  deleteOllamaModel,
  downloadModelFromUrl,
  getDownloadStatus,
  getOllamaPullStatus,
  getOllamaStatus,
  getSuggestedOllamaModels,
  importCustomModel,
  listLocalModelFiles,
  pullOllamaModel,
  verifyInstalledModel,
  type CustomModelSpec,
  type DownloadStatus,
  type OllamaPullStatus,
  type SuggestedOllamaModel,
} from "@/lib/ollama";

/** Manages the bundled `ollama` docker-compose service — pick a
 * suggested model (downloads automatically), or bring your own GGUF
 * (paste a URL for the backend to fetch server-side, or point at a file
 * already dropped into `../models/`). Shared between `SetupWizard`'s
 * "install a local model" branch and `ModelSettingsPanel`'s dashboard
 * section — the exact same component either way, since managing models
 * is an ongoing dashboard task, not just a first-run onboarding step.
 * See backend/apis/ollama_admin.py's docstring for the full two-tier
 * "always tuned + verified, never a broken pick" design and why this
 * can be fully automated for Ollama specifically. */
export function OllamaModelManager({ onConnected }: { onConnected: () => void }) {
  const [suggested, setSuggested] = React.useState<SuggestedOllamaModel[] | null>(null);
  const [customModel, setCustomModel] = React.useState("");
  const [activeModel, setActiveModel] = React.useState<string | null>(null);
  const [pull, setPull] = React.useState<OllamaPullStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [unreachableDetail, setUnreachableDetail] = React.useState<string | null>(null);
  const [installedModels, setInstalledModels] = React.useState<string[] | null>(null);

  const refreshStatus = React.useCallback(() => {
    getOllamaStatus()
      .then((s) => {
        setUnreachableDetail(s.reachable ? null : s.detail ?? "The bundled Ollama service isn't reachable.");
        setInstalledModels(s.installed_models);
      })
      .catch(() => setUnreachableDetail(null)); // best-effort — don't block the UI over a transient check failure
  }, []);

  React.useEffect(() => {
    getSuggestedOllamaModels()
      .then(setSuggested)
      .catch(() => setSuggested([]));
    refreshStatus();
  }, [refreshStatus]);

  // Polls while a pull is in flight — setState only inside the interval
  // callback, never synchronously in the effect body, same pattern as
  // OrderPanel's own short-polling (see the root AGENTS.md).
  React.useEffect(() => {
    if (!activeModel || pull?.done) return;
    const id = setInterval(() => {
      getOllamaPullStatus(activeModel)
        .then(setPull)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [activeModel, pull?.done]);

  async function startPull(model: string) {
    setError(null);
    setActiveModel(model);
    setPull(null);
    try {
      const result = await pullOllamaModel(model);
      setPull(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the download.");
      setActiveModel(null);
    }
  }

  async function handleUseModel() {
    // pull.final_model is already proven to work — the backend only
    // ever reports it once a real chat completion against it succeeded
    // (the tuned variant if that worked, the plain pulled model
    // otherwise). No need to re-derive it from the model list.
    if (!pull?.final_model) return;
    try {
      await patchModelSettings({ chat_provider: "ollama", chat_model: pull.final_model });
      refreshStatus(); // the newly-pulled (and possibly tuned) model should now show up under "Already available"
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set that as the active model.");
    }
  }

  const [verifying, setVerifying] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  async function handleUseInstalled(model: string) {
    setError(null);
    setVerifying(model);
    try {
      const result = await verifyInstalledModel(model);
      if (!result.ok) {
        setError(result.error ?? `${model} doesn't behave like a working chat model.`);
        return;
      }
      await patchModelSettings({ chat_provider: "ollama", chat_model: model });
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't verify or set that model.");
    } finally {
      setVerifying(null);
    }
  }

  async function handleDeleteInstalled(model: string) {
    if (!window.confirm(`Delete ${model}? This frees its disk space but can't be undone — you'd need to download it again.`)) {
      return;
    }
    setError(null);
    setDeleting(model);
    try {
      const result = await deleteOllamaModel(model);
      if (!result.ok) {
        setError(result.error ?? `Couldn't delete ${model}.`);
        return;
      }
      refreshStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete that model.");
    } finally {
      setDeleting(null);
    }
  }

  const progressPct = pull && pull.total > 0 ? Math.round((pull.completed / pull.total) * 100) : null;

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <p className="text-xs text-muted-foreground">
        Downloads into this project&apos;s own bundled Ollama service — no separate install needed.
      </p>
      {unreachableDetail ? <ErrorMessage description={unreachableDetail} /> : null}

      {!activeModel ? (
        <>
          {installedModels && installedModels.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Already available (no download needed — pulled earlier, imported, or installed some other way)
              </p>
              <div className="flex flex-wrap gap-2">
                {installedModels.map((m) => (
                  <div key={m} className="flex items-center gap-0.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-r-none"
                      onClick={() => handleUseInstalled(m)}
                      disabled={verifying === m || deleting === m}
                    >
                      {verifying === m ? "Verifying…" : m}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-l-none px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteInstalled(m)}
                      disabled={verifying === m || deleting === m}
                      aria-label={`Delete ${m}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <p className="text-xs font-medium text-muted-foreground">Or download a new one</p>
          {suggested === null ? (
            <LoadingSpinner label="Loading suggestions…" />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {suggested.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => startPull(m.name)}
                  className="flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left text-xs hover:bg-muted"
                >
                  <span className="flex w-full items-center justify-between font-medium">
                    {m.name}
                    <Badge variant="outline" className="text-[10px]">
                      {m.size}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground">{m.description}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="Or type any Ollama model tag (e.g. mistral:7b)"
              className="sm:flex-1"
            />
            <Button variant="outline" onClick={() => customModel.trim() && startPull(customModel.trim())} disabled={!customModel.trim()}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
          </div>
          <CustomModelImport
            onConnected={() => {
              refreshStatus(); // the newly-imported model should now show up under "Already available"
              onConnected();
            }}
          />
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium">{activeModel}</p>
          {!pull || !pull.done ? (
            <>
              <p className="text-xs text-muted-foreground">{pull?.status || "Starting…"}</p>
              {progressPct !== null ? (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
                </div>
              ) : null}
            </>
          ) : pull.error ? (
            <ErrorMessage description={pull.error} onRetry={() => setActiveModel(null)} />
          ) : (
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm">
                {pull.tuned
                  ? "Downloaded and tuned for this app — ready to use."
                  : "Downloaded — ready to use."}
              </span>
              <Button size="sm" onClick={handleUseModel} className="ml-auto">
                Use this model
              </Button>
            </div>
          )}
        </div>
      )}
      {error ? <ErrorMessage description={error} onRetry={() => setError(null)} /> : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** "Bring your own" model file — either paste a URL for the BACKEND to
 * fetch server-side (the only practical way to get a file onto a
 * remote/EC2-style deployment with no shell access — mirrors this app's
 * own RAG-document URL-ingestion precedent), or point at a file already
 * dropped into `../models/` some other way. Either way, once the file
 * is on disk, tries Ollama's own default GGUF auto-detection first
 * (confirmed directly with the user as the right starting point); only
 * if that fails verification does it show an AI-drafted suggestion
 * (system/template/parameters) for the owner to review and apply —
 * never applied automatically, since there's no way to actually inspect
 * the GGUF's real architecture from here. */
function CustomModelImport({ onConnected }: { onConnected: () => void }) {
  const [files, setFiles] = React.useState<string[] | null>(null);
  const [importing, setImporting] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ filename: string; ok: boolean; model: string | null; error: string | null; suggestion: CustomModelSpec | null } | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  const [downloadUrl, setDownloadUrl] = React.useState("");
  const [download, setDownload] = React.useState<DownloadStatus | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  const refreshFiles = React.useCallback(() => {
    listLocalModelFiles()
      .then(setFiles)
      .catch(() => setFiles([]));
  }, []);

  React.useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // Polls the download while in flight — same pattern as
  // OllamaModelManager's own pull-status polling above.
  React.useEffect(() => {
    if (!download || download.done) return;
    const id = setInterval(() => {
      getDownloadStatus(download.filename)
        .then((s) => {
          setDownload(s);
          if (s.done && !s.error) refreshFiles(); // the new file is now importable below
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [download, refreshFiles]);

  async function handleStartDownload() {
    if (!downloadUrl.trim()) return;
    setDownloadError(null);
    setDownload(null);
    try {
      const status = await downloadModelFromUrl(downloadUrl.trim());
      setDownload(status);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : "Couldn't start the download.");
    }
  }

  async function handleImport(filename: string) {
    setImporting(filename);
    setResult(null);
    setApplyError(null);
    try {
      const res = await importCustomModel(filename);
      setResult({ filename, ...res });
    } catch (err) {
      setResult({
        filename,
        ok: false,
        model: null,
        error: err instanceof ApiError ? err.message : "Import failed.",
        suggestion: null,
      });
    } finally {
      setImporting(null);
    }
  }

  async function handleApplySuggestion() {
    if (!result?.suggestion) return;
    setApplying(true);
    setApplyError(null);
    try {
      const name = `${result.filename.replace(/\.[^.]+$/, "")}-custom`;
      const applied = await createCustomModel(result.filename, name, result.suggestion);
      if (!applied.ok) {
        setApplyError(applied.error ?? "Still couldn't get this model to respond correctly.");
        return;
      }
      setResult({ ...result, ok: true, model: applied.model, error: null });
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "Couldn't apply that suggestion.");
    } finally {
      setApplying(false);
    }
  }

  async function handleUseImported() {
    if (!result?.model) return;
    try {
      await patchModelSettings({ chat_provider: "ollama", chat_model: result.model });
      onConnected();
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "Couldn't set that as the active model.");
    }
  }

  const downloadPct =
    download && download.total ? Math.round((download.downloaded / download.total) * 100) : null;

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">Or bring your own model file</p>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          Paste a direct-download URL (e.g. a HuggingFace GGUF link) — the server downloads it for you,
          not your browser:
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={downloadUrl}
            onChange={(e) => setDownloadUrl(e.target.value)}
            placeholder="https://huggingface.co/.../model.gguf"
            className="sm:flex-1"
            disabled={!!download && !download.done}
          />
          <Button
            variant="outline"
            onClick={handleStartDownload}
            disabled={!downloadUrl.trim() || (!!download && !download.done)}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Download
          </Button>
        </div>
        {downloadError ? <ErrorMessage description={downloadError} onRetry={() => setDownloadError(null)} /> : null}
        {download ? (
          <div className="space-y-1 text-xs">
            {!download.done ? (
              <>
                <p className="text-muted-foreground">
                  {download.status} — {formatBytes(download.downloaded)}
                  {download.total ? ` of ${formatBytes(download.total)}` : ""}
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: downloadPct !== null ? `${downloadPct}%` : "100%" }}
                  />
                </div>
              </>
            ) : download.error ? (
              <ErrorMessage description={download.error} onRetry={() => setDownload(null)} />
            ) : (
              <p className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Downloaded {formatBytes(download.downloaded)} — pick it below to import.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Files ready in <code>models/</code> (see <code>models/README.md</code>):
        </p>
        {files === null ? (
          <LoadingSpinner label="Checking models/…" />
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {files.map((f) => (
              <Button key={f} variant="outline" size="sm" onClick={() => handleImport(f)} disabled={importing === f}>
                {importing === f ? "Importing…" : f}
              </Button>
            ))}
          </div>
        )}
      </div>

      {result?.ok ? (
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm">Imported and verified — ready to use.</span>
          <Button size="sm" onClick={handleUseImported} className="ml-auto">
            Use this model
          </Button>
        </div>
      ) : result && !result.ok ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3 text-xs">
          <ErrorMessage description={result.error ?? "Import failed."} />
          {result.suggestion ? (
            <>
              <p className="text-muted-foreground">
                Ollama&apos;s own default didn&apos;t work — here&apos;s an AI-drafted suggestion to try instead
                (review before applying; it&apos;s a best-effort guess, not a guarantee):
              </p>
              <pre className="overflow-auto rounded bg-muted p-2">{JSON.stringify(result.suggestion, null, 2)}</pre>
              <Button size="sm" onClick={handleApplySuggestion} disabled={applying}>
                {applying ? "Applying…" : "Apply this suggestion"}
              </Button>
              {applyError ? <ErrorMessage description={applyError} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
