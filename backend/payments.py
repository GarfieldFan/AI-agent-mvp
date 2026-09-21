"""Payment provider abstraction (2026-08-20) — mirrors backend/providers/'s
"swappable, not hardcoded" pattern already applied to every AI capability
(chat/vision/embedding/image generation), extended to a new capability
domain: actually taking money for an Order. Deliberately a separate
top-level module, not inside backend/providers/ itself — that package is
specifically AI providers, and folding "payment provider" into the same
directory would blur what's meant to be a clean, single-purpose concept.

Three providers exist today:

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
  what actually flips `Order.payment_status`.

**Wallet payment methods — Apple Pay / Google Pay / WeChat Pay / Alipay /
Stripe's own PayPal (2026-09-20)**. None of these are separate providers
in this module — they're payment METHODS within the one `stripe`
provider above, and `StripePaymentProvider.create_checkout` already
passes no `payment_method_types` at all, which per Stripe's own docs
means "Dynamic Payment Methods": Stripe auto-selects whichever methods
are eligible (enabled in the merchant's own Dashboard, plus currency/
country/session-mode eligibility) with zero code on our side — this was
already true before this change, not something added by it. WeChat Pay
specifically is enable-in-Dashboard-only too (no extra API call needed),
confirmed against Stripe's own docs: business-location-eligible (the US
is on that list) and currency-eligible (`usd`, which `create_checkout`
already hardcodes, is supported).

The one piece that genuinely needs a one-time API call on our side:
Apple Pay and Google Pay both require the domain showing the Checkout
UI to be registered with Stripe (`POST /v1/payment_method_domains`) —
but ONLY for `ui_mode="embedded"` (this app's mode since 2026-09-10).
Stripe's hosted/redirect Checkout needs no such registration (that page
is served from Stripe's own, already-registered domain); ours embeds an
iframe inside our OWN page, so our domain is the one that has to prove
it's really serving that iframe. `register_payment_method_domain`/
`get_payment_method_domain_status` below are that one call — see
apis/payments.py's `POST .../register-wallet-domain` for where an owner
actually triggers it. Standard "standard PayPal" (Stripe-processed,
no self-hosted adapter) is registered on the SAME domain-registration
object (its response includes a `paypal` status field alongside
`apple_pay`/`google_pay`/`link`) but is business-location-gated to a
specific list of European countries — a genuinely different, larger
integration (a self-hosted "PayPal adapter" Stripe provides) is needed
for a non-EU merchant account, out of scope here; see the root
AGENTS.md's "Payment gate" section (the wallet-payment-methods entry)
for the full reasoning and Stripe-doc citations behind this whole
section.

**`AdyenPaymentProvider` (2026-09-21)** — the "aggregator" gateway,
added specifically for China UnionPay coverage Stripe doesn't give an
account (confirmed against both vendors' own docs before building, not
assumed): Adyen supports UnionPay for a merchant account based in 40+
countries — notably NOT mainland China itself, the same "account
location gates the method" shape Stripe's own PayPal/WeChat Pay support
already has — on top of the standard card networks/wallets every
gateway covers, and Alipay/WeChat Pay too (a second path to those two,
not needed if Stripe's own Dashboard toggle already covers an account's
market). This is a second, independent `PaymentProvider` implementation,
not a replacement for Stripe — an owner picks it specifically when their
market needs a payment method Stripe doesn't cover for their account.
See `AdyenPaymentProvider`'s own docstring below for the full design;
see the root AGENTS.md's "Adyen — the aggregator payment gateway"
section for the research trail (official docs citations, SDK source
verification) behind the exact API/SDK shapes used."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

import Adyen
import stripe

if TYPE_CHECKING:
    from models import Order


class PaymentProviderNotConfigured(Exception):
    """Raised when `payment_provider` is set to something that needs
    configuration (e.g. "stripe") but that configuration is missing —
    mirrors providers/base.py's ProviderNotConfigured for AI providers,
    a clean 503 at the API boundary rather than a raw exception."""


class CheckoutResult:
    """What `create_checkout()` returns. Exactly one of `client_secret`
    (Stripe), `adyen_session_id`+`adyen_session_data` (Adyen), or
    `already_paid=True` (the test provider, resolved synchronously) is
    meaningful — never more than one provider's fields at once.
    `client_secret` means "mount Stripe's own embedded checkout in a
    modal with this" (see StripePaymentProvider's own docstring for why
    this is a `client_secret`, not a redirect `url`). The Adyen pair
    means "mount Adyen's own Drop-in/Web Component with this session" —
    see AdyenPaymentProvider's own docstring below. `already_paid=True`
    means the caller can mark the order paid immediately, no checkout UI
    needed at all."""

    def __init__(
        self,
        client_secret: str | None = None,
        already_paid: bool = False,
        adyen_session_id: str | None = None,
        adyen_session_data: str | None = None,
    ):
        self.client_secret = client_secret
        self.already_paid = already_paid
        self.adyen_session_id = adyen_session_id
        self.adyen_session_data = adyen_session_data


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


class AdyenPaymentProvider:
    """Creates a real Adyen Checkout Session — the aggregator gateway
    added 2026-09-21 alongside Stripe specifically for local/regional
    payment methods Stripe doesn't cover for a given merchant account.
    Confirmed via Adyen's own docs before building: Adyen supports China
    UnionPay in 40+ countries (though not for a merchant account based in
    mainland China itself — the same "account location gates the method"
    shape Stripe's own PayPal/WeChat Pay support already has), on top of
    the standard card networks and wallets every gateway already covers.
    One more `PaymentProvider` implementation, same "swappable, not
    hardcoded" pattern as everything else in this file — not a
    replacement for Stripe, a second option an owner picks when their
    market needs UnionPay coverage Stripe doesn't give them.

    Uses Adyen's official Python SDK for the same reason `stripe` (the
    vendor SDK, not hand-rolled HTTP) was chosen for Stripe: webhook
    signature verification is security-critical, and `Adyen.util`'s HMAC
    check is a vetted implementation, not worth reimplementing by hand.

    Line items are built from the order's own real `OrderItem` rows,
    never a client-supplied total — same "never trust the client for
    money math" posture `StripePaymentProvider` already holds. Amounts
    are in MINOR units (cents), matching Stripe's own `unit_amount`
    convention already used above. `Adyen`'s SDK is synchronous, wrapped
    in `asyncio.to_thread` for the same reason as Stripe's calls."""

    def __init__(self, api_key: str, merchant_account: str, environment: str = "test"):
        self.api_key = api_key
        self.merchant_account = merchant_account
        self.environment = environment

    def _client(self) -> "Adyen.Adyen":
        client = Adyen.Adyen()
        client.client.xapikey = self.api_key
        client.client.platform = self.environment
        client.client.application_name = "ai-employee"
        return client

    async def create_checkout(self, order: "Order", return_url: str) -> CheckoutResult:
        amount_value = int(round(float(order.total_amount) * 100))
        request = {
            "merchantAccount": self.merchant_account,
            "amount": {"currency": "USD", "value": amount_value},
            "reference": str(order.id),
            "returnUrl": return_url,
            # "Web" is the standard channel value for a browser-based
            # Drop-in/Components integration — lets Adyen tailor which
            # payment methods are actually eligible for this session.
            "channel": "Web",
        }
        if order.contact_email:
            request["shopperEmail"] = order.contact_email

        client = self._client()
        try:
            result = await asyncio.to_thread(client.checkout.payments_api.sessions, request)
        except Adyen.AdyenError as e:
            # AdyenError is the SDK's own top-level base — covers
            # AdyenAPIAuthenticationError (bad/fake API key, the case
            # this app can actually exercise without a real Adyen
            # account), AdyenAPIValidationError, AdyenAPIInvalidPermission,
            # AdyenInvalidRequestError, etc. — the same broad "the vendor
            # rejected this request for any reason" catch
            # stripe.error.StripeError gets elsewhere in this file.
            raise PaymentProviderNotConfigured(f"Adyen rejected the checkout request: {e}") from e
        session = result.message
        return CheckoutResult(adyen_session_id=session.get("id"), adyen_session_data=session.get("sessionData"))


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


