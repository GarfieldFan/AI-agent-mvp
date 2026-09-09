import { apiFetch } from "@/lib/api";

/** Admin/owner management of the bundled `ollama` docker-compose service
 * (2026-09-09, backend/apis/ollama_admin.py) — the "install a local
 * model" half of the setup wizard. See that module's own docstring for
 * why this is scoped to Ollama specifically (its `/api/pull` already
 * does exactly this job; other self-hosted runtimes stay on the manual
 * `models/README.md` + "Custom endpoint" path). */
export type OllamaStatus = {
  reachable: boolean;
  installed_models: string[];
  detail: string | null;
};

export type SuggestedOllamaModel = {
  name: string;
  size: string;
  description: string;
};

export type OllamaPullStatus = {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
  /** The model to actually use once `done` — a lightly-tuned variant
   * (bumped context window) if that was created and verified with a
   * real chat completion, otherwise the plain pulled model. Always
   * something already proven to work; never a broken half-created
   * model. `null` until `done`. */
  final_model: string | null;
  tuned: boolean;
};

export type CustomModelSpec = {
  system?: string | null;
  template?: string | null;
  parameters?: Record<string, unknown> | null;
};

export type ImportCustomModelResult = {
  ok: boolean;
  model: string | null;
  error: string | null;
  /** A best-effort AI-drafted spec, present only when Ollama's own
   * default import attempt failed verification. Review before applying
   * via `createCustomModel` — never auto-applied. */
  suggestion: CustomModelSpec | null;
};

export type CreateCustomModelResult = {
  ok: boolean;
  model: string | null;
  error: string | null;
};

export function getOllamaStatus() {
  return apiFetch<OllamaStatus>("/api/agent/ollama/status");
}

/** Verifies a model that's ALREADY sitting in the bundled Ollama
 * instance (2026-09-09, `OllamaStatus.installed_models`) — something
 * pulled earlier, imported from a custom file, or installed some other
 * way entirely. Still runs a real chat-completion check before the
 * caller commits it as the active chat model, since "already
 * downloaded" isn't the same guarantee as "actually behaves like a
 * working chat model." */
export function verifyInstalledModel(model: string) {
  return apiFetch<{ ok: boolean; error: string | null }>("/api/agent/ollama/verify-installed", {
    method: "POST",
    body: { model },
  });
}

/** Owner-initiated deletion of a model already in the bundled Ollama
 * instance (2026-09-09) — disk-space cleanup for an owner who's tried
 * several models over time. */
export function deleteOllamaModel(model: string) {
  return apiFetch<{ ok: boolean; error: string | null }>("/api/agent/ollama/delete-model", {
    method: "POST",
    body: { model },
  });
}

export function getSuggestedOllamaModels() {
  return apiFetch<SuggestedOllamaModel[]>("/api/agent/ollama/suggested-models");
}

/** Starts a background pull on the backend and returns immediately —
 * poll `getOllamaPullStatus` for progress. 409s if that model is already
 * being pulled. */
export function pullOllamaModel(model: string) {
  return apiFetch<OllamaPullStatus>("/api/agent/ollama/pull", {
    method: "POST",
    body: { model },
  });
}

export function getOllamaPullStatus(model: string) {
  return apiFetch<OllamaPullStatus>(`/api/agent/ollama/pull-status?model=${encodeURIComponent(model)}`);
}

/** Files in ../models/ (see models/README.md) visible to both this
 * backend and the bundled `ollama` service, worth offering to import. */
export function listLocalModelFiles() {
  return apiFetch<string[]>("/api/agent/ollama/local-files");
}

/** Tries Ollama's own default GGUF import first; only on failure does it
 * ask the currently-configured chat provider for a best-effort spec
 * suggestion (never applied automatically — pass it to
 * `createCustomModel` after review). */
export function importCustomModel(filename: string, name?: string) {
  return apiFetch<ImportCustomModelResult>("/api/agent/ollama/import-custom", {
    method: "POST",
    body: { filename, name },
  });
}

export function createCustomModel(filename: string, name: string, spec: CustomModelSpec) {
  return apiFetch<CreateCustomModelResult>("/api/agent/ollama/create-custom", {
    method: "POST",
    body: { filename, name, ...spec },
  });
}

/** Server-side download (2026-09-09) — the owner pastes a URL (e.g. a
 * HuggingFace direct-download link) and the BACKEND fetches it directly
 * into `../models/`, not the browser. The only practical way to get a
 * model file onto a remote/EC2-style deployment with no shell access —
 * mirrors this app's own already-established RAG-document URL-ingestion
 * pattern. Poll `getDownloadStatus` for real byte-level progress. */
export type DownloadStatus = {
  filename: string;
  status: string;
  downloaded: number;
  /** `null` when the source doesn't report a size — show a byte counter
   * instead of a percentage bar in that case. */
  total: number | null;
  done: boolean;
  error: string | null;
};

export function downloadModelFromUrl(url: string, filename?: string) {
  return apiFetch<DownloadStatus>("/api/agent/ollama/download-from-url", {
    method: "POST",
    body: { url, filename },
  });
}

export function getDownloadStatus(filename: string) {
  return apiFetch<DownloadStatus>(`/api/agent/ollama/download-status?filename=${encodeURIComponent(filename)}`);
}
