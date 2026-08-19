"use client";

import * as React from "react";
import Link from "next/link";
import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getCart, updateCartItem, type Cart } from "@/lib/cart";

/** `/cart` (2026-08-20) — the real system page every "Add to cart"
 * control (ProductCard, ProductDetail, an owner-composed add-to-cart
 * Block, the chatbot's own product cards) has been quietly building up an
 * Order for, with nowhere to actually go look at it until now. Reads and
 * mutates via the same session-scoped Order every one of those surfaces
 * already shares (lib/cart.ts) — no separate cart state of its own.
 *
 * No payment anywhere in this app (see the root AGENTS.md) — this page's
 * job ends at "review what's in the cart, adjust it, move on to
 * checkout." Client Component: `getChatSessionId()` (lib/chat.ts) reads
 * `localStorage`, unavailable during a server render — same reasoning
 * ProductListBlock's own docstring already documents. */
export function CartPage() {
  const [cart, setCart] = React.useState<Cart | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingProductId, setPendingProductId] = React.useState<number | null>(null);

  const refresh = React.useCallback(() => {
    getCart()
      .then((result) => {
        setCart(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your cart."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleAdjust(productId: number, delta: number) {
    setPendingProductId(productId);
    try {
      await updateCartItem(productId, delta);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update your cart.");
    } finally {
      setPendingProductId(null);
    }
  }

  if (error) {
    return (
      <Container className="py-10">
        <ErrorMessage description={error} onRetry={refresh} />
      </Container>
    );
  }

  if (cart === undefined) {
    return (
      <Container className="py-10">
        <LoadingSpinner label="Loading your cart…" />
      </Container>
    );
  }

  if (cart === null || cart.items.length === 0) {
    return (
      <Container className="py-10">
        <PageHeader title="Your cart" description="Nothing here yet." />
        <EmptyState
          icon={ShoppingCart}
          title="Your cart is empty"
          description="Browse the catalog and add something to get started."
          action={
            <Button render={<Link href="/search" />} nativeButton={false}>
              Browse products
            </Button>
          }
        />
      </Container>
    );
  }

  return (
    <Container className="max-w-2xl space-y-6 py-10">
      <PageHeader title="Your cart" description={`${cart.items.length} item${cart.items.length === 1 ? "" : "s"}`} />

      <Card>
        <CardContent className="space-y-3">
          {cart.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.item_name_snapshot}</p>
                <p className="text-xs text-muted-foreground">${item.unit_price_snapshot.toFixed(2)} each</p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Decrease quantity"
                  disabled={item.product_id == null || pendingProductId === item.product_id}
                  onClick={() => item.product_id != null && handleAdjust(item.product_id, -1)}
                >
                  <Minus className="size-3" />
                </Button>
                <span className="w-6 text-center text-sm">{item.quantity}</span>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Increase quantity"
                  disabled={item.product_id == null || pendingProductId === item.product_id}
                  onClick={() => item.product_id != null && handleAdjust(item.product_id, 1)}
                >
                  <Plus className="size-3" />
                </Button>
              </div>
              <p className="w-16 text-right text-sm font-medium">${item.subtotal.toFixed(2)}</p>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove"
                disabled={item.product_id == null || pendingProductId === item.product_id}
                onClick={() => item.product_id != null && handleAdjust(item.product_id, -item.quantity)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </CardContent>
        <CardFooter className="flex items-center justify-between border-t">
          <span className="text-sm font-medium">Total</span>
          <span className="text-lg font-semibold">${cart.total_amount.toFixed(2)}</span>
        </CardFooter>
      </Card>

      <Button render={<Link href="/checkout" />} nativeButton={false} className="w-full" size="lg">
        Proceed to checkout
      </Button>
    </Container>
  );
}