def _payment_method_domain_to_dict(domain_obj) -> dict:
    """Hand-extracts the handful of fields the frontend actually needs
    into a plain dict — deliberately not `domain_obj.to_dict()` (the
    whole StripeObject), matching this module's existing
    `retrieve_checkout_session_status` precedent of only ever trusting/
    forwarding specific named fields, never a vendor object wholesale."""
    def _status(method) -> str | None:
        return getattr(method, "status", None) if method is not None else None

    return {
        "domain_name": getattr(domain_obj, "domain_name", None),
        "enabled": getattr(domain_obj, "enabled", None),
        "apple_pay": _status(getattr(domain_obj, "apple_pay", None)),
        "google_pay": _status(getattr(domain_obj, "google_pay", None)),
        "link": _status(getattr(domain_obj, "link", None)),
        "paypal": _status(getattr(domain_obj, "paypal", None)),
    }


async def get_payment_method_domain_status(secret_key: str, domain: str) -> dict | None:
    """Best-effort READ of whether `domain` is already registered with
    Stripe's payment-method-domains API — no side effect. Returns
    `{domain_name, enabled, apple_pay, google_pay, link, paypal}` (the
    last four each a status string like `"active"`, or `None` for a
    method Stripe hasn't reported anything on yet) or `None` if this
    domain has never been registered on this account. Never raises on a
    normal "not found" — only a genuine API/auth failure propagates,
    since this is meant to be called opportunistically from a settings
    GET (see apis/payments.py)."""
    result = await asyncio.to_thread(
        stripe.PaymentMethodDomain.list, api_key=secret_key, domain_name=domain
    )
    return _payment_method_domain_to_dict(result.data[0]) if result.data else None


