"use client";

import * as React from "react";
import { ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import { ProductCard } from "@/components/modules/product-card";
import { addToCart } from "@/lib/cart";
import { ApiError } from "@/lib/api";
import type { Product, ProductFieldDefinition } from "@/lib/products";

type ProductDetailProps = {
  product: Product;
  fieldDefinitions: ProductFieldDefinition[];
};

/** The dedicated, stable, bookmarkable page every product gets
 * (2026-08-19, /products/[id]) — deliberately NOT a CTE block (see the
 * root AGENTS.md): people keep detail tabs open to compare products, so
 * this is routing, not something an owner drags into a page. Renders
 * `custom_fields` against `fieldDefinitions` the same label→value way
 * ReviewQueuePanel already renders `collected_fields` against a schema's
 * fields. */
export function ProductDetail({ product, fieldDefinitions }: ProductDetailProps) {
  const [quantity, setQuantity] = React.useState(1);
  const [status, setStatus] = React.useState<"idle" | "adding" | "added" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  async function handleAddToCart() {
    setStatus("adding");
    setError(null);
    try {
      await addToCart(product.id, quantity);
      setStatus("added");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add to cart.");
      setStatus("error");
    }
  }

  const customFieldEntries = fieldDefinitions
    .map((field) => ({ field, value: product.custom_fields[field.field_key] }))
    .filter((entry) => entry.value);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <div className="grid gap-8 sm:grid-cols-2">
        <div className="aspect-square w-full overflow-hidden rounded-xl">
          <ThemeImageBox image={product.image_url ? { url: product.image_url, alt: product.name } : undefined} />
        </div>
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-bold">{product.name}</h1>
            {product.tags.length > 0 ? (
              <p className="text-sm text-muted-foreground">{product.tags.join(", ")}</p>
            ) : null}
          </div>
          <p className="text-xl font-semibold">${product.price.toFixed(2)}</p>
          {product.description ? <p className="text-sm leading-relaxed">{product.description}</p> : null}

          {customFieldEntries.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 p-3 text-sm">
              {customFieldEntries.map(({ field, value }) => (
                <React.Fragment key={field.id}>
                  <dt className="font-medium text-muted-foreground">{field.label}</dt>
                  <dd>
                    {field.field_type === "link" ? (
                      <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        {value}
                      </a>
                    ) : (
                      value
                    )}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}

          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
              className="w-20"
            />
            <Button disabled={status === "adding"} onClick={handleAddToCart}>
              <ShoppingCart className="size-4" />
              {status === "added" ? "Added" : status === "adding" ? "Adding…" : "Add to cart"}
            </Button>
          </div>
          {status === "error" && error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </div>

      {product.bundle_items.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Included in this bundle</h2>
          <div className="flex flex-wrap gap-4">
            {product.bundle_items.map((item) => (
              <ProductCard
                key={item.relation_id}
                product={{ id: item.product_id, name: item.name, price: item.price, image_url: item.image_url }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {product.upsells.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">You might also like</h2>
          <div className="flex flex-wrap gap-4">
            {product.upsells.map((item) => (
              <ProductCard
                key={item.relation_id}
                product={{ id: item.product_id, name: item.name, price: item.price, image_url: item.image_url }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
