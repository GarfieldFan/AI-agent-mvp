"use client";

import * as React from "react";
import { Check, ChevronDown, CircleAlert, Eye, Save, Plug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { OllamaModelManager } from "@/components/modules/ollama-model-manager";
import { ApiError } from "@/lib/api";
import {
  getModelSettings,
  listModels,
  testChatCompletion,
  testCustomProvider,
  updateModelSettings,
  type ComfyUIAssetOptions,
  type ModelOption,
  type ModelSettings,
} from "@/lib/models";

function optionKey(provider: string, model: string) {
  return `${provider}::${model}`;
}

function parseKey(key: string): [string, string] {
  const [provider, model] = key.split("::");
  return [provider, model];
}

/** Overlays freshly test-connection'd custom models on top of whatever
 * `listModels()` already returned (which itself may already include
 * "custom" entries from a previously-saved endpoint) — the fresher list
 * wins per model id. */
function mergeCustomModels(base: ModelOption[], custom: ModelOption[]): ModelOption[] {
  if (custom.length === 0) return base;
  const customKeys = new Set(custom.map((m) => optionKey(m.provider, m.model)));
  return [...base.filter((m) => !customKeys.has(optionKey(m.provider, m.model))), ...custom];
}

/** True when `value` doesn't match a currently `selectable` entry in
 * `options` — either the provider's live query came back empty (e.g.
 * Ollama unreachable — its entries just don't appear at all, see
 * backend/apis/model_settings.py's _query_ollama_models) or the entry is
 * there but `selectable: false` (e.g. a cloud provider with no API key
 * set). Either way, the currently-saved pick can't actually be used
 * right now. Page-load-time only — this project is deliberately REST
 * only, no WebSocket/polling (see the root AGENTS.md), so this reflects
 * whatever `listModels()` returned on the last load/refresh, not a live
 * push. */
function isUnavailable(options: ModelOption[], value: string): boolean {
  if (!value) return false;
  return !options.some((o) => optionKey(o.provider, o.model) === value && o.selectable);
}

function UnavailableWarning({ optionKeyValue }: { optionKeyValue: string }) {
  const [provider, model] = parseKey(optionKeyValue);
  return (
    <p className="text-xs text-destructive">
      Currently selected ({provider} / {model}) isn&apos;t reachable right now — it won&apos;t show as an
      option below. Reload after fixing the connection, or pick a different model to change it.
    </p>
  );
}

/** Collapsed by default unless `defaultOpen` says the section is
 * already relevant to what's currently configured (e.g. a "custom"
 * endpoint block when chat/vision is already set to "custom") — 2026-09-09,
 * per direct user feedback that this panel had grown too dense,
 * permanently showing every provider's own config regardless of what's
 * actually in use. `defaultOpen` only sets the INITIAL state (a later
 * dropdown change doesn't fight a user who explicitly opened/closed
 * this themselves) — same "advanced, collapsed unless already active"
 * pattern `setup-wizard.tsx`'s own "Advanced" section already
 * established. */
function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        {title}
      </button>
      {open ? <div className="mt-2 space-y-2">{children}</div> : null}
    </div>
  );
}

type CapabilityStatus = "ok" | "unavailable" | "unset";

function capabilityStatus(options: ModelOption[], value: string): CapabilityStatus {
  if (!value) return "unset";
  return options.some((o) => optionKey(o.provider, o.model) === value && o.selectable) ? "ok" : "unavailable";
}

/** One line of the "at a glance" status summary (2026-09-09, added per
 * direct user feedback: this panel had no single place that told an
 * owner "is my chat model actually working right now" without parsing
 * four separate dropdowns themselves). Purely derived from data this
 * panel already fetches (`chatOptions`/etc. vs. the current dropdown
 * value) — no extra request. */
