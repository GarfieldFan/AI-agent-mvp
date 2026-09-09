"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { getCheckoutSessionStatus } from "@/lib/payments";

/** `/checkout/complete` (2026-09-10) — where Stripe's own embedded
 * Checkout navigates the top-level page once a visitor finishes paying
 * inside the popup (see backend/apis/products.py's `checkout_cart`,
 * which builds this as the Checkout Session's `return_url`). Reads
 * `session_id` off the URL (Stripe substitutes its own
 * `{CHECKOUT_SESSION_ID}` template there) purely to show accurate
 * status copy — this page is a friendly landing message ONLY, never
 * proof of payment. The real source of truth is `POST /webhooks/stripe`
 * updating the order server-side, which may not have landed yet by the
 * time this page renders (same honest framing the original hosted-
 * redirect flow's own return page already used). */
export function CheckoutCompletePage() {
  // Lazy initializer (runs once, on first render) rather than reading
  // this in an effect — a real user-driven value that's stable for the
  // page's whole lifetime, same pattern SessionIdBootstrap/the old
  // returnedFromStripe check already established in this app.
  const [sessionId] = React.useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("session_id");
  });
  const [status, setStatus] = React.useState<"checking" | "paid" | "pending" | "unknown">(
    sessionId ? "checking" : "unknown",
  );

  React.useEffect(() => {
    if (!sessionId) return;
    getCheckoutSessionStatus(sessionId)
      .then((result) => setStatus(result.payment_status === "paid" ? "paid" : "pending"))
      .catch(() => setStatus("unknown"));
  }, [sessionId]);

  if (status === "checking") {
    return (
      <Container className="max-w-lg py-10">
        <LoadingSpinner label="Checking your payment…" />
      </Container>
    );
  }

  const description =
    status === "paid"
      ? "Your payment was successful. We're finalizing your order now — you'll hear from us shortly."
      : "Thanks — your payment is being confirmed and your order will show up in our system shortly.";

  return (
    <Container className="max-w-lg py-10">
      <EmptyState
        icon={CheckCircle2}
        title={status === "paid" ? "Payment received" : "Thanks for your order"}
        description={description}
        action={
          <Button render={<Link href="/" />} nativeButton={false} variant="outline">
            Back to home
          </Button>
        }
      />
    </Container>
  );
}
