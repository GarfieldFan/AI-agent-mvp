"use client";

import * as React from "react";
import Link from "next/link";
import { Bot, Check, ChevronDown, CircleAlert, Cloud, HardDrive, Rocket, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ModelSettingsPanel } from "@/components/modules/model-settings-panel";
import { OllamaModelManager } from "@/components/modules/ollama-model-manager";
import { ApiError } from "@/lib/api";
import { suggestBusinessProfile, type SuggestBusinessProfileResult } from "@/lib/business-profile";
import { listModels, patchModelSettings } from "@/lib/models";
import { checkSetupStatus } from "@/lib/setup";

type Step = "welcome" | "connect" | "finish";
type ConnectMode = "choose" | "api-key" | "local";
type CloudVendor = "openai" | "anthropic" | "gemini";

const VENDOR_LABELS: Record<CloudVendor, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini" };

/** The "use a cloud API key" branch — vendor picker, one password input,
 * save. After saving the key, immediately re-fetches the model list
 * (now that the key is persisted, that vendor's default chat model
 * reports `selectable: true`) and picks it as the active chat model in
 * a second save — two sequential requests, not one, since the freshly-
 * saved key only takes effect once committed; a single combined save
 * would fail validation against the not-yet-persisted key. */
function ApiKeyConnect({ onConnected }: { onConnected: () => void }) {
  const [vendor, setVendor] = React.useState<CloudVendor>("openai");
  const [keyInput, setKeyInput] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  async function handleSave() {
    if (!keyInput.trim()) return;
    setStatus("saving");
    setError(null);
    try {
      const keyField = `${vendor}_api_key` as const;
      await patchModelSettings({ [keyField]: keyInput.trim() });

      const models = await listModels();
      const defaultModel = models.chat_models.find((m) => m.provider === vendor && m.selectable);
      if (!defaultModel) {
        throw new Error(
          `Saved the key, but ${VENDOR_LABELS[vendor]} still isn't reporting as usable — double-check the key is correct.`,
        );
      }
      await patchModelSettings({ chat_provider: vendor, chat_model: defaultModel.model });

      setStatus("idle");
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't save that key.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={vendor} onValueChange={(v) => v && setVendor(v as CloudVendor)}>
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            <SelectItem value="gemini">Gemini</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={`${VENDOR_LABELS[vendor]} API key`}
          className="sm:flex-1"
        />
        <Button onClick={handleSave} disabled={!keyInput.trim() || status === "saving"}>
          {status === "saving" ? "Connecting…" : "Save and connect"}
        </Button>
      </div>
      {status === "error" && error ? <ErrorMessage description={error} onRetry={() => setStatus("idle")} /> : null}
    </div>
  );
}

/** First-run setup wizard (2026-09-09), on the user's own direct ask: an
 * onboarding experience closer to an OS's own first-boot flow than the
 * dashboard's existing flat settings panels. The "connect" step branches
 * exactly as the user described: (1) use a cloud API key — pick a
 * vendor, paste a key, done; (2) install a local model — pick one,
 * it downloads into the bundled `ollama` service, done. Advanced/
 * everything-else configuration (vision, embedding, image-gen, a
 * self-hosted non-Ollama runtime) stays reachable via a collapsed
 * `ModelSettingsPanel` below, not duplicated into the quick-connect UI.
 *
 * This wizard configures nothing beyond what already-real functionality
 * does — `updateModelSettings`, `pullOllamaModel`,
 * `suggestBusinessProfile()` are all pre-existing, real endpoints. Not
 * auto-triggered on login (a deliberate scope cut — see the root
 * AGENTS.md): reachable via `SetupStatusBanner`'s link on `/dashboard`
 * whenever chat isn't configured yet, or by visiting `/setup` directly. */
export function SetupWizard() {
  const [step, setStep] = React.useState<Step>("welcome");
  const [connectMode, setConnectMode] = React.useState<ConnectMode>("choose");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [status, setStatus] = React.useState<{ chatConfigured: boolean } | "loading" | "error">("loading");

  const [suggestion, setSuggestion] = React.useState<SuggestBusinessProfileResult | null>(null);
  const [suggestStatus, setSuggestStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [suggestError, setSuggestError] = React.useState<string | null>(null);

  // No synchronous setState in the body below — only inside .then()/.catch()
  // — so this is safe to call directly from the effect (mirrors
  // AgentConsoleSection's own verify effect, which relies on the same
  // trick instead of setting a "loading" state synchronously up front).
  const runStatusCheck = React.useCallback(() => {
    checkSetupStatus()
      .then(setStatus)
      .catch(() => setStatus("error"));
  }, []);

  React.useEffect(() => {
    if (step === "connect" || step === "finish") runStatusCheck();
  }, [step, runStatusCheck]);

  function handleRecheck() {
    setStatus("loading");
    runStatusCheck();
  }

  function handleConnected() {
    setConnectMode("choose");
    handleRecheck();
  }

  async function handleTrySuggest() {
    setSuggestStatus("loading");
    setSuggestError(null);
    try {
      const result = await suggestBusinessProfile();
      setSuggestion(result);
      setSuggestStatus("idle");
    } catch (err) {
      setSuggestError(err instanceof ApiError ? err.message : "Couldn't reach the backend — try again shortly.");
      setSuggestStatus("error");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <StepDot active={step === "welcome"} done={step !== "welcome"} label="Welcome" />
        <span>—</span>
        <StepDot active={step === "connect"} done={step === "finish"} label="Connect a model" />
        <span>—</span>
        <StepDot active={step === "finish"} done={false} label="Finish" />
      </div>

      {step === "welcome" ? (
        <div className="space-y-4 rounded-xl border p-6">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Let&apos;s get your AI connected</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            This wizard walks you through picking an AI model — either a cloud API or one downloaded and
            run locally — and then points you at what to set up next. It doesn&apos;t do anything you
            couldn&apos;t already do from the dashboard&apos;s own settings panels; it&apos;s just a
            guided starting point.
          </p>
          <Button onClick={() => setStep("connect")}>Get started</Button>
        </div>
      ) : null}

      {step === "connect" ? (
        <div className="space-y-4">
          <div className="space-y-2 rounded-xl border border-dashed p-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Bot className="h-5 w-5" />
              Connect an AI model
            </h2>
            <p className="text-sm text-muted-foreground">How do you want to connect a model?</p>
          </div>

          {connectMode === "choose" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setConnectMode("api-key")}
                className="flex flex-col items-start gap-1 rounded-xl border p-4 text-left hover:bg-muted"
              >
                <Cloud className="h-5 w-5" />
                <span className="font-medium">Use a cloud API key</span>
                <span className="text-xs text-muted-foreground">
                  OpenAI, Anthropic, or Gemini — paste a key, done in seconds.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setConnectMode("local")}
                className="flex flex-col items-start gap-1 rounded-xl border p-4 text-left hover:bg-muted"
              >
                <HardDrive className="h-5 w-5" />
                <span className="font-medium">Install a local model</span>
                <span className="text-xs text-muted-foreground">
                  Runs entirely on this machine — pick a model, it downloads automatically.
                </span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Button variant="ghost" size="sm" onClick={() => setConnectMode("choose")}>
                ← Back to choices
              </Button>
              {connectMode === "api-key" ? (
                <ApiKeyConnect onConnected={handleConnected} />
              ) : (
                <OllamaModelManager onConnected={handleConnected} />
              )}
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              Advanced: full model settings (vision, embedding, image generation, a self-hosted endpoint)
            </button>
            {showAdvanced ? (
              <div className="mt-2">
                <ModelSettingsPanel />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
            {status === "loading" ? <LoadingSpinner label="Checking connection…" /> : null}
            {status !== "loading" && status !== "error" && status.chatConfigured ? (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
                A chat model is connected and ready.
              </span>
            ) : null}
            {status !== "loading" && status !== "error" && !status.chatConfigured ? (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CircleAlert className="h-4 w-4" />
                No working chat model detected yet — connect one above, or continue anyway if
                you&apos;ll finish this later.
              </span>
            ) : null}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={handleRecheck}>
                Re-check
              </Button>
              <Button size="sm" onClick={() => setStep("finish")}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {step === "finish" ? (
        <div className="space-y-4">
          <div className="space-y-2 rounded-xl border p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="h-5 w-5" />
              What&apos;s next
            </h2>
            <p className="text-sm text-muted-foreground">
              Once your AI is connected, a few of this app&apos;s panels can draft their own starting
              content from documents you upload — you always review before anything saves.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>
                Upload a few documents about your business in <strong>AI &amp; knowledge base →
                Documents</strong> (on the dashboard).
              </li>
              <li>
                Then use <strong>SEO &amp; AI discoverability → Business profile</strong>&apos;s
                &quot;Suggest from documents&quot; button — or try it right here:
              </li>
            </ol>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleTrySuggest} disabled={suggestStatus === "loading"}>
                {suggestStatus === "loading" ? "Drafting…" : "Try it now"}
              </Button>
            </div>
            {suggestStatus === "error" && suggestError ? (
              <ErrorMessage description={suggestError} onRetry={() => setSuggestStatus("idle")} />
            ) : null}
            {suggestion ? (
              suggestion.document_count === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No ready documents yet — upload some first, then try again.
                </p>
              ) : (
                <div className="space-y-1 rounded-lg border border-dashed p-3 text-xs">
                  <p>
                    Drafted from {suggestion.document_count} document(s):
                  </p>
                  <p>
                    <Badge variant="secondary" className="mr-1">
                      Name
                    </Badge>
                    {suggestion.suggestion.business_name || "—"}
                  </p>
                  <p>
                    <Badge variant="secondary" className="mr-1">
                      Type
                    </Badge>
                    {suggestion.suggestion.business_type || "—"}
                  </p>
                  <p className="text-muted-foreground">
                    Full review/edit happens in Business profile settings — this is just a preview.
                  </p>
                </div>
              )
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button render={<Link href="/dashboard" />} nativeButton={false}>
              Done — go to dashboard
            </Button>
            <Button variant="outline" onClick={() => setStep("connect")}>
              Back
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span className={active ? "font-medium text-foreground" : done ? "text-foreground" : ""}>
      {done ? "✓ " : ""}
      {label}
    </span>
  );
}
