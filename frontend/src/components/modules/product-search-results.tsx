import Link from "next/link";
import { ChevronLeft, ChevronRight, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { ProductCard } from "@/components/modules/product-card";
import type { Product } from "@/lib/products";

type ProductSearchResultsProps = {
  query: string;
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
};

/** Plain Server Component — no fetching/interactivity of its own, just
 * renders the already-fetched results as the same ProductCard grid
 * ProductListBlock uses. Rendering ProductCard (a Client Component) from
 * here is fine; the constraint that forced ProductListBlock client-side
 * only applies the other way around (a Client Component can't render an
 * async Server Component).
 *
 * Pagination (2026-08-20) is plain `Link`s to `?q=...&page=N` — no client
 * state needed, `/search`'s own page.tsx already re-fetches on every
 * request. Reuses `total`/`page`/`pageSize` from the server fetch rather
 * than the shared client-side `Pagination` component (`components/
 * common/pagination.tsx`), which is built around an `onPageChange`
 * callback that doesn't fit a Server Component. */
export function ProductSearchResults({ query, products, total, page, pageSize }: ProductSearchResultsProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  const q = encodeURIComponent(query);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-xl font-semibold">
          {query ? <>Search results for &quot;{query}&quot;</> : "Search"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {total === 0 ? "0 products found" : `Showing ${rangeStart}–${rangeEnd} of ${total} product${total === 1 ? "" : "s"}`}
        </p>
      </div>

      {products.length === 0 ? (
        <EmptyState icon={SearchX} title="No products found" description="Try a different search term." />
      ) : (
        <div className="flex flex-wrap gap-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}

      {total > pageSize ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            {page <= 1 ? (
              <Button variant="outline" size="icon-xs" aria-label="Previous page" disabled>
                <ChevronLeft className="size-3.5" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Previous page"
                nativeButton={false}
                render={<Link href={`/search?q=${q}&page=${page - 1}`} />}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
            )}
            {page >= pageCount ? (
              <Button variant="outline" size="icon-xs" aria-label="Next page" disabled>
                <ChevronRight className="size-3.5" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Next page"
                nativeButton={false}
                render={<Link href={`/search?q=${q}&page=${page + 1}`} />}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
