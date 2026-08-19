"use client";

import * as React from "react";
import Link from "next/link";
import { ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import { addToCart } from "@/lib/cart";
import { ApiError } from "@/lib/api";

export type ProductCardData = {
  id: number;
  name: string;
  price: number;
  image_url?: string | null;
};

/** One component, several call sites (2026-08-19): the ProductList Block,
 * `/search` results, and the chatbot's own product cards/swiper — same
 * image/name/price/Add-to-cart shape everywhere, so a visitor sees the
 * same thing whether they're browsing a page or talking to the chatbot.
 * Clicking the image/name navigates to the product's own page
 * (`/products/[id]`); Add to cart calls the shared, deterministic
 * `POST /api/cart/add` (lib/cart.ts) directly — no chat/LLM involved. */
export function ProductCard({ product }: { product: ProductCardData }) {
  const [status, setStatus] = React.useState<"idle" | "adding" | "added" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  async function handleAddToCart() {
    setStatus("adding");
    setError(null);
    try {
      await addToCart(product.id, 1);
      setStatus("added");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add to cart.");
      setStatus("error");
    }
  }

  return (
    <Card size="sm" className="w-full max-w-56">
      <Link href={`/products/${product.id}`} className="block">
        <div className="aspect-square w-full overflow-hidden">
          <ThemeImageBox image={product.image_url ? { url: product.image_url, alt: product.name } : undefined} />
        </div>
      </Link>
      <CardContent className="space-y-1 pt-2">
        <Link href={`/products/${product.id}`} className="line-clamp-1 text-sm font-medium hover:underline">
          {product.name}
        </Link>
        <p className="text-sm text-muted-foreground">${product.price.toFixed(2)}</p>
      </CardContent>
      <CardFooter className="border-t-0 bg-transparent p-0 px-(--card-spacing) pb-(--card-spacing)">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={status === "adding"}
          onClick={handleAddToCart}
        >
          <ShoppingCart className="size-3.5" />
          {status === "added" ? "Added" : status === "adding" ? "Adding…" : "Add to cart"}
        </Button>
      </CardFooter>
      {status === "error" && error ? <p className="px-(--card-spacing) pb-2 text-xs text-destructive">{error}</p> : null}
    </Card>
  );
}
