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
  tags: string[];
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
  tags: string[];
  available: boolean;
  image_url?: string | null;
  custom_fields?: Record<string, string>;
};

export type ProductListResult = {
  items: Product[];
  total: number;
};

/** Paginated (2026-08-20, was a plain unbounded fetch — see the root
 * `AGENTS.md`). `limit`/`offset` default to a single, effectively-
 * unpaginated page (matches the backend's own default) for any caller
 * that doesn't care about paging; `ProductPanel` always passes its own
 * page size explicitly. */
export function listProducts(limit = 100, offset = 0) {
  return apiFetch<ProductListResult>(`/api/agent/products?limit=${limit}&offset=${offset}`);
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

/** `ids` (2026-08-20), when given, takes priority over `tags` on the
 * backend — see apis/products.py's list_public_products docstring. Result
 * order matches the given `ids` order, not creation order. `tags` is
 * comma-separated and OR-matched (any tag present is a hit) — see
 * cart.search_products' docstring for why tags replaced the old single
 * `category` string (2026-08-20, fixes cross-lingual matching too). */
export function listPublicProducts(tags?: string[] | null, ids?: number[] | null) {
  const params = new URLSearchParams();
  if (ids && ids.length > 0) {
    params.set("ids", ids.join(","));
  } else if (tags && tags.length > 0) {
    params.set("tags", tags.join(","));
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

/** `offset`/`total` in the response (2026-08-20) close a real known
 * gap: this used to hard-cap at `limit` with no "showing X of N"
 * signal — a query matching more than `limit` products silently
 * dropped the rest with no indication anything was cut off. */
export function searchPublicProducts(query: string, limit = 20, offset = 0) {
  return apiFetch<{ products: Product[]; total: number }>(
    `/api/products/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
  );
}

/** Field labels for rendering Product.custom_fields on the public detail
 * page — same rows as listProductFields (admin), reachable without a
 * token since a label like "Warranty" isn't sensitive. */
export function listPublicProductFields() {
  return apiFetch<ProductFieldDefinition[]>("/api/product-fields");
}

/** Builds a schema.org Product+Offer JSON-LD object for one product page
 * (2026-09-08, GEO push part 2 — see the root AGENTS.md's GEO/business-
 * profile section) — mirrors `lib/business-profile.ts`'s
 * `buildLocalBusinessJsonLd` exactly: pure formatting, no network I/O,
 * so it's usable from a Server Component. Every optional field
 * (description/image) is omitted rather than emitted empty, same
 * "smaller, honest block" posture as that function.
 *
 * `priceCurrency` has no real data source anywhere in this app —
 * `Product.price` is a bare `Numeric`, no currency column exists (the
 * only other place a currency shows up at all is `payments.py`'s
 * hardcoded Stripe `"usd"`). Hardcoded to `"USD"` here to match that,
 * not a guess — a real multi-currency feature is out of scope for this
 * pass. */
export function buildProductJsonLd(product: Product, siteUrl: string): Record<string, unknown> {
  const url = `${siteUrl}/products/${product.id}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    url,
    ...(product.description ? { description: product.description } : {}),
    ...(product.image_url ? { image: product.image_url } : {}),
    offers: {
      "@type": "Offer",
      url,
      price: product.price.toFixed(2),
      priceCurrency: "USD",
      availability: product.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
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
