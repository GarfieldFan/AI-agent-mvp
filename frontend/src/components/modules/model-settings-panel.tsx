"use client";

import * as React from "react";
import { Eye, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { ApiError } from "@/lib/api";
import {
  getModelSettings,
  listModels,
  updateModelSettings,
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

/** Owner-facing AI model picker (backend/apis/model_settings.py). Two
 * independent selections — chat model (used by the public /api/chat
 * endpoint and RAG answer generation) and vision model (used by
 * generate_landing_page) — because most local models only have one of
 * those two capabilities (see the size 3 `Eye` icon marking which chat
 * models also happen to support vision, informational only there).
 *
 * Ollama options are queried live and fully functional. Cloud provider
 * options (OpenAI/Anthropic/Gemini) are shown but disabled: chat ones
 * until that provider's API key is configured, vision ones always (no
 * cloud vision path is wired up yet — see lib/models.ts / the backend
 * module docstring). Saving is global and immediate — it changes what
 * every visitor's chat and every future landing-page generation uses,
 * not just this admin session. */
export function ModelSettingsPanel() {
  const [chatModels, setChatModels] = React.useState<ModelOption[] | null>(null);
  const [visionModels, setVisionModels] = React.useState<ModelOption[] | null>(null);
  const [chatValue, setChatValue] = React.useState("");
  const [visionValue, setVisionValue] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    Promise.all([listModels(), getModelSettings()])
      .then(([models, settings]) => {
        setChatModels(models.chat_models);
        setVisionModels(models.vision_models);
        setChatValue(optionKey(settings.chat_provider, settings.chat_model));
        setVisionValue(optionKey(settings.vision_provider, settings.vision_model));
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load model settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    const [chat_provider, chat_model] = parseKey(chatValue);
    const [vision_provider, vision_model] = parseKey(visionValue);
    const payload: ModelSettings = { chat_provider, chat_model, vision_provider, vision_model };

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

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!chatModels || !visionModels) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading available models…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">AI model selection</h3>
        <p className="text-xs text-muted-foreground">
          Applies globally and immediately — every visitor&apos;s chat message and every future
          landing-page generation uses whatever&apos;s selected here.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Chat model — <code>/chat</code> and knowledge-base answers
          </label>
          <ModelSelect
            options={chatModels}
            value={chatValue}
            onChange={(v) => {
              setChatValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Vision model — design-image-to-landing-page generation
          </label>
          <ModelSelect
            options={visionModels}
            value={visionValue}
            onChange={(v) => {
              setVisionValue(v);
              setSaveStatus("idle");
            }}
            disabled={saveStatus === "saving"}
          />
        </div>
      </div>

      <Button onClick={handleSave} disabled={saveStatus === "saving" || !chatValue || !visionValue}>
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
