"use client";

import * as React from "react";

import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ProductCard } from "@/components/modules/product-card";
import { Editable } from "@/components/theme/cte/editable";
import { listPublicProducts, type Product } from "@/lib/products";
import type { ProductListBlock as ProductListBlockData } from "@/lib/theme";

/** A grid of products from the owner's catalog (2026-08-19) — one of the
 * few block types that fetch data: most other Block components just
 * render their own schema props. Fetches **client-side**, not
 * server-side — `BlockRenderer` (the recursive dispatcher that renders
 * every Block type, including this one) is itself a Client Component
 * (needs the CTE editing interactivity), and a Client Component can't
 * render an async Server Component as a child. `listPublicProducts`
 * (lib/products.ts, via apiFetch) resolves `NEXT_PUBLIC_API_URL`
 * automatically on the client — no CORS issue, this is a plain public
 * unauthenticated GET.
 *
 * `product_ids` (2026-08-20) takes priority over `tags` when both are
 * set — see lib/theme.ts's ProductListBlock doc comment. Also gained a
 * real `Editable` wrapper this same day — before this, an inserted
 * product-list block had no way to actually set its filter at all once
 * placed (BlockInsertMenu only ever creates the unfiltered default). */
export function ProductListBlock({ tags, product_ids, path }: ProductListBlockData & { path: string }) {
  const [products, setProducts] = React.useState<Product[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    listPublicProducts(tags ?? null, product_ids ?? null)
      .then((result) => {
        if (!cancelled) setProducts(result);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tags, product_ids]);

  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-product-list"
      value={{ type: "product-list", tags, product_ids }}
    >
      {products === null ? (
        <LoadingSpinner label="Loading products…" />
      ) : products.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products to show yet.</p>
      ) : (
        <div className="flex flex-wrap gap-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </Editable>
  );
}
