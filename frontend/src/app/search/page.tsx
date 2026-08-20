import { ProductSearchResults } from "@/components/modules/product-search-results";
import { searchPublicProducts } from "@/lib/products";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

/** The page a chat reply links to when a search/browse phrase matched
 * more than the chat's own display cap (2026-08-19, see
 * backend/apis/chat.py's `_order_turn_response_fields`) — re-runs the
 * exact same deterministic SQL search (cart.search_products, via
 * GET /api/products/search) live on load. No caching/persistence of the
 * result set: a real, explicit design call — "avoiding resource waste"
 * here means never re-invoking an LLM on page load, not persisting a
 * result snapshot, confirmed directly with the user.
 *
 * `?page=` (2026-08-20) closes this page's own long-documented "known
 * gap" — a result set past `PAGE_SIZE` used to just silently truncate
 * with no way to see the rest. Page-number, not "load more": a plain
 * server-rendered `Link` needs no client JS at all, matching this
 * route's existing "no client state" posture; the user's own call was
 * page numbers everywhere for now, an infinite-scroll variant is a
 * possible later revisit for this specific customer-facing list, not
 * the admin dashboards. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: pageParam } = await searchParams;
  const query = q?.trim() ?? "";
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const results = query
    ? await searchPublicProducts(query, PAGE_SIZE, offset).catch(() => ({ products: [], total: 0 }))
    : { products: [], total: 0 };

  return (
    <ProductSearchResults
      query={query}
      products={results.products}
      total={results.total}
      page={page}
      pageSize={PAGE_SIZE}
    />
  );
}
