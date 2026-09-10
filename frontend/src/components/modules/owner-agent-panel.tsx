"use client";

import * as React from "react";
import { Bot, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ReportChart } from "@/components/common/report-chart";
import { ApiError } from "@/lib/api";
import { updateBusinessProfile, type BusinessProfile, type SuggestBusinessProfileResult } from "@/lib/business-profile";
import {
  createIntentSchema,
  FIELD_TYPE_OPTIONS,
  updateIntentSchema,
  type IntentFieldInput,
  type IntentFieldType,
  type IntentSchemaInput,
} from "@/lib/intent-schemas";
import {
  listOwnerAgentRuns,
  runOwnerAgentCommand,
  type OwnerAgentRunResult,
  type OwnerAgentRunSummary,
} from "@/lib/owner-agent";
import {
  createProduct,
  createStockItem,
  updateProduct,
  updateStockItem,
  type ProductInput,
  type ProposedStockAdjustment,
} from "@/lib/products";
import type { Report } from "@/lib/reports";

const HISTORY_PAGE_SIZE = 20;

/** Shape returned by backend/apis/intent_schemas.py's
 * propose_intent_schema — never a database write, just a draft for the
 * owner to review here. */
type ProposedSchema = {
  proposed_schema: IntentSchemaInput;
  already_exists: boolean;
  existing_id: number | null;
};

function blankProposalField(): IntentFieldInput {
  return { field_key: "", label: "", field_type: "text", required: true, prompt_hint: "" };
}

/** Shape returned by backend/apis/products.py's propose_products — a
 * batch of drafts, never a database write. */
type ProposedProduct = {
  product: ProductInput;
  already_exists: boolean;
  existing_id: number | null;
};

/** Owner only (see owner-agent/deps.py — stricter than every other panel
 * in this section, which are admin OR owner). Sends a natural-language
 * command to the owner-agent container's `POST /run`, a real LLM
 * tool-calling loop over a fixed 29-tool allowlist (poster/landing-page
 * generation, CRM capture/list/delete, reporting, GEO page regeneration,
 * attachment scanning, upload cleanup, intake-schema/product/stock/
 * business-profile proposals — including drafting products/restocks
 * straight from an already-uploaded PDF, knowledge-base search, a
 * targeted single-instruction page edit, and creating a knowledge-base
 * document directly from composed text — and more, see owner-agent/
 * tools.py for the current, authoritative list) — the first capability
 * in this app where
 * the model itself decides which action(s) to take, not a single
 * deterministic pipeline call. Renders the full step trace so a run's
 * reasoning is visible, not just its final answer. Also lists past runs
 * (2026-08-19, backend/models.py's OwnerAgentRun) — a queryable history
 * table alongside owner-agent's own per-step JSONL log, see that model's
 * docstring for why both exist. */
