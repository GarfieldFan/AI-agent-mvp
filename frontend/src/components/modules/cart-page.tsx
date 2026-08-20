"use client";

import * as React from "react";
import Link from "next/link";
import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { getCart, updateCartItem, updateCartItemComment, type Cart, type CartItem } from "@/lib/cart";
import { getChatSessionId } from "@/lib/chat";

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
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = React.useState<number | null>(null);
  // Per-line action errors (2026-08-20, real bug fix) — was one shared
  // `error` state that a single item's failed action (e.g. trying to
  // adjust an already-served line) replaced the ENTIRE cart view with,
  // even though the cart itself loaded fine and every other line was
  // still perfectly usable. Keyed by item id, rendered inline next to
  // that one line instead — same pattern OrderPanel's own
  // `fieldErrorByOrder` already uses for the identical reason. Only a
  // genuine `getCart()` failure (the cart couldn't load at all) still
  // replaces the whole view, via `loadError` below.
  const [actionErrorByItem, setActionErrorByItem] = React.useState<Record<number, string>>({});

  const refresh = React.useCallback(() => {
    getCart()
      .then((result) => {
        setCart(result);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your cart."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function clearActionError(itemId: number) {
    setActionErrorByItem((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  async function handleAdjust(itemId: number, delta: number) {
    setPendingItemId(itemId);
    try {
      await updateCartItem(itemId, delta);
      clearActionError(itemId);
      refresh();
    } catch (err) {
      setActionErrorByItem((prev) => ({
        ...prev,
        [itemId]: err instanceof ApiError ? err.message : "Couldn't update this item.",
      }));
    } finally {
      setPendingItemId(null);
    }
  }

  async function handleCommentSave(itemId: number, comment: string) {
    try {
      await updateCartItemComment(itemId, comment || null);
      clearActionError(itemId);
      refresh();
    } catch (err) {
      setActionErrorByItem((prev) => ({
        ...prev,
        [itemId]: err instanceof ApiError ? err.message : "Couldn't save your note.",
      }));
    }
  }

  if (loadError) {
    return (
      <Container className="py-10">
        <ErrorMessage description={loadError} onRetry={refresh} />
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
      <PageHeader
        title="Your cart"
        description={`Order #${cart.id} — ${cart.items.length} item${cart.items.length === 1 ? "" : "s"}`}
      />

      <SaveCartLink />

      <Card>
        <CardContent className="space-y-3">
          {cart.items.map((item) => (
            <CartLineRow
              key={item.id}
              item={item}
              pending={pendingItemId === item.id}
              error={actionErrorByItem[item.id]}
              onAdjust={(delta) => handleAdjust(item.id, delta)}
              onCommentSave={(comment) => handleCommentSave(item.id, comment)}
            />
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

/** Copies a link back to this exact cart, carrying `?sid=<session id>`
 * (2026-08-20) — the recovery half of lib/chat.ts's restoreChatSessionId:
 * a visitor who clears localStorage, switches devices, or just wants a
 * bookmark can reopen this cart from that link with no login and no
 * backend lookup. Same mechanism a dine-in table's own printed QR code
 * can use (point it at `https://.../?sid=<id>` directly) — this button
 * just gives an ordinary visitor the same escape hatch. */
function SaveCartLink() {
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    const url = new URL(window.location.origin + "/cart");
    url.searchParams.set("sid", getChatSessionId());
    navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-2 text-xs text-muted-foreground">
      <span>Switching devices, or want to come back later? Save a link to this cart.</span>
      <Button variant="outline" size="sm" onClick={handleCopy}>
        {copied ? "Copied!" : "Copy link"}
      </Button>
    </div>
  );
}

/** One cart line — quantity +/- (target `item.id`, not `product_id`,
 * since a product can now have more than one line with different
 * comments — see lib/cart.ts's updateCartItem doc comment), an editable
 * customization note ("less sugar"), and a read-only "Served" badge
 * once the kitchen has marked it (staff-set, see OrderPanel — this page
 * never writes `served` itself). Quantity controls stay enabled even
 * once `item.product_id` is null (the referenced product was deleted) —
 * the backend always allows decrementing/removing an existing line.
 *
 * **`item.served` locks the whole line** (2026-08-20, real bug fix) —
 * quantity +/-, Remove, and the comment field all disable once a dish
 * has gone out. This mirrors a real server-side check (`/cart/update`
 * and `/cart/item/{id}/comment` both 400 on a served line — see
 * apis/products.py) rather than being purely cosmetic; disabling here
 * is just about not showing a visitor a control that would fail,
 * with an explanation instead of a raw error. Ordering more of the same
 * product opens a new, separate, unserved line (see
 * cart.apply_order_delta's docstring) — the Add-to-cart controls
 * elsewhere in the app are unaffected by a served line. */
function CartLineRow({
  item,
  pending,
  error,
  onAdjust,
  onCommentSave,
}: {
  item: CartItem;
  pending: boolean;
  /** A failed action against THIS line only (e.g. a served-lock 400) —
   * rendered inline below the row, never replaces the rest of the cart. */
  error?: string;
  onAdjust: (delta: number) => void;
  onCommentSave: (comment: string) => void;
}) {
  const [commentDraft, setCommentDraft] = React.useState(item.comment ?? "");
  // Resets the draft when the server's own value changes underneath us
  // (e.g. after a refresh) — adjusting state during render instead of an
  // effect, per React's own "you might not need an effect" pattern, so
  // this doesn't trigger a cascading extra render.
  const [lastSeenComment, setLastSeenComment] = React.useState(item.comment);
  if (item.comment !== lastSeenComment) {
    setLastSeenComment(item.comment);
    setCommentDraft(item.comment ?? "");
  }

  return (
    <div className="space-y-1.5 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {item.item_name_snapshot}
            {item.served ? (
              <Badge variant="outline" className="ml-2 text-xs">
                Served
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">${item.unit_price_snapshot.toFixed(2)} each</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Decrease quantity"
            disabled={pending || item.served}
            onClick={() => onAdjust(-1)}
          >
            <Minus className="size-3" />
          </Button>
          <span className="w-6 text-center text-sm">{item.quantity}</span>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Increase quantity"
            disabled={pending || item.served || item.product_id == null}
            onClick={() => onAdjust(1)}
          >
            <Plus className="size-3" />
          </Button>
        </div>
        <p className="w-16 text-right text-sm font-medium">${item.subtotal.toFixed(2)}</p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Remove"
          disabled={pending || item.served}
          onClick={() => onAdjust(-item.quantity)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <Input
        value={commentDraft}
        onChange={(e) => setCommentDraft(e.target.value)}
        onBlur={() => {
          if (commentDraft.trim() !== (item.comment ?? "")) onCommentSave(commentDraft.trim());
        }}
        placeholder={item.served ? "Note locked — already served" : "Add a note (e.g. less sugar, extra spicy)"}
        disabled={item.served}
        className="h-8 text-xs"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
