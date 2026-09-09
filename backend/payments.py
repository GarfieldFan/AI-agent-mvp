"""Payment provider abstraction (2026-08-20) — mirrors backend/providers/'s
"swappable, not hardcoded" pattern already applied to every AI capability
(chat/vision/embedding/image generation), extended to a new capability
domain: actually taking money for an Order. Deliberately a separate
top-level module, not inside backend/providers/ itself — that package is
specifically AI providers, and folding "payment provider" into the same
directory would blur what's meant to be a clean, single-purpose concept.

Two providers exist today:

- `TestPaymentProvider` (the default, `payment_provider` null/"test") —
  no real charge, immediately reports the order paid. Checkout works with
  zero payment configuration out of the box, the same "give the owner
  choices, don't force config before anything works" default every AI
  provider already has (Ollama/ComfyUI without any key set).
- `StripePaymentProvider` — a real Stripe Checkout Session, using
  Stripe's own official SDK (not hand-rolled HTTP calls, unlike this
  project's other vendor integrations) specifically because webhook
  signature verification is security-critical: `stripe.Webhook.
  construct_event` is a vetted HMAC check, not something worth
  reimplementing by hand for a payment-forgery-adjacent code path.

  **Embedded Checkout (2026-09-10, replaced the original full-page
  redirect mode the same day, on the user's own direct ask for a
  "popup" rather than a full navigation away from this site)** —
  `ui_mode="embedded"` instead of the default `"hosted"`: Stripe returns
  a `client_secret`, not a `url`, and the frontend mounts Stripe's own
  `<EmbeddedCheckout>` iframe inside a modal
  (`components/modules/stripe-checkout-dialog.tsx`) rather than
  navigating the whole browser away. Still Stripe-*hosted* underneath —
  the iframe Stripe serves into that modal is still Stripe's own origin,
  so card data never touches this app's own server at all, the exact
  same PCI-scope-avoidance the redirect mode already had. A single
  `return_url` (not separate success/cancel URLs — embedded mode doesn't
  have that distinction) is where Stripe navigates the top-level page
  once the visitor finishes inside the modal, carrying `{CHECKOUT_
  SESSION_ID}` as a literal template Stripe itself substitutes.
  Confirmation of payment always comes back asynchronously via
  `POST /webhooks/stripe`, never synchronously from `create_checkout()`
  itself and never trusted from the `return_url` visit either — Stripe's
  own recommended flow, and the only way to reliably learn a payment
  succeeded even if the visitor closes the tab right after paying,
  before the embedded checkout's own redirect completes. `GET
  /api/checkout/session-status` (apis/payments.py) is a separate,
  best-effort READ of the session's current status Stripe already knows
  about — purely for the return page's own friendly display copy, never
  what actually flips `Order.payment_status`."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

import stripe

if TYPE_CHECKING:
    from models import Order


class PaymentProviderNotConfigured(Exception):
    """Raised when `payment_provider` is set to something that needs
    configuration (e.g. "stripe") but that configuration is missing —
    mirrors providers/base.py's ProviderNotConfigured for AI providers,
    a clean 503 at the API boundary rather than a raw exception."""


class CheckoutResult:
    """What `create_checkout()` returns. Exactly one of the two is
    meaningful: `client_secret` set means "mount Stripe's own embedded
    checkout in a modal with this" (real payment, not yet confirmed —
    see StripePaymentProvider's own docstring for why this is a
    `client_secret`, not a redirect `url`, as of 2026-09-10);
    `already_paid=True` means the provider itself resolved payment
    synchronously (only the test provider does this today) and the
    caller can mark the order paid immediately, no checkout UI needed at
    all."""

    def __init__(self, client_secret: str | None = None, already_paid: bool = False):
        self.client_secret = client_secret
        self.already_paid = already_paid


class PaymentProvider(Protocol):
    async def create_checkout(self, order: "Order", return_url: str) -> CheckoutResult: ...


class TestPaymentProvider:
    """No real charge — immediately reports the order paid. See this
    module's own docstring for why this is the default."""

    async def create_checkout(self, order: "Order", return_url: str) -> CheckoutResult:
        return CheckoutResult(already_paid=True)


class StripePaymentProvider:
    """Creates a real Stripe Checkout Session in embedded (`"popup"`)
    mode — see this module's own docstring for the full "why". Line
    items are built from the order's own real `OrderItem` rows
    (`unit_price_snapshot`/`quantity`), never a client-supplied total —
    the same "never trust the client for money math" posture
    `cart.apply_order_delta` already holds for the order total itself.
    `stripe`'s SDK is synchronous; wrapped in `asyncio.to_thread` so it
    doesn't block this process's event loop, the standard way to call a
    blocking SDK from async FastAPI code."""

    def __init__(self, secret_key: str):
        self.secret_key = secret_key

    async def create_checkout(self, order: "Order", return_url: str) -> CheckoutResult:
        line_items = [
            {
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": item.item_name_snapshot},
                    "unit_amount": int(round(float(item.unit_price_snapshot) * 100)),
                },
                "quantity": item.quantity,
            }
            for item in order.items
        ]
        kwargs: dict = {
            "mode": "payment",
            "ui_mode": "embedded",
            "line_items": line_items,
            "return_url": return_url,
            "client_reference_id": str(order.id),
        }
        if order.contact_email:
            kwargs["customer_email"] = order.contact_email

        try:
            session = await asyncio.to_thread(
                stripe.checkout.Session.create, api_key=self.secret_key, **kwargs
            )
        except stripe.error.StripeError as e:
            raise PaymentProviderNotConfigured(f"Stripe rejected the checkout request: {e}") from e
        return CheckoutResult(client_secret=session.client_secret)


async def retrieve_checkout_session_status(secret_key: str, session_id: str) -> dict:
    """Best-effort READ of a Checkout Session's current status, straight
    from Stripe — powers the return page's own friendly display copy
    ONLY. Never what actually flips `Order.payment_status`; that's
    `POST /webhooks/stripe`'s job alone, for the exact reason this
    module's docstring already gives (a visitor can close the tab before
    ever completing this round trip at all). Raises
    `stripe.error.StripeError` on a bad/unknown session id — the route
    handler decides what HTTP status that becomes, same posture as
    `verify_stripe_webhook`."""
    session = await asyncio.to_thread(
        stripe.checkout.Session.retrieve, session_id, api_key=secret_key
    )
    return {"status": session.status, "payment_status": session.payment_status}


def verify_stripe_webhook(payload: bytes, sig_header: str, webhook_secret: str) -> "stripe.Event":
    """Verifies a POST /webhooks/stripe request actually came from
    Stripe (HMAC signature over the raw body, using stripe.Webhook's own
    vetted implementation) before anything in that request is trusted —
    without this check, anyone who found the webhook URL could POST a
    fake "payment succeeded" event for any order id. Raises
    stripe.error.SignatureVerificationError on a bad/missing signature,
    left uncaught here deliberately — the route handler decides what
    HTTP status that becomes."""
    return stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
