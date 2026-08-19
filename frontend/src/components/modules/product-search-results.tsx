import { SearchX } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { ProductCard } from "@/components/modules/product-card";
import type { Product } from "@/lib/products";

type ProductSearchResultsProps = {
  query: string;
  products: Product[];
};

/** Plain Server Component — no fetching/interactivity of its own, just
 * renders the already-fetched results as the same ProductCard grid
 * ProductListBlock uses. Rendering ProductCard (a Client Component) from
 * here is fine; the constraint that forced ProductListBlock client-side
 * only applies the other way around (a Client Component can't render an
 * async Server Component). */
export function ProductSearchResults({ query, products }: ProductSearchResultsProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-xl font-semibold">
          {query ? <>Search results for &quot;{query}&quot;</> : "Search"}
        </h1>
        <p className="text-sm text-muted-foreground">{products.length} product{products.length === 1 ? "" : "s"} found</p>
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
    </div>
  );
}