function StatusLine({ label, status, value }: { label: string; status: CapabilityStatus; value: string }) {
  const [provider, model] = value ? parseKey(value) : ["", ""];
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 font-medium text-muted-foreground">{label}</span>
      {status === "ok" ? (
        <span className="flex min-w-0 items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {provider} / {model}
          </span>
        </span>
      ) : status === "unavailable" ? (
        <span className="flex min-w-0 items-center gap-1 text-destructive">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {provider} / {model} — not reachable
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
    </div>
  );
}

function ModelSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: ModelOption[];
  value: string;
  onChange: (key: string) => void;
  disabled: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)} disabled={disabled}>
      <SelectTrigger className="w-full sm:w-80">
        <SelectValue placeholder="Choose a model…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => {
          const key = optionKey(opt.provider, opt.model);
          return (
            <SelectItem key={key} value={key} disabled={!opt.selectable}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">
                  {opt.provider} / {opt.model}
                </span>
                {opt.vision ? (
                  <Eye className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
                {!opt.configured ? (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    Not configured
                  </Badge>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** A single-file picker for one of ComfyUI's checkpoint loader widgets
 * (unet/clip/vae — see providers/comfyui.py) — a plain string list from
 * `ComfyUIAssetOptions`, not a `ModelOption` list, since these aren't
 * separately-configured providers, just files ComfyUI itself already
 * reports as available. Empty `value` means "use the workflow's own
 * default file for this slot." */
function ComfyUIAssetSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Select
      value={value || "__default__"}
      onValueChange={(v) => v && onChange(v === "__default__" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full sm:w-64">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__default__">{label} (workflow default)</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Base URL + optional API key + "Test connection" for an arbitrary
 * OpenAI-compatible backend (llama.cpp's `llama-server`, vLLM, LM
 * Studio, ...) — see backend/providers/custom.py. Rendered twice: once
 * shared by chat+vision, once for embedding alone (2026-08-18 — these
 * used to share one endpoint config, split apart because a real local
 * setup runs embedding as its own llama.cpp process, since embedding
 * mode is a process-level flag that can't coexist with a chat model in
 * the same router instance). A successful test reports the model ids
 * that server currently has loaded via `onModels`, which the parent
 * merges into whichever dropdown(s) this instance feeds — chat/embedding
 * accept every tested model regardless of capability (a llama.cpp-style
 * `/models` listing doesn't distinguish chat vs. embedding models);
 * vision only accepts the subset the endpoint itself reports as
 * vision-capable (via `architecture.input_modalities`, see
 * `ModelOption.vision` on each returned option). */
function CustomEndpointBlock({
  baseUrl,
  onBaseUrlChange,
  apiKey,
  onApiKeyChange,
  hasSavedKey,
  onModels,
  disabled,
  scopeLabel,
}: {
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  hasSavedKey: boolean;
  onModels: (models: ModelOption[]) => void;
  disabled: boolean;
  /** e.g. "chat, or vision" / "embedding" — feeds the "Pick one from the
   * ... model list above" confirmation line. */
  scopeLabel: string;
}) {
  const [status, setStatus] = React.useState<"idle" | "testing" | "ok" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState(0);

  // Editing either field invalidates the last test result — otherwise a
  // stale "All connection attempts failed" from the old value keeps
  // showing after a fix, and it's easy to mistake it for a fresh retry
  // that's still failing (bit this exact project this session).
  function resetStatus() {
    setStatus("idle");
    setError(null);
  }

  async function handleTest() {
    if (!baseUrl.trim()) {
      setStatus("error");
      setError("Enter a base URL first (e.g. http://localhost:8080/v1).");
      return;
    }
    setStatus("testing");
    setError(null);
    try {
      const result = await testCustomProvider(baseUrl.trim(), apiKey.trim() || undefined);
      if (!result.ok) {
        setStatus("error");
        setError(result.error ?? "Couldn't reach that endpoint.");
        onModels([]);
        return;
      }
      setStatus("ok");
      setCount(result.models.length);
      const visionIds = new Set(result.vision_model_ids);
      onModels(
        result.models.map((model) => ({
          provider: "custom",
          model,
          vision: visionIds.has(model),
          configured: true,
          selectable: true,
          note: null,
        })),
      );
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Couldn't reach that endpoint.");
      onModels([]);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Custom endpoint — any OpenAI-compatible server (llama.cpp, vLLM, ...)
      </p>
      <p className="text-xs text-muted-foreground">
        Running it on this machine? <code>localhost</code>/<code>127.0.0.1</code> works — this backend runs
        inside Docker and automatically routes those to your machine (<code>host.docker.internal</code>).
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={baseUrl}
          onChange={(e) => {
            onBaseUrlChange(e.target.value);
            resetStatus();
          }}
          placeholder="http://localhost:8080/v1"
          disabled={disabled}
          className="sm:w-64"
        />
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => {
            onApiKeyChange(e.target.value);
            resetStatus();
          }}
          placeholder={hasSavedKey ? "API key (leave blank to keep saved key)" : "API key (optional)"}
          disabled={disabled}
          className="sm:w-64"
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleTest}
          disabled={disabled || status === "testing"}
        >
          <Plug className="size-4" />
          {status === "testing" ? "Testing…" : "Test connection"}
        </Button>
      </div>
      {status === "ok" ? (
        <p className="text-xs text-muted-foreground">
          Connected — found {count} model{count === 1 ? "" : "s"}. Pick one from the {scopeLabel} model
          list above.
        </p>
      ) : null}
      {status === "error" && error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Owner-facing AI model picker (backend/apis/model_settings.py). Three
 * independent selections — chat (public /api/chat + RAG answers), vision
 * (generate_landing_page + chat image-attachment analysis), and
 * embedding (knowledge-base ingestion) — because most local models only
 * have one of these capabilities (see the size 3 `Eye` icon marking
 * which chat models also happen to support vision, informational only
 * there). All three go through the same `ChatProvider`/`EmbeddingProvider`
 * abstraction (2026-08-18) — every provider (Ollama, custom, OpenAI,
 * Anthropic, Gemini) is selectable wherever it's actually configured and
 * capable, not just Ollama. Saving is global and immediate — it changes
 * what every visitor's chat and every future landing-page generation
 * uses, not just this admin session. */
/** One password input per cloud vendor (2026-09-09) — a single key per
 * vendor covers chat+vision+embedding+image-gen alike (matches how each
 * vendor's own API actually works), so this is intentionally separate
 * from the chat/vision/embedding pickers below rather than repeated per
 * capability. Same write-only-secret UX as `CustomEndpointBlock`'s own
 * key field (a `hasSavedKey`-driven placeholder, no dedicated "Test
 * connection" — saving and then picking a model from the dropdowns
 * above/below is the confirmation: a "Not configured" badge disappears
 * once the key is actually accepted). Previously these were env-var-only
 * (`OPENAI_API_KEY`/etc.) — still supported as a fallback, this doesn't
 * remove that path, it just adds a no-restart alternative (see
 * `backend/providers/openai.py`'s docstring). */
type CloudVendor = "openai" | "anthropic" | "gemini";

const CLOUD_VENDOR_OPTIONS: { value: CloudVendor; label: string; placeholder: string }[] = [
  { value: "openai", label: "OpenAI", placeholder: "sk-…" },
  { value: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { value: "gemini", label: "Gemini", placeholder: "AIza…" },
];

/** A vendor `Select` + a single password `Input` for whichever vendor is
 * currently picked (2026-09-09, simplified from three always-visible
 * inputs side by side per direct user feedback) — each vendor's typed
 * value is still tracked independently (switching the dropdown and back
 * doesn't lose what was typed for the other one), this just changes
 * which one is shown at a time. */
function CloudApiKeysBlock({
  openaiKey,
  onOpenaiKeyChange,
  hasSavedOpenaiKey,
  anthropicKey,
  onAnthropicKeyChange,
  hasSavedAnthropicKey,
  geminiKey,
  onGeminiKeyChange,
  hasSavedGeminiKey,
  disabled,
}: {
  openaiKey: string;
  onOpenaiKeyChange: (v: string) => void;
  hasSavedOpenaiKey: boolean;
  anthropicKey: string;
  onAnthropicKeyChange: (v: string) => void;
  hasSavedAnthropicKey: boolean;
  geminiKey: string;
  onGeminiKeyChange: (v: string) => void;
  hasSavedGeminiKey: boolean;
  disabled: boolean;
}) {
  const [vendor, setVendor] = React.useState<CloudVendor>("openai");

  const byVendor: Record<CloudVendor, { value: string; onChange: (v: string) => void; hasSaved: boolean }> = {
    openai: { value: openaiKey, onChange: onOpenaiKeyChange, hasSaved: hasSavedOpenaiKey },
    anthropic: { value: anthropicKey, onChange: onAnthropicKeyChange, hasSaved: hasSavedAnthropicKey },
    gemini: { value: geminiKey, onChange: onGeminiKeyChange, hasSaved: hasSavedGeminiKey },
  };
  const current = byVendor[vendor];
  const currentOption = CLOUD_VENDOR_OPTIONS.find((o) => o.value === vendor)!;

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground">Cloud provider API keys</p>
      <p className="text-xs text-muted-foreground">
        One key per vendor covers chat, vision, embedding, and image generation for that vendor.
        Saved here, not in an env var — takes effect immediately, no restart.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={vendor} onValueChange={(v) => v && setVendor(v as CloudVendor)} disabled={disabled}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLOUD_VENDOR_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
                {byVendor[o.value].hasSaved ? " (saved)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="password"
          value={current.value}
          onChange={(e) => current.onChange(e.target.value)}
          placeholder={current.hasSaved ? "•••••••• (leave blank to keep)" : currentOption.placeholder}
          disabled={disabled}
          className="sm:flex-1"
        />
      </div>
    </div>
  );
}

export function ModelSettingsPanel() {
  const [chatModels, setChatModels] = React.useState<ModelOption[] | null>(null);
  const [visionModels, setVisionModels] = React.useState<ModelOption[] | null>(null);
  const [embeddingModels, setEmbeddingModels] = React.useState<ModelOption[] | null>(null);
  const [imageProviders, setImageProviders] = React.useState<ModelOption[] | null>(null);
  const [chatValue, setChatValue] = React.useState("");
  const [visionValue, setVisionValue] = React.useState("");
  const [embeddingValue, setEmbeddingValue] = React.useState("");
  const [imageValue, setImageValue] = React.useState("");
  const [imageComfyuiUrl, setImageComfyuiUrl] = React.useState("");
  const [imageComfyuiUnet, setImageComfyuiUnet] = React.useState("");
  const [imageComfyuiClip, setImageComfyuiClip] = React.useState("");
  const [imageComfyuiVae, setImageComfyuiVae] = React.useState("");
  const [imageComfyuiAssets, setImageComfyuiAssets] = React.useState<ComfyUIAssetOptions>({
    unets: [],
    clips: [],
    vaes: [],
  });
  // Owner-pasted custom ComfyUI workflow (2026-08-19) — set together,
  // replaces the unet/clip/vae pickers above entirely when non-empty.
  const [imageComfyuiWorkflow, setImageComfyuiWorkflow] = React.useState("");
  const [imageComfyuiPromptNode, setImageComfyuiPromptNode] = React.useState("");
  const [imageComfyuiPromptField, setImageComfyuiPromptField] = React.useState("");

  // Local resource coordination (2026-08-19, backend/resource_broker.py)
  // — only meaningful alongside ComfyUI + a custom llama.cpp chat/vision
  // endpoint, off by default.
  const [resourceCoordinationEnabled, setResourceCoordinationEnabled] = React.useState(false);
  const [resourceCoordinationHeadroomMb, setResourceCoordinationHeadroomMb] = React.useState("4096");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [testChatStatus, setTestChatStatus] = React.useState<"idle" | "sending" | "error">("idle");
  const [testChatReply, setTestChatReply] = React.useState<string | null>(null);
  const [testChatError, setTestChatError] = React.useState<string | null>(null);

  const [openaiApiKeyInput, setOpenaiApiKeyInput] = React.useState("");
  const [hasSavedOpenaiKey, setHasSavedOpenaiKey] = React.useState(false);
  const [anthropicApiKeyInput, setAnthropicApiKeyInput] = React.useState("");
  const [hasSavedAnthropicKey, setHasSavedAnthropicKey] = React.useState(false);
  const [geminiApiKeyInput, setGeminiApiKeyInput] = React.useState("");
  const [hasSavedGeminiKey, setHasSavedGeminiKey] = React.useState(false);

  const [customBaseUrl, setCustomBaseUrl] = React.useState("");
  const [customApiKey, setCustomApiKey] = React.useState("");
  const [hasSavedCustomKey, setHasSavedCustomKey] = React.useState(false);
  const [customModels, setCustomModels] = React.useState<ModelOption[]>([]);

  // Embedding's own endpoint config — separate from chat/vision's above
  // (2026-08-18, see CustomEndpointBlock's docstring for why).
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = React.useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = React.useState("");
  const [hasSavedEmbeddingKey, setHasSavedEmbeddingKey] = React.useState(false);
  const [embeddingCustomModels, setEmbeddingCustomModels] = React.useState<ModelOption[]>([]);

  const refresh = React.useCallback(() => {
    Promise.all([listModels(), getModelSettings()])
      .then(([models, settings]) => {
        setChatModels(models.chat_models);
        setVisionModels(models.vision_models);
        setEmbeddingModels(models.embedding_models);
        setImageProviders(models.image_providers);
        setChatValue(optionKey(settings.chat_provider, settings.chat_model));
        setVisionValue(optionKey(settings.vision_provider, settings.vision_model));
        setEmbeddingValue(optionKey(settings.embedding_provider, settings.embedding_model));
        // image_providers has one ModelOption per provider (fixed model
        // label, no per-provider model choice — see lib/models.ts) —
        // find the one matching the saved provider to build the same
        // "provider::model" key ModelSelect expects.
        const matchedImage = models.image_providers.find((m) => m.provider === settings.image_provider);
        setImageValue(optionKey(settings.image_provider, matchedImage?.model ?? ""));
        setImageComfyuiUrl(settings.image_comfyui_url ?? "");
        setImageComfyuiUnet(settings.image_comfyui_unet ?? "");
        setImageComfyuiClip(settings.image_comfyui_clip ?? "");
        setImageComfyuiVae(settings.image_comfyui_vae ?? "");
        setImageComfyuiAssets(models.image_comfyui_assets);
        setImageComfyuiWorkflow(settings.image_comfyui_workflow ?? "");
        setImageComfyuiPromptNode(settings.image_comfyui_prompt_node ?? "");
        setImageComfyuiPromptField(settings.image_comfyui_prompt_field ?? "");
        setResourceCoordinationEnabled(settings.resource_coordination_enabled);
        setResourceCoordinationHeadroomMb(String(settings.resource_coordination_headroom_mb));
        setHasSavedOpenaiKey(settings.openai_api_key_set ?? false);
        setOpenaiApiKeyInput("");
        setHasSavedAnthropicKey(settings.anthropic_api_key_set ?? false);
        setAnthropicApiKeyInput("");
        setHasSavedGeminiKey(settings.gemini_api_key_set ?? false);
        setGeminiApiKeyInput("");
        setCustomBaseUrl(settings.custom_base_url ?? "");
        setHasSavedCustomKey(
          (settings.chat_provider === "custom" || settings.vision_provider === "custom") &&
            !!settings.custom_base_url,
        );
        setCustomApiKey("");
        setCustomModels([]);
        setEmbeddingBaseUrl(settings.embedding_base_url ?? "");
        setHasSavedEmbeddingKey(settings.embedding_provider === "custom" && !!settings.embedding_base_url);
        setEmbeddingApiKey("");
        setEmbeddingCustomModels([]);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load model settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const chatOptions = React.useMemo(
    () => mergeCustomModels(chatModels ?? [], customModels),
    [chatModels, customModels],
  );
  const visionOptions = React.useMemo(
    () => mergeCustomModels(visionModels ?? [], customModels.filter((m) => m.vision)),
    [visionModels, customModels],
  );
  const embeddingOptions = React.useMemo(
    () => mergeCustomModels(embeddingModels ?? [], embeddingCustomModels),
    [embeddingModels, embeddingCustomModels],
  );

  async function handleSave() {
    const [chat_provider, chat_model] = parseKey(chatValue);
    const [vision_provider, vision_model] = parseKey(visionValue);
    const [embedding_provider, embedding_model] = parseKey(embeddingValue);
    const [image_provider] = parseKey(imageValue);
    const payload: ModelSettings = {
      chat_provider,
      chat_model,
      vision_provider,
      vision_model,
      embedding_provider,
      embedding_model,
      image_provider,
      image_comfyui_url: imageComfyuiUrl.trim() || null,
      image_comfyui_unet: imageComfyuiUnet.trim() || null,
      image_comfyui_clip: imageComfyuiClip.trim() || null,
      image_comfyui_vae: imageComfyuiVae.trim() || null,
      image_comfyui_workflow: imageComfyuiWorkflow.trim() || null,
      image_comfyui_prompt_node: imageComfyuiPromptNode.trim() || null,
      image_comfyui_prompt_field: imageComfyuiPromptField.trim() || null,
      resource_coordination_enabled: resourceCoordinationEnabled,
      resource_coordination_headroom_mb: Number(resourceCoordinationHeadroomMb) || 4096,
      openai_api_key: openaiApiKeyInput.trim() || undefined,
      anthropic_api_key: anthropicApiKeyInput.trim() || undefined,
      gemini_api_key: geminiApiKeyInput.trim() || undefined,
    };
    if (chat_provider === "custom" || vision_provider === "custom") {
      payload.custom_base_url = customBaseUrl.trim();
      payload.custom_api_key = customApiKey.trim() || undefined;
    }
    if (embedding_provider === "custom") {
      payload.embedding_base_url = embeddingBaseUrl.trim();
      payload.embedding_api_key = embeddingApiKey.trim() || undefined;
    }

    setSaveStatus("saving");
    setSaveError(null);
    try {
      await updateModelSettings(payload);
      setSaveStatus("saved");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Failed to save model settings.");
      setSaveStatus("error");
    }
  }

  /** Sends one real chat completion through the SAVED chat provider/model
   * (2026-09-09) — proves a just-saved cloud API key (or any other pick)
   * actually works, rather than an owner finding out only when a real
   * visitor's chat turn fails. Reflects the saved config, not an
   * in-progress edit above — save first if something was just changed. */
  async function handleTestChat() {
    setTestChatStatus("sending");
    setTestChatError(null);
    setTestChatReply(null);
    try {
      const result = await testChatCompletion("Reply with just the word OK.");
      setTestChatReply(result.reply);
      setTestChatStatus("idle");
    } catch (err) {
      setTestChatError(err instanceof ApiError ? err.message : "Test failed — is the backend reachable?");
      setTestChatStatus("error");
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!chatModels || !visionModels || !embeddingModels || !imageProviders) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading available models…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">AI model selection</h3>
        <p className="text-xs text-muted-foreground">
          Applies globally and immediately — every visitor&apos;s chat message and every future
          landing-page generation uses whatever&apos;s selected here.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <StatusLine label="Chat" status={capabilityStatus(chatOptions, chatValue)} value={chatValue} />
        <StatusLine label="Vision" status={capabilityStatus(visionOptions, visionValue)} value={visionValue} />
        <StatusLine label="Embedding" status={capabilityStatus(embeddingOptions, embeddingValue)} value={embeddingValue} />
        <StatusLine label="Image generation" status={capabilityStatus(imageProviders, imageValue)} value={imageValue} />

        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <Button variant="outline" size="sm" onClick={handleTestChat} disabled={testChatStatus === "sending"}>
            {testChatStatus === "sending" ? "Sending…" : "Send test chat message"}
          </Button>
          <span className="text-xs text-muted-foreground">Tests your saved chat model — save changes above first.</span>
        </div>
        {testChatReply ? (
          <p className="rounded bg-background p-2 text-xs">
            <span className="font-medium">Reply: </span>
            {testChatReply}
          </p>
        ) : null}
        {testChatStatus === "error" && testChatError ? (
          <ErrorMessage description={testChatError} onRetry={() => setTestChatStatus("idle")} />
        ) : null}
      </div>

      <CloudApiKeysBlock
        openaiKey={openaiApiKeyInput}
        onOpenaiKeyChange={setOpenaiApiKeyInput}
        hasSavedOpenaiKey={hasSavedOpenaiKey}
        anthropicKey={anthropicApiKeyInput}
        onAnthropicKeyChange={setAnthropicApiKeyInput}
        hasSavedAnthropicKey={hasSavedAnthropicKey}
        geminiKey={geminiApiKeyInput}
        onGeminiKeyChange={setGeminiApiKeyInput}
        hasSavedGeminiKey={hasSavedGeminiKey}
        disabled={saveStatus === "saving"}
      />

      <CollapsibleSection
        title="Local models (bundled Ollama) — download a new one, or bring your own GGUF, any time"
        defaultOpen={
          parseKey(chatValue)[0] === "ollama" ||
          parseKey(visionValue)[0] === "ollama" ||
          parseKey(embeddingValue)[0] === "ollama"
        }
      >
        <OllamaModelManager onConnected={refresh} />
      </CollapsibleSection>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Chat model — <code>/chat</code> and knowledge-base answers
          </label>
          <ModelSelect
            options={chatOptions}
            value={chatValue}
            onChange={(v) => {
              setChatValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
          {isUnavailable(chatOptions, chatValue) ? <UnavailableWarning optionKeyValue={chatValue} /> : null}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Vision model — design-image-to-landing-page generation
          </label>
          <ModelSelect
            options={visionOptions}
            value={visionValue}
            onChange={(v) => {
              setVisionValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
          {isUnavailable(visionOptions, visionValue) ? (
            <UnavailableWarning optionKeyValue={visionValue} />
          ) : null}
        </div>

        <CollapsibleSection
          title="Advanced: custom endpoint for chat/vision (llama.cpp, vLLM, ...)"
          defaultOpen={parseKey(chatValue)[0] === "custom" || parseKey(visionValue)[0] === "custom"}
        >
          <CustomEndpointBlock
            baseUrl={customBaseUrl}
            onBaseUrlChange={setCustomBaseUrl}
            apiKey={customApiKey}
            onApiKeyChange={setCustomApiKey}
            hasSavedKey={hasSavedCustomKey}
            onModels={setCustomModels}
            disabled={saveStatus === "saving"}
            scopeLabel="chat, or vision"
          />
        </CollapsibleSection>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Embedding model — knowledge-base document ingestion
          </label>
          <ModelSelect
            options={embeddingOptions}
            value={embeddingValue}
            onChange={(v) => {
              setEmbeddingValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
          {isUnavailable(embeddingOptions, embeddingValue) ? (
            <UnavailableWarning optionKeyValue={embeddingValue} />
          ) : null}
          <p className="text-xs text-muted-foreground">
            Changing this clears every document&apos;s vectors — re-embed them from the knowledge base
            panel below after saving.
          </p>
        </div>

        <CollapsibleSection
          title="Advanced: custom endpoint for embedding (llama.cpp, vLLM, ...)"
          defaultOpen={parseKey(embeddingValue)[0] === "custom"}
        >
          <CustomEndpointBlock
            baseUrl={embeddingBaseUrl}
            onBaseUrlChange={setEmbeddingBaseUrl}
            apiKey={embeddingApiKey}
            onApiKeyChange={setEmbeddingApiKey}
            hasSavedKey={hasSavedEmbeddingKey}
            onModels={setEmbeddingCustomModels}
            disabled={saveStatus === "saving"}
            scopeLabel="embedding"
          />
          <p className="text-xs text-muted-foreground">
            Embedding has its own endpoint, separate from chat/vision above — point this at a dedicated
            embedding-mode server (e.g. a second <code>llama-server --embedding</code> instance on its own
            port) if it&apos;s not the same process as your chat/vision one.
          </p>
        </CollapsibleSection>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Image generation — posters and CTE-generated images
          </label>
          <ModelSelect
            options={imageProviders}
            value={imageValue}
            onChange={(v) => {
              setImageValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
          {isUnavailable(imageProviders, imageValue) ? (
            <UnavailableWarning optionKeyValue={imageValue} />
          ) : null}
          {parseKey(imageValue)[0] === "comfyui" ? (
            <>
              <Input
                value={imageComfyuiUrl}
                onChange={(e) => {
                  setImageComfyuiUrl(e.target.value);
                  setSaveStatus("idle");
                }}
                placeholder="http://localhost:8188"
                disabled={saveStatus === "saving"}
                className="sm:w-64"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the default ComfyUI instance. <code>localhost</code>/<code>127.0.0.1</code>{" "}
                is routed to your machine automatically, same as the custom chat endpoint above.
              </p>
              <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                <ComfyUIAssetSelect
                  label="Unet"
                  options={imageComfyuiAssets.unets}
                  value={imageComfyuiUnet}
                  onChange={(v) => {
                    setImageComfyuiUnet(v);
                    setSaveStatus("idle");
                  }}
                  disabled={saveStatus === "saving" || !!imageComfyuiWorkflow.trim()}
                />
                <ComfyUIAssetSelect
                  label="Clip"
                  options={imageComfyuiAssets.clips}
                  value={imageComfyuiClip}
                  onChange={(v) => {
                    setImageComfyuiClip(v);
                    setSaveStatus("idle");
                  }}
                  disabled={saveStatus === "saving" || !!imageComfyuiWorkflow.trim()}
                />
                <ComfyUIAssetSelect
                  label="Vae"
                  options={imageComfyuiAssets.vaes}
                  value={imageComfyuiVae}
                  onChange={(v) => {
                    setImageComfyuiVae(v);
                    setSaveStatus("idle");
                  }}
                  disabled={saveStatus === "saving" || !!imageComfyuiWorkflow.trim()}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Swaps files within the same unet+clip+vae workflow shape — a differently-architected SD
                checkpoint (e.g. a single-file SDXL/SD1.5 model) isn&apos;t supported by this workflow.
                {imageComfyuiWorkflow.trim() ? " Ignored while a custom workflow (below) is set." : ""}
              </p>

              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Advanced: bring your own ComfyUI workflow
                </p>
                <p className="text-xs text-muted-foreground">
                  Paste a workflow exported from ComfyUI via <strong>Save (API Format)</strong> — any
                  checkpoint/architecture, any node layout. When set, this replaces the fixed workflow and
                  the unet/clip/vae pickers above entirely. Only the prompt text gets wired in (below);
                  seed/size/etc. come from whatever the pasted workflow already has.
                </p>
                <Textarea
                  value={imageComfyuiWorkflow}
                  onChange={(e) => {
                    setImageComfyuiWorkflow(e.target.value);
                    setSaveStatus("idle");
                  }}
                  placeholder="Paste ComfyUI's API-format workflow JSON here…"
                  disabled={saveStatus === "saving"}
                  className="min-h-32 font-mono text-xs"
                />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={imageComfyuiPromptNode}
                    onChange={(e) => {
                      setImageComfyuiPromptNode(e.target.value);
                      setSaveStatus("idle");
                    }}
                    placeholder="Prompt node ID (e.g. 6)"
                    disabled={saveStatus === "saving"}
                    className="sm:w-48"
                  />
                  <Input
                    value={imageComfyuiPromptField}
                    onChange={(e) => {
                      setImageComfyuiPromptField(e.target.value);
                      setSaveStatus("idle");
                    }}
                    placeholder='Prompt input field (default "text")'
                    disabled={saveStatus === "saving"}
                    className="sm:w-64"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Node ID is the key in the exported JSON (find it by opening the file, or right-click the
                  prompt node in ComfyUI → Properties Panel → Node ID). Required whenever a workflow is
                  pasted above; leave the field name blank to use &quot;text&quot; (a typical
                  CLIPTextEncode).
                </p>
              </div>

              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="resource-coordination"
                    checked={resourceCoordinationEnabled}
                    onCheckedChange={setResourceCoordinationEnabled}
                    disabled={saveStatus === "saving"}
                  />
                  <Label htmlFor="resource-coordination" className="text-sm">
                    Free up chat/vision memory before generating
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  For memory-constrained local setups: before generating, checks ComfyUI&apos;s own free
                  RAM/VRAM and — only if it&apos;s actually tight — unloads the chat/vision model from its
                  llama.cpp endpoint first (it reloads automatically on your next chat message). Only
                  applies when chat or vision is a custom llama.cpp-shaped endpoint.
                </p>
                {resourceCoordinationEnabled ? (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="resource-coordination-headroom" className="text-xs text-muted-foreground">
                      Free memory threshold (MB)
                    </Label>
                    <Input
                      id="resource-coordination-headroom"
                      type="number"
                      min={0}
                      value={resourceCoordinationHeadroomMb}
                      onChange={(e) => {
                        setResourceCoordinationHeadroomMb(e.target.value);
                        setSaveStatus("idle");
                      }}
                      disabled={saveStatus === "saving"}
                      className="w-32"
                    />
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <Button
        onClick={handleSave}
        disabled={saveStatus === "saving" || !chatValue || !visionValue || !embeddingValue || !imageValue}
      >
        <Save className="size-4" />
        {saveStatus === "saving" ? "Saving…" : "Save"}
      </Button>

      {saveStatus === "saved" ? (
        <p className="text-xs text-muted-foreground">Saved — now live for every visitor.</p>
      ) : null}
      {saveStatus === "error" && saveError ? (
        <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
      ) : null}
    </div>
  );
}
