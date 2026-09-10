"use client";

import * as React from "react";
import { Boxes, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ApiError } from "@/lib/api";
import {
  createStockItem,
  deleteStockItem,
  listStockItems,
  updateStockItem,
  type StockItem,
  type StockItemInput,
} from "@/lib/products";

function blankDraft(): StockItemInput {
  return { name: "", quantity: 0, unit: "", low_stock_threshold: null };
}

function draftFromItem(item: StockItem): StockItemInput {
  return { name: item.name, quantity: item.quantity, unit: item.unit, low_stock_threshold: item.low_stock_threshold };
}

const PAGE_SIZE = 20;

/** Raw-material/ingredient inventory (2026-09-10) — deliberately a
 * separate, much simpler CRUD surface from ProductPanel, see
 * backend/models.py's StockItem docstring for why an ingredient (milk,
 * coffee beans, eggs) doesn't belong in the sellable-catalog table.
 * Never automatically linked to Product's own stock_quantity — no
 * recipe/bill-of-materials system exists, this is purely something the
 * owner (or the owner-agent's document-parsing tool, see OwnerAgentPanel)
 * adjusts directly. */
export function StockItemPanel() {
  const [items, setItems] = React.useState<StockItem[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [listError, setListError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const [editingId, setEditingId] = React.useState<number | "new" | null>(null);
  const [draft, setDraft] = React.useState<StockItemInput>(blankDraft());
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    listStockItems(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load stock items."));
  }, [page]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function startCreate() {
    setDraft(blankDraft());
    setEditingId("new");
    setSaveStatus("idle");
    setSaveError(null);
  }

  function startEdit(item: StockItem) {
    setDraft(draftFromItem(item));
    setEditingId(item.id);
    setSaveStatus("idle");
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleSave() {
    if (!draft.name.trim() || !draft.unit.trim() || editingId === null) return;
    setSaveStatus("saving");
    setSaveError(null);
    const payload: StockItemInput = {
      name: draft.name.trim(),
      quantity: draft.quantity,
      unit: draft.unit.trim(),
      low_stock_threshold: draft.low_stock_threshold,
    };
    try {
      if (editingId === "new") {
        await createStockItem(payload);
        setEditingId(null);
        if (page === 1) refresh();
        else setPage(1);
      } else {
        await updateStockItem(editingId, payload);
        setEditingId(null);
        refresh();
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleDelete(item: StockItem) {
    if (!window.confirm(`Delete "${item.name}" from tracked stock? This cannot be undone.`)) return;
    setDeletingId(item.id);
    try {
      await deleteStockItem(item.id);
      if (items && items.length === 1 && page > 1) setPage(page - 1);
      else refresh();
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  if (listError) return <ErrorMessage description={listError} onRetry={refresh} />;
  if (items === null) return <LoadingSpinner label="Loading stock items…" />;

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Boxes className="h-5 w-5" />
          Ingredient stock
        </h3>
        <p className="text-xs text-muted-foreground">
          Raw materials/ingredients (milk, coffee beans, eggs, ...) — separate from the sellable
          product catalog above, and never automatically decremented when a product sells (no
          recipe/bill-of-materials link exists). Adjust manually here, or describe a purchase order
          to the owner agent and review its draft.
        </p>
      </div>

      {total === 0 && editingId === null ? (
        <EmptyState
          icon={Boxes}
          title="No tracked ingredients yet"
          description="Add one below, or describe a purchase order to the owner agent and review its draft."
        />
      ) : null}

      {total > 0 ? <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} /> : null}

      <div className="space-y-2">
        {items.map((item) =>
          editingId === item.id ? null : (
            <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">
                  {item.name} — {item.quantity} {item.unit}
                  {item.low_stock_threshold !== null && item.quantity <= item.low_stock_threshold ? (
                    <Badge variant="destructive" className="ml-2 text-xs">
                      low stock
                    </Badge>
                  ) : null}
                </p>
                {item.low_stock_threshold !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Alert below {item.low_stock_threshold} {item.unit}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => startEdit(item)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete stock item"
                  disabled={deletingId === item.id}
                  onClick={() => handleDelete(item)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ),
        )}
      </div>

      {editingId !== null ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Quantity</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={draft.quantity}
                onChange={(e) => setDraft((d) => ({ ...d, quantity: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Unit</Label>
              <Input value={draft.unit} onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))} placeholder="e.g. L, kg, count" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Low-stock alert at (optional)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              className="max-w-xs"
              placeholder="No alert"
              value={draft.low_stock_threshold ?? ""}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  low_stock_threshold: e.target.value === "" ? null : Number(e.target.value),
                }))
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!draft.name.trim() || !draft.unit.trim() || saveStatus === "saving"}>
              {saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
          {saveStatus === "error" && saveError ? (
            <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
          ) : null}
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={startCreate}>
          Add ingredient
        </Button>
      )}
    </div>
  );
}
