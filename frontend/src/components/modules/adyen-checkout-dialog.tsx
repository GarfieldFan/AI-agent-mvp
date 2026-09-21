"use client";

import * as React from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";

type AdyenCheckoutDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientKey: string;
  environment: "test" | "live";
  sessionId: string;
  sessionData: string;
  /** Threaded through so the completion redirect can carry `order_id`
   * the same way Stripe's own backend-built `return_url` already does —
   * `/checkout/complete` reads it to offer a receipt download link. */
  orderId: number;
};

/** Adyen's own Drop-in, mounted in the same popup/modal shape as
 * StripeCheckoutDialog (2026-09-21) — the aggregator gateway's own
 * embedded checkout UI, for the same "never leave this page" reasoning.
 * Unlike Stripe's `@stripe/react-stripe-js` (a real React wrapper),
 * `@adyen/adyen-web` ships a plain, imperative JS API (`AdyenCheckout()`
 * is an async factory, `Dropin` is mounted onto a DOM node directly) —
 * this component is a thin React wrapper around that, same "imperative
 * widget library inside a useEffect" shape as any non-React SDK.
 *
 * When the visitor completes payment inside the Drop-in, Adyen calls
 * this dialog's own `onPaymentCompleted`, which navigates the top-level
 * page to the same `return_url` the backend configured (`/checkout/
 * complete?...`) — mirrors Stripe's own dialog not needing to poll for
 * completion, just reacting to the SDK's own callback instead.
 *
 * `countryCode` is hardcoded to `"US"` — this app has no per-visitor
 * country field anywhere yet (the same "usd hardcoded, no currency
 * column" limitation `payments.py`'s own AdyenPaymentProvider already
 * carries) — a real gap if a non-US market ever needs this, not
 * something this round's scope covers. */
export function AdyenCheckoutDialog({
  open,
  onOpenChange,
  clientKey,
  environment,
  sessionId,
  sessionData,
  orderId,
}: AdyenCheckoutDialogProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let dropinInstance: { unmount?: () => void } | null = null;

    async function mount() {
      try {
        const { AdyenCheckout, Dropin } = await import("@adyen/adyen-web");
        await import("@adyen/adyen-web/styles/adyen.css");
        if (cancelled || !containerRef.current) return;

        const checkout = await AdyenCheckout({
          environment,
          clientKey,
          countryCode: "US",
          session: { id: sessionId, sessionData },
          onPaymentCompleted: () => {
            // Adyen itself doesn't auto-navigate the way Stripe's
            // embedded Checkout does — this dialog drives the visitor
            // to the same shape of URL the backend's own Stripe
            // return_url already uses (order_id + session_id), so
            // /checkout/complete handles the rest identically
            // regardless of which provider was used.
            window.location.href = `/checkout/complete?order_id=${orderId}&session_id=${encodeURIComponent(sessionId)}`;
          },
          onError: (err: unknown) => {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : "Adyen checkout failed to load.");
              setStatus("error");
            }
          },
        });
        if (cancelled || !containerRef.current) return;

        dropinInstance = new Dropin(checkout, {}).mount(containerRef.current);
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Adyen checkout failed to load.");
          setStatus("error");
        }
      }
    }

    void mount();
    return () => {
      cancelled = true;
      dropinInstance?.unmount?.();
    };
  }, [open, clientKey, environment, sessionId, sessionData, orderId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Payment</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] overflow-y-auto">
          {status === "loading" ? <LoadingSpinner label="Loading payment form…" /> : null}
          {status === "error" && error ? <ErrorMessage description={error} /> : null}
          <div ref={containerRef} hidden={status !== "ready"} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
