import { apiFetch } from "@/lib/api";

/** Generic, owner-defined product catalog (2026-08-19) — modeled on
 * WooCommerce's product concept rather than anything restaurant- or
 * retail-specific. See backend/models.py's Product docstring: created
 * either directly here (ProductPanel's own form) or via an owner-agent
 * `propose_products` draft the owner reviews and Applies in
 * OwnerAgentPanel — never written by owner-agent directly, since a
 * misread price affects what a real customer is quoted. */

export type RelationSummary = {
  relation_id: number;
  product_id: number;
  name: string;
  price: number;
  image_url: string | null;
  quantity: number | null;
};

export type Product = {
  id: number;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  available: boolean;
  image_url: string | null;
  custom_fields: Record<string, string>;
  created_at: string;
  bundle_items: RelationSummary[];
  upsells: RelationSummary[];
};

export type ProductInput = {
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  available: boolean;
  image_url?: string | null;
  custom_fields?: Record<string, string>;
};

export function listProducts() {
  return apiFetch<Product[]>("/api/agent/products");
}

// --- Product custom-field definitions (admin) -----------------------------

export type ProductFieldType = "text" | "number" | "date" | "note" | "link";

export type ProductFieldDefinition = {
  id: number;
  field_key: string;
  label: string;
  field_type: ProductFieldType;
  required: boolean;
  sort_order: number;
};

export type ProductFieldInput = {
  field_key: string;
  label: string;
  field_type: ProductFieldType;
  required: boolean;
};

export const PRODUCT_FIELD_TYPE_OPTIONS: { value: ProductFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "note", label: "Note (long text)" },
  { value: "link", label: "Link" },
];

export function listProductFields() {
  return apiFetch<ProductFieldDefinition[]>("/api/agent/product-fields");
}

export function createProductField(input: ProductFieldInput) {
  return apiFetch<ProductFieldDefinition>("/api/agent/product-fields", { method: "POST", body: input });
}

export function updateProductField(id: number, input: ProductFieldInput) {
  return apiFetch<ProductFieldDefinition>(`/api/agent/product-fields/${id}`, { method: "PUT", body: input });
}

export function deleteProductField(id: number) {
  return apiFetch<void>(`/api/agent/product-fields/${id}`, { method: "DELETE" });
}

// --- Product relations (bundle/upsell, admin) -----------------------------

export type ProductRelationType = "bundle" | "upsell";

export function addProductRelation(
  productId: number,
  input: { related_product_id: number; relation_type: ProductRelationType; quantity?: number | null },
) {
  return apiFetch<RelationSummary>(`/api/agent/products/${productId}/relations`, { method: "POST", body: input });
}

export function deleteProductRelation(productId: number, relationId: number) {
  return apiFetch<void>(`/api/agent/products/${productId}/relations/${relationId}`, { method: "DELETE" });
}

// --- Public storefront reads (no auth) ------------------------------------
// Mirrors backend/apis/products.py's public_router — used by the
// ProductList Block (client-side — see that component's docstring for
// why, not server-side despite /products/[id] and /search being real
// Server Components), /products/[id], /search, and nothing else needs
// auth here since these are plain reads of available products.

/** `ids` (2026-08-20), when given, takes priority over `category` on the
 * backend — see apis/products.py's list_public_products docstring. Result
 * order matches the given `ids` order, not creation order. */
export function listPublicProducts(category?: string | null, ids?: number[] | null) {
  const params = new URLSearchParams();
  if (ids && ids.length > 0) {
    params.set("ids", ids.join(","));
  } else if (category) {
    params.set("category", category);
  }
  const qs = params.toString();
  return apiFetch<Product[]>(`/api/products${qs ? `?${qs}` : ""}`);
}

/** Returns null on a 404 (missing/unavailable product) rather than
 * throwing — mirrors lib/pages.ts's getPublicPage exactly, so
 * /products/[id]/page.tsx can call notFound() the same way. */
export async function getPublicProduct(id: number): Promise<Product | null> {
  try {
    return await apiFetch<Product>(`/api/products/${id}`);
  } catch {
    return null;
  }
}

export function searchPublicProducts(query: string, limit = 20) {
  return apiFetch<{ products: Product[] }>(
    `/api/products/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

/** Field labels for rendering Product.custom_fields on the public detail
 * page — same rows as listProductFields (admin), reachable without a
 * token since a label like "Warranty" isn't sensitive. */
export function listPublicProductFields() {
  return apiFetch<ProductFieldDefinition[]>("/api/product-fields");
}

export function createProduct(input: ProductInput) {
  return apiFetch<Product>("/api/agent/products", { method: "POST", body: input });
}

export function updateProduct(id: number, input: ProductInput) {
  return apiFetch<Product>(`/api/agent/products/${id}`, { method: "PUT", body: input });
}

/** No undo — OrderItem rows that reference this product keep their
 * item_name_snapshot/unit_price_snapshot (a historical record), they
 * just lose the link back to a product that no longer exists. */
export function deleteProduct(id: number) {
  return apiFetch<void>(`/api/agent/products/${id}`, { method: "DELETE" });
}