export function OwnerAgentPanel() {
  const [command, setCommand] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<OwnerAgentRunResult | null>(null);
  const [history, setHistory] = React.useState<OwnerAgentRunSummary[] | null>(null);
  const [historyTotal, setHistoryTotal] = React.useState(0);
  const [historyPage, setHistoryPage] = React.useState(1);

  // Schema-proposal review (2026-08-19) — see propose_intent_schema's
  // description in owner-agent/tools.py: the agent never writes a
  // schema itself, it only drafts one here for the owner to review and
  // explicitly Apply or Discard. `pendingProposal` is the raw draft (for
  // the already_exists/existing_id decision on Apply); `proposalDraft`
  // is the editable working copy the form actually binds to.
  const [pendingProposal, setPendingProposal] = React.useState<ProposedSchema | null>(null);
  const [proposalDraft, setProposalDraft] = React.useState<IntentSchemaInput | null>(null);
  const [applyStatus, setApplyStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [applyError, setApplyError] = React.useState<string | null>(null);

  // Product-proposal review (2026-08-19) — same propose-then-owner-
  // applies posture as the schema proposal above, see
  // propose_products' description in owner-agent/tools.py: a misread
  // price directly affects what a real customer is quoted, so
  // owner-agent never writes a Product itself. A batch, not a single
  // draft, since one command ("set up my whole menu") proposes several
  // at once.
  const [pendingProducts, setPendingProducts] = React.useState<ProposedProduct[] | null>(null);
  const [productApplyStatus, setProductApplyStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [productApplyError, setProductApplyError] = React.useState<string | null>(null);

  // Stock-adjustment-proposal review (2026-09-10) — same propose-then-
  // owner-applies posture, see propose_stock_from_document's description
  // in owner-agent/tools.py: a misread quantity from a purchase order
  // would silently corrupt a real stock count, so owner-agent never
  // writes to StockItem itself.
  const [pendingStock, setPendingStock] = React.useState<ProposedStockAdjustment[] | null>(null);
  const [stockApplyStatus, setStockApplyStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [stockApplyError, setStockApplyError] = React.useState<string | null>(null);

  // Business-profile-proposal review (2026-09-10) — same propose-then-
  // owner-applies posture, see suggest_business_profile's description in
  // owner-agent/tools.py: a wrong phone/address published as structured
  // data has real consequences, so owner-agent never saves a profile
  // itself.
  const [pendingBusinessProfile, setPendingBusinessProfile] = React.useState<BusinessProfile | null>(null);
  const [businessProfileApplyStatus, setBusinessProfileApplyStatus] = React.useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [businessProfileApplyError, setBusinessProfileApplyError] = React.useState<string | null>(null);

  const refreshHistory = React.useCallback(() => {
    listOwnerAgentRuns(HISTORY_PAGE_SIZE, (historyPage - 1) * HISTORY_PAGE_SIZE)
      .then((result) => {
        setHistory(result.items);
        setHistoryTotal(result.total);
      })
      .catch(() => setHistory([]));
  }, [historyPage]);

  React.useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  async function handleRun() {
    if (!command.trim()) return;
    setStatus("loading");
    setError(null);
    setResult(null);
    setPendingProposal(null);
    setProposalDraft(null);
    setPendingProducts(null);
    setPendingStock(null);
    setPendingBusinessProfile(null);
    try {
      const runResult = await runOwnerAgentCommand(command.trim());
      setResult(runResult);
      setStatus("idle");
      // best-effort — owner-agent logs the run to backend itself. A new
      // run sorts first (most-recent-first order) — jump back to page 1
      // so it's actually visible, same fix as ProductPanel/
      // DocumentManager's own "new row sorts first" pattern.
      if (historyPage === 1) refreshHistory();
      else setHistoryPage(1);

      const proposalStep = runResult.steps.find(
        (step) => step.tool === "propose_intent_schema" && step.ok,
      );
      if (proposalStep?.result) {
        const proposal = proposalStep.result as unknown as ProposedSchema;
        setPendingProposal(proposal);
        setProposalDraft(proposal.proposed_schema);
      }

      // "propose_products_from_document" (2026-09-10) returns the exact
      // same {proposals: ProposedProduct[]} shape as propose_products —
      // reading a PDF first doesn't change what gets reviewed/applied.
      const productsStep = runResult.steps.find(
        (step) => (step.tool === "propose_products" || step.tool === "propose_products_from_document") && step.ok,
      );
      if (productsStep?.result) {
        const { proposals } = productsStep.result as unknown as { proposals: ProposedProduct[] };
        setPendingProducts(proposals);
      }

      const stockStep = runResult.steps.find((step) => step.tool === "propose_stock_from_document" && step.ok);
      if (stockStep?.result) {
        const { proposals } = stockStep.result as unknown as { proposals: ProposedStockAdjustment[] };
        setPendingStock(proposals);
      }

      const businessProfileStep = runResult.steps.find(
        (step) => step.tool === "suggest_business_profile" && step.ok,
      );
      if (businessProfileStep?.result) {
        const { suggestion } = businessProfileStep.result as unknown as SuggestBusinessProfileResult;
        setPendingBusinessProfile(suggestion);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Run failed — is the owner-agent service reachable?",
      );
      setStatus("error");
    }
  }

  function updateProposalFieldAt(index: number, patch: Partial<IntentFieldInput>) {
    setProposalDraft((d) =>
      d ? { ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : d,
    );
  }

  function removeProposalFieldAt(index: number) {
    setProposalDraft((d) => (d ? { ...d, fields: d.fields.filter((_, i) => i !== index) } : d));
  }

  function addProposalField() {
    setProposalDraft((d) => (d ? { ...d, fields: [...d.fields, blankProposalField()] } : d));
  }

  function discardProposal() {
    setPendingProposal(null);
    setProposalDraft(null);
    setApplyStatus("idle");
    setApplyError(null);
  }

  async function applyProposal() {
    if (!pendingProposal || !proposalDraft) return;
    if (!proposalDraft.key.trim() || !proposalDraft.label.trim()) return;
    setApplyStatus("saving");
    setApplyError(null);
    const payload: IntentSchemaInput = {
      key: proposalDraft.key.trim(),
      label: proposalDraft.label.trim(),
      description: proposalDraft.description.trim(),
      fields: proposalDraft.fields
        .filter((f) => f.field_key.trim() && f.label.trim())
        .map((f) => ({ ...f, field_key: f.field_key.trim(), label: f.label.trim(), prompt_hint: f.prompt_hint?.trim() || null })),
    };
    try {
      if (pendingProposal.already_exists && pendingProposal.existing_id !== null) {
        await updateIntentSchema(pendingProposal.existing_id, payload);
      } else {
        await createIntentSchema(payload);
      }
      setPendingProposal(null);
      setProposalDraft(null);
      setApplyStatus("idle");
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "Apply failed — is the backend reachable?");
      setApplyStatus("error");
    }
  }

  function updateProductDraftAt(index: number, patch: Partial<ProductInput>) {
    setPendingProducts((list) =>
      list ? list.map((p, i) => (i === index ? { ...p, product: { ...p.product, ...patch } } : p)) : list,
    );
  }

  function removeProductDraftAt(index: number) {
    setPendingProducts((list) => (list ? list.filter((_, i) => i !== index) : list));
  }

  function discardProducts() {
    setPendingProducts(null);
    setProductApplyStatus("idle");
    setProductApplyError(null);
  }

  async function applyProducts() {
    if (!pendingProducts || pendingProducts.length === 0) return;
    setProductApplyStatus("saving");
    setProductApplyError(null);
    try {
      for (const proposal of pendingProducts) {
        const payload: ProductInput = {
          name: proposal.product.name.trim(),
          description: proposal.product.description?.trim() || null,
          price: proposal.product.price,
          tags: proposal.product.tags ?? [],
          available: proposal.product.available,
        };
        if (proposal.already_exists && proposal.existing_id !== null) {
          await updateProduct(proposal.existing_id, payload);
        } else {
          await createProduct(payload);
        }
      }
      setPendingProducts(null);
      setProductApplyStatus("idle");
    } catch (err) {
      setProductApplyError(err instanceof ApiError ? err.message : "Apply failed — is the backend reachable?");
      setProductApplyStatus("error");
    }
  }

  function updateStockDraftAt(index: number, patch: Partial<ProposedStockAdjustment>) {
    setPendingStock((list) => (list ? list.map((s, i) => (i === index ? { ...s, ...patch } : s)) : list));
  }

  function removeStockDraftAt(index: number) {
    setPendingStock((list) => (list ? list.filter((_, i) => i !== index) : list));
  }

  function discardStock() {
    setPendingStock(null);
    setStockApplyStatus("idle");
    setStockApplyError(null);
  }

  async function applyStock() {
    if (!pendingStock || pendingStock.length === 0) return;
    setStockApplyStatus("saving");
    setStockApplyError(null);
    try {
      for (const proposal of pendingStock) {
        if (proposal.existing_id !== null && proposal.existing_quantity !== null) {
          // Restock adds the parsed quantity ON TOP OF whatever's
          // already there — the document represents a delivery, not a
          // fresh inventory count.
          await updateStockItem(proposal.existing_id, {
            name: proposal.name.trim(),
            quantity: proposal.existing_quantity + proposal.quantity,
            unit: proposal.unit.trim(),
          });
        } else {
          await createStockItem({ name: proposal.name.trim(), quantity: proposal.quantity, unit: proposal.unit.trim() });
        }
      }
      setPendingStock(null);
      setStockApplyStatus("idle");
    } catch (err) {
      setStockApplyError(err instanceof ApiError ? err.message : "Apply failed — is the backend reachable?");
      setStockApplyStatus("error");
    }
  }

  function updateBusinessProfileDraft(patch: Partial<BusinessProfile>) {
    setPendingBusinessProfile((p) => (p ? { ...p, ...patch } : p));
  }

  function discardBusinessProfile() {
    setPendingBusinessProfile(null);
    setBusinessProfileApplyStatus("idle");
    setBusinessProfileApplyError(null);
  }

  async function applyBusinessProfile() {
    if (!pendingBusinessProfile) return;
    setBusinessProfileApplyStatus("saving");
    setBusinessProfileApplyError(null);
    try {
      await updateBusinessProfile(pendingBusinessProfile);
      setPendingBusinessProfile(null);
      setBusinessProfileApplyStatus("idle");
    } catch (err) {
      setBusinessProfileApplyError(err instanceof ApiError ? err.message : "Apply failed — is the backend reachable?");
      setBusinessProfileApplyStatus("error");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Bot className="h-5 w-5" />
          Owner agent
        </h3>
        <p className="text-xs text-muted-foreground">
          Type a command in plain language — a real LLM tool-calling loop, running in its own
          isolated worker service, decides which actions to take (generate a poster, capture or
          list CRM entries, run a chat-volume report, regenerate the GEO page) and in what order.
        </p>
      </div>

      <div className="space-y-2">
        <Textarea
          placeholder="e.g. Generate a promo poster with the text '限时优惠', then log a CRM entry for jane@example.com about it"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          rows={3}
        />
        <Button onClick={handleRun} disabled={!command.trim() || status === "loading"}>
          Run
        </Button>
        {status === "loading" ? <LoadingSpinner label="Agent is working — this can take a few minutes if it generates an image…" /> : null}
        {status === "error" && error ? (
          <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
        ) : null}
      </div>

      {result ? (
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Final answer</p>
              <Badge variant={result.stopped_reason === "final_answer" ? "secondary" : "destructive"}>
                {result.stopped_reason}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{result.final_answer}</p>
          </div>

          {proposalDraft && pendingProposal ? (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Schema draft — review before applying</p>
                <p className="text-xs text-muted-foreground">
                  The agent never applies a schema change itself. Review and edit the draft below,
                  then Apply to actually create or update it.
                  {pendingProposal.already_exists ? (
                    <> This will <strong>update</strong> the existing &quot;{proposalDraft.label}&quot; schema.</>
                  ) : null}
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Key (stable id)</Label>
                  <Input
                    value={proposalDraft.key}
                    onChange={(e) => setProposalDraft((d) => (d ? { ...d, key: e.target.value } : d))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Label (shown to the owner)</Label>
                  <Input
                    value={proposalDraft.label}
                    onChange={(e) => setProposalDraft((d) => (d ? { ...d, label: e.target.value } : d))}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Description</Label>
                <Textarea
                  value={proposalDraft.description}
                  onChange={(e) => setProposalDraft((d) => (d ? { ...d, description: e.target.value } : d))}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Fields to collect</Label>
                {proposalDraft.fields.map((field, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-2">
                    <Input
                      placeholder="field_key"
                      value={field.field_key}
                      onChange={(e) => updateProposalFieldAt(i, { field_key: e.target.value })}
                    />
                    <Input
                      placeholder="Label"
                      value={field.label}
                      onChange={(e) => updateProposalFieldAt(i, { label: e.target.value })}
                    />
                    <Select
                      value={field.field_type}
                      onValueChange={(v) => v && updateProposalFieldAt(i, { field_type: v as IntentFieldType })}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1.5">
                      {/* Switch, not a separate Checkbox primitive — matches
                          IntentSchemaPanel's own choice for the same "required"
                          field, intentionally, not a missed component swap. */}
                      <Switch
                        checked={field.required}
                        onCheckedChange={(checked) => updateProposalFieldAt(i, { required: checked })}
                      />
                      <Label className="text-xs text-muted-foreground">Required</Label>
                    </div>
                    <Button variant="ghost" size="icon-xs" aria-label="Remove field" onClick={() => removeProposalFieldAt(i)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addProposalField}>
                  <Plus className="size-4" />
                  Add field
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={applyProposal}
                  disabled={!proposalDraft.key.trim() || !proposalDraft.label.trim() || applyStatus === "saving"}
                >
                  {applyStatus === "saving" ? "Applying…" : pendingProposal.already_exists ? "Apply update" : "Apply"}
                </Button>
                <Button variant="ghost" onClick={discardProposal}>
                  Discard
                </Button>
              </div>
              {applyStatus === "error" && applyError ? (
                <ErrorMessage description={applyError} onRetry={() => setApplyStatus("idle")} />
              ) : null}
            </div>
          ) : null}

          {pendingProducts && pendingProducts.length > 0 ? (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Product draft{pendingProducts.length > 1 ? "s" : ""} — review before applying</p>
                <p className="text-xs text-muted-foreground">
                  The agent never creates or changes real products itself. Review and edit each one
                  below, then Apply to actually write them — a real customer will be quoted whatever
                  price ends up here.
                </p>
              </div>

              <div className="space-y-2">
                {pendingProducts.map((proposal, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-2">
                    <Input
                      placeholder="Name"
                      value={proposal.product.name}
                      onChange={(e) => updateProductDraftAt(i, { name: e.target.value })}
                    />
                    <Input
                      placeholder="Tags (comma-separated)"
                      value={(proposal.product.tags ?? []).join(", ")}
                      onChange={(e) =>
                        updateProductDraftAt(i, {
                          tags: e.target.value
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="w-24"
                      placeholder="Price"
                      value={proposal.product.price}
                      onChange={(e) => updateProductDraftAt(i, { price: Number(e.target.value) })}
                    />
                    <div className="flex items-center gap-1.5">
                      <Switch
                        checked={proposal.product.available}
                        onCheckedChange={(checked) => updateProductDraftAt(i, { available: checked })}
                      />
                      <Label className="text-xs text-muted-foreground">Available</Label>
                    </div>
                    <Button variant="ghost" size="icon-xs" aria-label="Remove product" onClick={() => removeProductDraftAt(i)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                    {proposal.already_exists ? (
                      <p className="col-span-5 text-xs text-muted-foreground">
                        Will <strong>update</strong> the existing &quot;{proposal.product.name}&quot; product.
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={applyProducts} disabled={productApplyStatus === "saving"}>
                  {productApplyStatus === "saving" ? "Applying…" : "Apply"}
                </Button>
                <Button variant="ghost" onClick={discardProducts}>
                  Discard
                </Button>
              </div>
              {productApplyStatus === "error" && productApplyError ? (
                <ErrorMessage description={productApplyError} onRetry={() => setProductApplyStatus("idle")} />
              ) : null}
            </div>
          ) : null}

          {pendingStock && pendingStock.length > 0 ? (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  Stock restock draft{pendingStock.length > 1 ? "s" : ""} — review before applying
                </p>
                <p className="text-xs text-muted-foreground">
                  The agent never writes to real stock levels itself. A matched existing ingredient
                  gets the parsed quantity ADDED to what&apos;s already there (a delivery, not a fresh
                  count); an unmatched name creates a new ingredient.
                </p>
              </div>

              <div className="space-y-2">
                {pendingStock.map((proposal, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                    <Input
                      placeholder="Name"
                      value={proposal.name}
                      onChange={(e) => updateStockDraftAt(i, { name: e.target.value })}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="w-24"
                      placeholder="Quantity"
                      value={proposal.quantity}
                      onChange={(e) => updateStockDraftAt(i, { quantity: Number(e.target.value) })}
                    />
                    <Input
                      className="w-20"
                      placeholder="Unit"
                      value={proposal.unit}
                      onChange={(e) => updateStockDraftAt(i, { unit: e.target.value })}
                    />
                    <Button variant="ghost" size="icon-xs" aria-label="Remove entry" onClick={() => removeStockDraftAt(i)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                    {proposal.existing_id !== null ? (
                      <p className="col-span-4 text-xs text-muted-foreground">
                        Will restock &quot;{proposal.name}&quot;: {proposal.existing_quantity} + {proposal.quantity}{" "}
                        {proposal.unit} = {(proposal.existing_quantity ?? 0) + proposal.quantity} {proposal.unit}.
                      </p>
                    ) : (
                      <p className="col-span-4 text-xs text-muted-foreground">
                        Will create a new ingredient &quot;{proposal.name}&quot;.
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={applyStock} disabled={stockApplyStatus === "saving"}>
                  {stockApplyStatus === "saving" ? "Applying…" : "Apply"}
                </Button>
                <Button variant="ghost" onClick={discardStock}>
                  Discard
                </Button>
              </div>
              {stockApplyStatus === "error" && stockApplyError ? (
                <ErrorMessage description={stockApplyError} onRetry={() => setStockApplyStatus("idle")} />
              ) : null}
            </div>
          ) : null}

          {pendingBusinessProfile ? (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Business profile draft — review before applying</p>
                <p className="text-xs text-muted-foreground">
                  The agent never saves this itself — only facts explicitly stated in ingested documents
                  are filled in; anything left blank means nothing was found for it. Review, fill in
                  anything missing, then Apply to publish it.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Business name</Label>
                  <Input
                    value={pendingBusinessProfile.business_name ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_name: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Type (e.g. Plumber, Restaurant)</Label>
                  <Input
                    value={pendingBusinessProfile.business_type ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_type: e.target.value || null })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Description</Label>
                <Textarea
                  value={pendingBusinessProfile.business_description ?? ""}
                  onChange={(e) => updateBusinessProfileDraft({ business_description: e.target.value || null })}
                  rows={2}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Email</Label>
                  <Input
                    value={pendingBusinessProfile.business_email ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_email: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Phone</Label>
                  <Input
                    value={pendingBusinessProfile.business_phone ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_phone: e.target.value || null })}
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Street address</Label>
                  <Input
                    value={pendingBusinessProfile.business_street_address ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_street_address: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">City</Label>
                  <Input
                    value={pendingBusinessProfile.business_locality ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_locality: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">State/region</Label>
                  <Input
                    value={pendingBusinessProfile.business_region ?? ""}
                    onChange={(e) => updateBusinessProfileDraft({ business_region: e.target.value || null })}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={applyBusinessProfile} disabled={businessProfileApplyStatus === "saving"}>
                  {businessProfileApplyStatus === "saving" ? "Applying…" : "Apply"}
                </Button>
                <Button variant="ghost" onClick={discardBusinessProfile}>
                  Discard
                </Button>
              </div>
              {businessProfileApplyStatus === "error" && businessProfileApplyError ? (
                <ErrorMessage description={businessProfileApplyError} onRetry={() => setBusinessProfileApplyStatus("idle")} />
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">Step trace</p>
            {result.steps.map((step) => (
              <div key={step.index} className="space-y-1 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {step.index}
                    </Badge>
                    <span className="text-sm font-medium">{step.tool ?? step.type}</span>
                  </div>
                  {step.type === "tool_call" ? (
                    <Badge variant={step.ok ? "secondary" : "destructive"} className="text-xs">
                      {step.ok ? "ok" : "error"}
                    </Badge>
                  ) : null}
                </div>
                {step.thought ? <p className="text-xs text-muted-foreground">{step.thought}</p> : null}
                {Object.keys(step.args ?? {}).length > 0 ? (
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(step.args, null, 2)}
                  </pre>
                ) : null}
                {step.tool === "generate_report" && step.ok && step.result ? (
                  // Inline chart (2026-09-10), not just the raw JSON dump
                  // below — reuses the exact same rendering ReportPanel's
                  // own dashboard section uses, so a report looks the
                  // same whether the owner asked for it via the form or
                  // via a chat command.
                  <ReportChart report={step.result as unknown as Report} />
                ) : step.result ? (
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(step.result, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {history && history.length > 0 ? (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Recent runs</p>
          {history.map((run) => (
            <details key={run.id} className="rounded-lg border p-3">
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <span className="truncate">{run.command}</span>
                <Badge variant={run.stopped_reason === "final_answer" ? "secondary" : "destructive"} className="shrink-0 text-xs">
                  {run.stopped_reason}
                </Badge>
              </summary>
              <div className="mt-2 space-y-1">
                <p className="text-xs text-muted-foreground">
                  {new Date(run.created_at).toLocaleString()} · {run.owner_email} · {run.steps.length} step
                  {run.steps.length === 1 ? "" : "s"}
                </p>
                <p className="text-sm text-muted-foreground">{run.final_answer}</p>
              </div>
            </details>
          ))}
          {historyTotal > HISTORY_PAGE_SIZE ? (
            <Pagination page={historyPage} pageSize={HISTORY_PAGE_SIZE} total={historyTotal} onPageChange={setHistoryPage} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
