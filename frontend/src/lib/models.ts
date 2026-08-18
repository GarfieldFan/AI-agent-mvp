import { apiFetch } from "@/lib/api";

export type ModelOption = {
  provider: string;
  model: string;
  vision: boolean;
  configured: boolean;
  selectable: boolean;
  note: string | null;
};

export type ComfyUIAssetOptions = {
  unets: string[];
  clips: string[];
  vaes: string[];
};

export type ModelListResponse = {
  chat_models: ModelOption[];
  vision_models: ModelOption[];
  embedding_models: ModelOption[];
  // One ModelOption per *provider* (comfyui/openai/gemini), not per
  // model — `model` holds a fixed, non-editable label since there's no
  // per-provider model choice to make for image-gen this round.
  image_providers: ModelOption[];
  // Only meaningful when image_provider is "comfyui" — the actual files
  // ComfyUI currently reports for its unet/clip/vae loader widgets (see
  // backend/providers/comfyui.py), live-queried the same way custom
  // chat/embedding models are.
  image_comfyui_assets: ComfyUIAssetOptions;
};

export type ModelSettings = {
  chat_provider: string;
  chat_model: string;
  vision_provider: string;
  vision_model: string;
  embedding_provider: string;
  embedding_model: string;
  // Informational only, returned by GET — the actual length of the last
  // successfully computed vector, not settable by the client.
  embedding_dimensions?: number | null;
  // Only meaningful when chat_provider or vision_provider is "custom"
  // (they share one endpoint config). Embedding has its own, separate
  // endpoint below — a real local setup runs chat/vision and embedding
  // as two different llama.cpp processes (embedding mode is a
  // process-level flag, can't share a router instance with a chat
  // model), see backend/apis/model_settings.py. custom_base_url is
  // returned by GET so the picker can prefill it; custom_api_key is
  // write-only (never returned once saved).
  custom_base_url?: string | null;
  custom_api_key?: string | null;
  // Only meaningful when embedding_provider is "custom" — deliberately
  // separate from custom_base_url/custom_api_key above.
  embedding_base_url?: string | null;
  embedding_api_key?: string | null;
  image_provider: string;
  // Only meaningful when image_provider is "comfyui" — a separate
  // endpoint config from custom_base_url above (ComfyUI isn't OpenAI-
  // compatible, so it can't share the chat/embedding custom endpoint).
  image_comfyui_url?: string | null;
  // Checkpoint choice within ComfyUI itself — only meaningful when
  // image_provider is "comfyui". null/undefined means "use the fixed
  // workflow's own default file" for that slot.
  image_comfyui_unet?: string | null;
  image_comfyui_clip?: string | null;
  image_comfyui_vae?: string | null;
  // An owner-pasted ComfyUI "Save (API Format)" workflow — when set,
  // REPLACES the fixed workflow + unet/clip/vae fields above (any
  // checkpoint architecture, not just the built-in one). prompt_node is
  // required whenever workflow is set; prompt_field defaults to "text"
  // server-side when left blank.
  image_comfyui_workflow?: string | null;
  image_comfyui_prompt_node?: string | null;
  image_comfyui_prompt_field?: string | null;
};

export type CustomProviderTestResult = {
  ok: boolean;
  models: string[];
  // Subset of `models` the endpoint reports as vision-capable (via
  // `architecture.input_modalities`) — feeds the vision dropdown's merge,
  // separate from `models` since chat/embedding accept every tested
  // model regardless of vision support.
  vision_model_ids: string[];
  error: string | null;
};

/** Admin/owner only — see backend/apis/model_settings.py. Ollama and
 * custom entries are queried live (real installed models + real
 * capabilities); cloud provider entries use their configured default
 * model, `selectable: false` until an API key is set. Vision is a third,
 * independent list — every provider that can do vision at all is
 * selectable there too (2026-08-18, no longer Ollama-only). */
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

/** Probes an arbitrary OpenAI-compatible endpoint (llama.cpp, vLLM, ...)
 * and returns what models it currently reports — doesn't persist
 * anything, see the "Test connection" flow in model-settings-panel.tsx. */
export function testCustomProvider(baseUrl: string, apiKey?: string) {
  return apiFetch<CustomProviderTestResult>("/api/agent/models/test-custom", {
    method: "POST",
    body: { base_url: baseUrl, api_key: apiKey || null },
  });
}
