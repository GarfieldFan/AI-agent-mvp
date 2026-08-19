"use client";

import * as React from "react";

import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ProductCard } from "@/components/modules/product-card";
import { Editable } from "@/components/theme/cte/editable";
import { getPublicProduct, type Product } from "@/lib/products";
import type { ProductCardBlock as ProductCardBlockData } from "@/lib/theme";

/** A single featured product card (2026-08-20) — ProductListBlock's
 * one-item counterpart, for featuring ONE product somewhere a full grid
 * doesn't fit (a homepage strip, a swiper slide). Fetches client-side for
 * the same reason ProductListBlock does — see that component's own
 * docstring (BlockRenderer, the recursive dispatcher rendering every
 * Block type including this one, is a Client Component, and a Client
 * Component can't render an async Server Component as a child). Reuses
 * `getPublicProduct`, the exact same call `/products/[id]`'s Server
 * Component page makes, just triggered from `useEffect` here instead of
 * awaited at render time. */
export function ProductCardBlock({ product_id, path }: ProductCardBlockData & { path: string }) {
  // undefined = still fetching (or nothing to fetch yet); null = fetched,
  // not found. Only ever set from the effect's own async callback, never
  // synchronously in the effect body — a stale value briefly surviving a
  // product_id change (until the new fetch resolves) is harmless here,
  // same tradeoff ProductListBlock's own refetch makes.
  const [product, setProduct] = React.useState<Product | null | undefined>(undefined);

  React.useEffect(() => {
    if (product_id == null) return;
    let cancelled = false;
    getPublicProduct(product_id).then((result) => {
      if (!cancelled) setProduct(result);
    });
    return () => {
      cancelled = true;
    };
  }, [product_id]);

  return (
    <Editable as="div" path={path} fieldType="block-product-card" value={{ type: "product-card", product_id }}>
      {product_id == null ? (
        <p className="text-sm text-muted-foreground">No product picked yet — edit this block to choose one.</p>
      ) : product === undefined ? (
        <LoadingSpinner label="Loading product…" />
      ) : product === null ? (
        <p className="text-sm text-muted-foreground">Product not found.</p>
      ) : (
        <ProductCard product={product} />
      )}
    </Editable>
  );
}
