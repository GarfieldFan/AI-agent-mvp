"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { StripeCheckoutDialog } from "@/components/modules/stripe-checkout-dialog";
import { ApiError } from "@/lib/api";
import { checkoutCart, getCart, type Cart } from "@/lib/cart";
import { getPaymentConfig } from "@/lib/payments";

/** `/checkout` (2026-08-20, payment gate added same day — see
 * backend/payments.py) — finalizes the same session-scoped cart
 * `/cart` reads (lib/cart.ts). "Place order" goes through the owner's
 * configured payment gate: the default "test" provider marks the order
 * paid immediately with no real charge; a real Stripe provider instead
 * opens Stripe's own embedded Checkout in a popup on this page
 * (2026-09-10, `StripeCheckoutDialog` — a `client_secret` in the
 * response, not a redirect URL, see backend/payments.py's own docstring
 * for the "why" behind embedded over a full-page redirect). A prefilled
 * `contact_email`/`contact_name` (if the cart already carries one, e.g.
 * from an earlier chat turn) is editable, never locked. */
export function CheckoutPage() {
  const [cart, setCart] = React.useState<Cart | null | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [pickupTime, setPickupTime] = React.useState("");
  const [note, setNote] = React.useState("");

  const [placing, setPlacing] = React.useState(false);
  const [placeError, setPlaceError] = React.useState<string | null>(null);
  const [placedOrder, setPlacedOrder] = React.useState<Cart | null>(null);

  // Stripe embedded Checkout (2026-09-10) — the publishable key is fetched
  // once, up front, so it's already in hand by the time "Place order"
  // actually needs it; the dialog itself only opens once a real
  // client_secret comes back from POST /cart/checkout.
  const [publishableKey, setPublishableKey] = React.useState<string | null>(null);
  const [checkoutClientSecret, setCheckoutClientSecret] = React.useState<string | null>(null);

  React.useEffect(() => {
    getPaymentConfig()
      .then((config) => setPublishableKey(config.provider === "stripe" ? config.publishable_key : null))
      .catch(() => setPublishableKey(null));
  }, []);

  React.useEffect(() => {
    getCart()
      .then((result) => {
        setCart(result);
        setEmail(result?.contact_email ?? "");
        setName(result?.contact_name ?? "");
        setPickupTime(result?.pickup_time ?? "");
        setNote(result?.note ?? "");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your cart."));
  }, []);

  async function handlePlaceOrder() {
    setPlacing(true);
    setPlaceError(null);
    try {
      const result = await checkoutCart({
        contact_email: email.trim() || null,
        contact_name: name.trim() || null,
        pickup_time: pickupTime.trim() || null,
        note: note.trim() || null,
      });
      if (result.client_secret) {
        setCheckoutClientSecret(result.client_secret);
        return;
      }
      setPlacedOrder(result.order);
    } catch (err) {
      setPlaceError(err instanceof ApiError ? err.message : "Couldn't place your order — please try again.");
    } finally {
      setPlacing(false);
    }
  }

  if (placedOrder) {
    return (
      <Container className="max-w-lg py-10">
        <EmptyState
          icon={CheckCircle2}
          title="Order placed"
          description={`Order #${placedOrder.id} — total $${placedOrder.total_amount.toFixed(2)}. No real payment was collected (test mode); the team will follow up on ${placedOrder.contact_email ?? "the contact info you provided"}.`}
          action={
            <Button render={<Link href="/" />} nativeButton={false} variant="outline">
              Back to home
            </Button>
          }
        />
      </Container>
    );
  }

  if (loadError) {
    return (
      <Container className="py-10">
        <ErrorMessage description={loadError} />
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
        <PageHeader title="Checkout" />
        <EmptyState
          icon={ShoppingCart}
          title="Your cart is empty"
          description="Add something to your cart before checking out."
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
        title="Checkout"
        description={`Order #${cart.id} — review your order, then place it.`}
      />

      <Card>
        <CardContent className="space-y-2">
          {cart.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm">
              <span>
                {item.quantity}× {item.item_name_snapshot}
              </span>
              <span className="text-muted-foreground">${item.subtotal.toFixed(2)}</span>
            </div>
          ))}
        </CardContent>
        <CardFooter className="flex items-center justify-between border-t">
          <span className="text-sm font-medium">Total</span>
          <span className="text-lg font-semibold">${cart.total_amount.toFixed(2)}</span>
        </CardFooter>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Name (optional)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Pickup / delivery time (optional)</Label>
            <Input value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} placeholder="e.g. 9am, ASAP" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Note (optional)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
        </CardContent>
      </Card>

      {placeError ? <ErrorMessage description={placeError} onRetry={() => setPlaceError(null)} /> : null}

      <Button size="lg" className="w-full" disabled={placing} onClick={handlePlaceOrder}>
        {placing ? "Placing order…" : "Place order"}
      </Button>

      {checkoutClientSecret && publishableKey ? (
        <StripeCheckoutDialog
          open
          onOpenChange={(open) => {
            if (!open) setCheckoutClientSecret(null);
          }}
          publishableKey={publishableKey}
          clientSecret={checkoutClientSecret}
        />
      ) : null}
    </Container>
  );
}
