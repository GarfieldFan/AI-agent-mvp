import { apiFetch } from "@/lib/api";

export type ModelOption = {
  provider: string;
  model: string;
  vision: boolean;
  configured: boolean;
  selectable: boolean;
  note: string | null;
};

export type ModelListResponse = {
  chat_models: ModelOption[];
  vision_models: ModelOption[];
};

export type ModelSettings = {
  chat_provider: string;
  chat_model: string;
  vision_provider: string;
  vision_model: string;
};

/** Admin/owner only — see backend/apis/model_settings.py. Ollama entries
 * are queried live (real installed models + real capabilities); cloud
 * provider entries are placeholders (their own configured default model,
 * `selectable: false` until an API key is set / until vision support
 * exists for that provider). */
export function listModels() {
  return apiFetch<ModelListResponse>("/api/agent/models");
}

export function getModelSettings() {
  return apiFetch<ModelSettings>("/api/agent/settings");
}

/** Persists globally — every visitor's /api/chat call and every
 * generate_landing_page call picks this up immediately, not just the
 * admin session that set it. */
export function updateModelSettings(settings: ModelSettings) {
  return apiFetch<ModelSettings>("/api/agent/settings", {
    method: "PUT",
    body: settings,
  });
}
