"""Owner-facing payment gate configuration + the Stripe webhook receiver.

Mirrors `apis/model_settings.py`'s pattern (one settings row, a picker,
write-only secrets) applied to `backend/payments.py`'s provider
abstraction — see that module's own docstring for the full "why."
Deliberately simpler than the AI-provider settings: there's no "model"
dimension here, no live capability querying, just a provider name plus
whatever credentials that provider needs — the same shape
`image_provider` already has (a plain 3-way choice, not provider+model).

Two routers: `admin_router` (the owner-facing settings picker, gated like
every other `/agent/*` route) and `public_router` (the Stripe webhook —
deliberately outside `/agent` and with no RBAC at all, since Stripe's own
servers call it, not a logged-in admin; trust comes from the HMAC
signature check instead, see `verify_stripe_webhook`)."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import stripe
from apis.deps import Role, require_role
from apis.notifications import notify_owner
from db import get_db
from models import AppSettings, Order
from payments import (
    PaymentProvider,
    PaymentProviderNotConfigured,
    StripePaymentProvider,
    TestPaymentProvider,
    retrieve_checkout_session_status,
    verify_stripe_webhook,
)

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()


def resolve_payment_provider(db: Session) -> tuple[str, PaymentProvider]:
    """Returns `(provider_name, provider_instance)` — the name is
    returned alongside the instance since callers (apis/products.py's
    checkout_cart) need to stamp `Order.payment_provider` with it, not
    just use the instance to create a checkout."""
    row = db.get(AppSettings, 1)
    name = (row.payment_provider if row else None) or "test"
    if name == "stripe":
        if not row or not row.stripe_secret_key:
            raise PaymentProviderNotConfigured(
                "Stripe is selected as the payment provider but no secret key is configured yet — "
                "set one in the dashboard's Payment settings."
            )
        return name, StripePaymentProvider(row.stripe_secret_key)
    return "test", TestPaymentProvider()


class PaymentSettings(BaseModel):
    payment_provider: str
    stripe_publishable_key: str | None
    # stripe_secret_key / stripe_webhook_secret deliberately omitted —
    # write-only, never echoed back once saved, same rule
    # apis/model_settings.py's custom_api_key already follows.
    stripe_secret_key_set: bool
    stripe_webhook_secret_set: bool


@admin_router.get("/payment-settings", response_model=PaymentSettings)
def get_payment_settings(db: Session = Depends(get_db)) -> PaymentSettings:
    row = db.get(AppSettings, 1)
    return PaymentSettings(
        payment_provider=(row.payment_provider if row else None) or "test",
        stripe_publishable_key=row.stripe_publishable_key if row else None,
        stripe_secret_key_set=bool(row and row.stripe_secret_key),
        stripe_webhook_secret_set=bool(row and row.stripe_webhook_secret),
    )


class UpdatePaymentSettingsRequest(BaseModel):
    payment_provider: str
    stripe_publishable_key: str | None = None
    # None = leave whatever's already saved alone (matches
    # model_settings.py's custom_api_key semantics) — this is how the
    # dashboard form can be re-saved (e.g. just switching provider) without
    # forcing the owner to re-paste a secret they already entered once.
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None


@admin_router.put("/payment-settings", response_model=PaymentSettings)
def update_payment_settings(req: UpdatePaymentSettingsRequest, db: Session = Depends(get_db)) -> PaymentSettings:
    if req.payment_provider not in ("test", "stripe"):
        raise HTTPException(status_code=400, detail=f"{req.payment_provider!r} isn't a supported payment provider.")
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.payment_provider = req.payment_provider
    row.stripe_publishable_key = req.stripe_publishable_key
    if req.stripe_secret_key is not None:
        row.stripe_secret_key = req.stripe_secret_key or None
    if req.stripe_webhook_secret is not None:
        row.stripe_webhook_secret = req.stripe_webhook_secret or None
    db.commit()
    db.refresh(row)
    return PaymentSettings(
        payment_provider=row.payment_provider or "test",
        stripe_publishable_key=row.stripe_publishable_key,
        stripe_secret_key_set=bool(row.stripe_secret_key),
        stripe_webhook_secret_set=bool(row.stripe_webhook_secret),
    )


@public_router.post("/webhooks/stripe", status_code=204)
async def stripe_webhook(request: Request, db: Session = Depends(get_db)) -> None:
    """Stripe's own servers call this after a Checkout Session's payment
    resolves — never a logged-in admin, never the visitor's browser. Only
    ever trusts an event whose signature verifies against the configured
    `stripe_webhook_secret`; anything else is rejected outright rather
    than silently ignored, so a misconfigured/missing secret is loud, not
    a payment-status feature that quietly never fires.

    `client_reference_id` (set to `str(order.id)` when the Checkout
    Session was created, see payments.py's StripePaymentProvider) is how
    this matches the event back to a real Order — never anything else in
    the request, since none of it besides the verified event body is
    trustworthy input."""
    row = db.get(AppSettings, 1)
    if not row or not row.stripe_webhook_secret:
        raise HTTPException(status_code=503, detail="Stripe webhook secret is not configured.")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    try:
        event = verify_stripe_webhook(payload, sig_header, row.stripe_webhook_secret)
    except (stripe.error.SignatureVerificationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid Stripe webhook signature: {e}")

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        # `session` is a real stripe.checkout.Session (a StripeObject), not
        # a plain dict — `.get(...)` is a genuine AttributeError on this
        # SDK version ("'get' is a dict method, but a Session is not a
        # dict"), only ever caught here 2026-09-10 because earlier
        # verification only ever exercised the signature-REJECTION path
        # (a bad/missing signature never reaches this code at all), never
        # a real, validly-signed event all the way through. Plain
        # attribute access (`session.client_reference_id`) is what
        # StripeObject actually supports.
        order_id = getattr(session, "client_reference_id", None)
        if order_id:
            order = db.get(Order, int(order_id))
            if order is not None:
                order.payment_status = "paid"
                order.payment_reference = getattr(session, "id", None)
                order.is_open = False
                db.commit()
                db.refresh(order)
                await notify_owner(
                    db,
                    f"[AI MVP] New order #{order.id} — ${float(order.total_amount):.2f}",
                    f"Order #{order.id} was placed and paid (stripe).\n\n"
                    + "\n".join(f"{i.quantity}x {i.item_name_snapshot}" for i in order.items)
                    + f"\n\nTotal: ${float(order.total_amount):.2f}"
                    + (f"\nContact: {order.contact_email}" if order.contact_email else "")
                    + (f"\nPickup/delivery: {order.pickup_time}" if order.pickup_time else "")
                    + (f"\nShip to: {order.shipping_address}" if order.shipping_address else ""),
                )
    elif event["type"] in ("checkout.session.async_payment_failed", "checkout.session.expired"):
        session = event["data"]["object"]
        order_id = getattr(session, "client_reference_id", None)
        if order_id:
            order = db.get(Order, int(order_id))
            if order is not None and order.payment_status == "unpaid":
                order.payment_status = "failed"
                db.commit()
                await notify_owner(
                    db,
                    f"[AI MVP] Payment failed — order #{order.id}",
                    f"Order #{order.id} (${float(order.total_amount):.2f}) failed to pay via Stripe "
                    f"({event['type']}). The order is still open in case the visitor wants to retry.",
                )
    # Every other event type is silently ignored — this endpoint only
    # cares about a Checkout Session's own payment outcome.


class PaymentConfigResponse(BaseModel):
    provider: str
    # Safe to expose — Stripe's own publishable key is DESIGNED to be
    # embedded in browser-side JS (same posture as its own docs, and the
    # same "write-only secret, safe-to-echo public key" split this app
    # already applies to Google Maps' embed key / Turnstile's site key).
    # `/checkout`'s embedded-checkout modal needs this to call Stripe.js's
    # own `loadStripe(publishableKey)` — the admin-gated GET
    # /agent/payment-settings above was never reachable from a public,
    # unauthenticated checkout page.
    publishable_key: str | None


@public_router.get("/payment-config", response_model=PaymentConfigResponse)
def get_payment_config(db: Session = Depends(get_db)) -> PaymentConfigResponse:
    row = db.get(AppSettings, 1)
    provider = (row.payment_provider if row else None) or "test"
    return PaymentConfigResponse(
        provider=provider,
        publishable_key=row.stripe_publishable_key if row and provider == "stripe" else None,
    )


class CheckoutSessionStatusResponse(BaseModel):
    status: str
    payment_status: str


@public_router.get("/checkout/session-status", response_model=CheckoutSessionStatusResponse)
async def get_checkout_session_status(session_id: str, db: Session = Depends(get_db)) -> CheckoutSessionStatusResponse:
    """Public, no-auth — a best-effort READ of Stripe's own record of a
    session's status, for `/checkout`'s return-page display copy ONLY
    (see payments.py's `retrieve_checkout_session_status` docstring for
    why this is never what actually marks an Order paid). `session_id`
    comes back from Stripe's own `return_url` redirect
    (`{CHECKOUT_SESSION_ID}`), not anything this app generated itself —
    Stripe's own API is what actually validates it's a real session, a
    bad/unknown id correctly 502s rather than ever being trusted."""
    row = db.get(AppSettings, 1)
    if not row or row.payment_provider != "stripe" or not row.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe isn't the configured payment provider.")
    try:
        result = await retrieve_checkout_session_status(row.stripe_secret_key, session_id)
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=502, detail=f"Stripe rejected the session lookup: {e}")
    return CheckoutSessionStatusResponse(**result)
