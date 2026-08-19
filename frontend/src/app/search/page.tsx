import { ProductSearchResults } from "@/components/modules/product-search-results";
import { searchPublicProducts } from "@/lib/products";

export const dynamic = "force-dynamic";

/** The page a chat reply links to when a search/browse phrase matched
 * more than the chat's own display cap (2026-08-19, see
 * backend/apis/chat.py's `_order_turn_response_fields`) — re-runs the
 * exact same deterministic SQL search (cart.search_products, via
 * GET /api/products/search) live on load. No caching/persistence of the
 * result set: a real, explicit design call — "avoiding resource waste"
 * here means never re-invoking an LLM on page load, not persisting a
 * result snapshot, confirmed directly with the user. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const results = query ? await searchPublicProducts(query).catch(() => ({ products: [] })) : { products: [] };

  return <ProductSearchResults query={query} products={results.products} />;
}