async def register_payment_method_domain(secret_key: str, domain: str) -> dict:
    """Registers `domain` with Stripe so wallet-style payment methods
    (Apple Pay, Google Pay, Link, and Stripe's own standard PayPal) can
    actually render inside embedded Checkout — required specifically for
    `ui_mode="embedded"` (hosted/redirect Checkout needs none of this,
    since that page is served from Stripe's own already-registered
    domain; ours embeds an iframe inside OUR page instead). Idempotent:
    checks for an already-registered entry first (Stripe's own docs say
    not to register the same domain twice) and returns that instead of
    re-creating. Raises stripe.error.StripeError on a real rejection —
    most commonly a domain Stripe can't actually reach/verify yet (e.g.
    a local dev address, or a production domain whose DNS isn't live
    yet) — the caller decides what HTTP status that becomes."""
    result = await asyncio.to_thread(
        stripe.PaymentMethodDomain.list, api_key=secret_key, domain_name=domain
    )
    if result.data:
        return _payment_method_domain_to_dict(result.data[0])
    created = await asyncio.to_thread(
        stripe.PaymentMethodDomain.create, api_key=secret_key, domain_name=domain
    )
    return _payment_method_domain_to_dict(created)


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


def verify_adyen_webhook_item(notification_item: dict, hmac_key: str) -> bool:
    """Verifies one `NotificationRequestItem` from a POST /webhooks/adyen
    request actually came from Adyen — HMAC-SHA256 over the item's own
    fields, checked against its own embedded `additionalData.
    hmacSignature` (Adyen signs each item individually, unlike Stripe's
    one signature over the whole request body) via `Adyen.util`'s own
    vetted implementation, the same "don't hand-roll a payment-forgery-
    adjacent HMAC check" reasoning as `verify_stripe_webhook`. Returns a
    plain bool (this SDK function doesn't raise on a bad signature,
    unlike Stripe's) — the route handler decides what to do with
    `False`. Raises `ValueError` if the item has no `hmacSignature` in
    `additionalData` at all (a malformed/incomplete notification, not a
    forged-but-well-formed one)."""
    return Adyen.util.is_valid_hmac_notification(notification_item, hmac_key)
