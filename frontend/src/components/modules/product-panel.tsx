"use client";

import * as React from "react";
import { Package, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ImageFieldEditor } from "@/components/theme/cte/image-field-editor";
import { ApiError } from "@/lib/api";
import {
  createProduct,
  deleteProduct,
  listProducts,
  updateProduct,
  type Product,
  type ProductInput,
} from "@/lib/products";

function blankDraft(): ProductInput {
  return { name: "", description: "", price: 0, tags: [], available: true, image_url: null };
}

function draftFromProduct(product: Product): ProductInput {
  return {
    name: product.name,
    description: product.description ?? "",
    price: product.price,
    tags: product.tags,
    available: product.available,
    image_url: product.image_url,
  };
}

/** Generic, owner-defined product catalog (2026-08-19) — modeled on
 * WooCommerce's product concept rather than anything restaurant- or
 * retail-specific: a menu item, a physical good, a virtual good, a
 * bookable service, whatever the owner sells. Direct CRUD only — the
 * owner-agent-drafted proposal review lives in OwnerAgentPanel instead
 * (mirrors IntentSchemaPanel staying plain CRUD while the schema-
 * proposal review card lives there too), since a misread price directly
 * affects what a real customer is quoted. */
const PAGE_SIZE = 20;

export function ProductPanel() {
  const [products, setProducts] = React.useState<Product[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [listError, setListError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const [editingId, setEditingId] = React.useState<number | "new" | null>(null);
  const [draft, setDraft] = React.useState<ProductInput>(blankDraft());
  const [tagsText, setTagsText] = React.useState("");
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    listProducts(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .then((result) => {
        setProducts(result.items);
        setTotal(result.total);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load products."));
  }, [page]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function startCreate() {
    setDraft(blankDraft());
    setTagsText("");
    setEditingId("new");
    setSaveStatus("idle");
    setSaveError(null);
  }

  function startEdit(product: Product) {
    setDraft(draftFromProduct(product));
    setTagsText(product.tags.join(", "));
    setEditingId(product.id);
    setSaveStatus("idle");
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleSave() {
    if (!draft.name.trim() || editingId === null) return;
    setSaveStatus("saving");
    setSaveError(null);
    const payload: ProductInput = {
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      price: draft.price,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      available: draft.available,
      image_url: draft.image_url || null,
    };
    try {
      if (editingId === "new") {
        await createProduct(payload);
        setEditingId(null);
        // A new product sorts first (most-recent-first order) — jump
        // back to page 1 so it's actually visible, rather than leaving
        // the view on whatever page was open when Save was clicked.
        if (page === 1) refresh();
        else setPage(1);
      } else {
        await updateProduct(editingId, payload);
        setEditingId(null);
        refresh();
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleDelete(product: Product) {
    if (!window.confirm(`Delete "${product.name}"? Past orders keep their own price/name record.`)) return;
    setDeletingId(product.id);
    try {
      await deleteProduct(product.id);
      // Deleting the only item left on a page (other than page 1) would
      // otherwise strand the view on a now-empty page — step back one
      // instead; the effect above re-fetches on the resulting page change.
      if (products?.length === 1 && page > 1) {
        setPage((p) => p - 1);
      } else {
        refresh();
      }
    } catch {
      // Best-effort — a failed delete just leaves the product in the list, no separate error UI needed here.
    } finally {
      setDeletingId(null);
    }
  }

  if (listError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={listError} onRetry={refresh} />
      </div>
    );
  }

  if (!products) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading products…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Package className="h-5 w-5" />
          Products
        </h3>
        <p className="text-xs text-muted-foreground">
          Anything orderable — a menu item, a physical good, a service. The chatbot orders against
          whatever&apos;s available here; tell the owner agent about your catalog and it can draft
          products for you to review below in Owner agent.
        </p>
      </div>

      {total === 0 && editingId === null ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add one below, or describe your catalog to the owner agent and review its draft."
        />
      ) : null}

      {total > 0 ? <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} /> : null}

      <div className="space-y-2">
        {products.map((product) =>
          editingId === product.id ? null : (
            <div key={product.id} className="flex items-center justify-between gap-2 rounded-lg border p-3">
              <div className="flex items-center gap-3">
                {product.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- host unknown ahead of time, same as ThemeImageBox
                  <img
                    src={product.image_url}
                    alt={product.name}
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-dashed text-muted-foreground">
                    <Package className="size-4" />
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium">
                    {product.name} — ${product.price.toFixed(2)}
                    {!product.available ? <Badge variant="outline" className="ml-2 text-xs">unavailable</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {product.tags.length > 0 ? `${product.tags.join(", ")} — ` : ""}
                    {product.description}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => startEdit(product)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete product"
                  disabled={deletingId === product.id}
                  onClick={() => handleDelete(product)}
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
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Photo (optional)</Label>
            <ImageFieldEditor
              value={{ url: draft.image_url || "#", alt: draft.name }}
              onChange={(image) => setDraft((d) => ({ ...d, image_url: image.url === "#" ? null : image.url }))}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Price</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={draft.price}
                onChange={(e) => setDraft((d) => ({ ...d, price: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Tags (comma-separated, optional)</Label>
              <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="e.g. Coffee, 咖啡" />
            </div>
            <div className="flex items-center gap-1.5 pt-5">
              <Switch
                checked={draft.available}
                onCheckedChange={(checked) => setDraft((d) => ({ ...d, available: checked }))}
              />
              <Label className="text-xs text-muted-foreground">Available</Label>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Description (optional)</Label>
            <Textarea
              value={draft.description ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              rows={2}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!draft.name.trim() || saveStatus === "saving"}>
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
        <Button variant="outline" onClick={startCreate}>
          <Plus className="size-4" />
          New product
        </Button>
      )}
    </div>
  );
}
