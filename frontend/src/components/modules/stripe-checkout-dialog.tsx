"use client";

import * as React from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// One Stripe.js instance per publishable key, reused across opens of
// this dialog within the same page load — loadStripe() itself already
// memoizes by key, but caching the promise here too avoids re-triggering
// its own script-injection logic on every dialog open.
const stripePromiseCache = new Map<string, Promise<Stripe | null>>();

function getStripePromise(publishableKey: string): Promise<Stripe | null> {
  let cached = stripePromiseCache.get(publishableKey);
  if (!cached) {
    cached = loadStripe(publishableKey);
    stripePromiseCache.set(publishableKey, cached);
  }
  return cached;
}

type StripeCheckoutDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publishableKey: string;
  clientSecret: string;
};

/** Stripe's own embedded Checkout, mounted in a real popup/modal
 * (2026-09-10) — replaces the original full-page redirect to Stripe's
 * hosted Checkout page, on the user's own direct ask for a "popup"
 * experience instead. Still Stripe-hosted underneath: the iframe this
 * renders is served from Stripe's own origin, so card data never
 * touches this app's server — see backend/payments.py's own docstring
 * for the full design.
 *
 * When the visitor completes payment inside the embedded UI, Stripe
 * itself navigates the top-level page to the `return_url` the backend
 * configured (`/checkout/complete?...`) — this dialog doesn't need to
 * (and can't) know when that happens; it just stays mounted until the
 * browser actually navigates away. */
export function StripeCheckoutDialog({ open, onOpenChange, publishableKey, clientSecret }: StripeCheckoutDialogProps) {
  const stripePromise = React.useMemo(() => getStripePromise(publishableKey), [publishableKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Payment</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] overflow-y-auto">
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
