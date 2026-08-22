"""Email + SMS provider abstraction (2026-08-20) — same "swappable, not
hardcoded" pattern as backend/payments.py (and every AI capability before
it), applied to a third capability domain: sending a real message to a
real inbox/phone. Deliberately its own module, not folded into
payments.py — messaging and payment are different concerns that happen
to share a design pattern, not the same concern.

Two independent provider families, each with the same "test is the
default, no configuration needed to keep everything else working" shape:

- `EmailProvider` — `TestEmailProvider` (default) is a pure no-op, never
  actually sends; `MailgunEmailProvider` calls Mailgun's real HTTP API.
- `SMSProvider` — `TestSMSProvider` (default) is a pure no-op;
  `TwilioSMSProvider` calls Twilio's real HTTP API.

Both real providers use plain `httpx` calls (Mailgun's and Twilio's REST
APIs are simple enough that pulling in either vendor's official SDK
would be extra dependency weight for no real benefit — unlike Stripe,
where the official SDK's webhook-signature verification was worth using
specifically for its security properties; there's no equivalent inbound-
webhook-trust concern here, this module only ever sends, never receives
and verifies anything from these vendors).

This module builds the send capability itself — it does NOT decide when
to send anything. No caller wires this into a business trigger yet (an
order-confirmation email, a lead-notification text, ...); that's a
separate, later decision about what to send, to whom, and with what
copy, deliberately out of scope here. `apis/notifications.py`'s test-send
endpoints are the only current callers, for verifying a provider's
credentials actually work."""

from typing import Protocol

import httpx


class NotificationProviderNotConfigured(Exception):
    """Mirrors payments.py's PaymentProviderNotConfigured — raised when a
    real provider is selected but missing the credentials it needs, so
    the API boundary can turn it into a clean 503 instead of a raw
    exception or, worse, a silent no-op that looks like it worked."""


class EmailProvider(Protocol):
    async def send_email(self, to: str, subject: str, body: str) -> None: ...


class TestEmailProvider:
    """No real send — the default, so nothing in this app requires email
    configuration to keep working. Deliberately does nothing at all
    (not even a log line) rather than pretend to deliver anything;
    `apis/notifications.py`'s test-send endpoint reports which provider
    actually handled the call, so "test" mode is never mistaken for a
    real delivery."""

    async def send_email(self, to: str, subject: str, body: str) -> None:
        return None


class MailgunEmailProvider:
    """Sends via Mailgun's real HTTP API
    (https://documentation.mailgun.com/en/latest/api-sending.html) —
    HTTP Basic auth with the literal username `"api"` and the account's
    API key as the password, exactly as Mailgun's own docs specify."""

    def __init__(self, api_key: str, domain: str, from_address: str):
        self.api_key = api_key
        self.domain = domain
        self.from_address = from_address

    async def send_email(self, to: str, subject: str, body: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"https://api.mailgun.net/v3/{self.domain}/messages",
                auth=("api", self.api_key),
                data={"from": self.from_address, "to": to, "subject": subject, "text": body},
            )
        if resp.status_code >= 400:
            raise NotificationProviderNotConfigured(f"Mailgun rejected the send request: {resp.text[:300]}")


class SMSProvider(Protocol):
    async def send_sms(self, to: str, body: str) -> None: ...


class TestSMSProvider:
    """No real send — same posture as TestEmailProvider above."""

    async def send_sms(self, to: str, body: str) -> None:
        return None


class TwilioSMSProvider:
    """Sends via Twilio's real HTTP API
    (https://www.twilio.com/docs/sms/api) — HTTP Basic auth with the
    Account SID as username and the Auth Token as password."""

    def __init__(self, account_sid: str, auth_token: str, from_number: str):
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number

    async def send_sms(self, to: str, body: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json",
                auth=(self.account_sid, self.auth_token),
                data={"From": self.from_number, "To": to, "Body": body},
            )
        if resp.status_code >= 400:
            raise NotificationProviderNotConfigured(f"Twilio rejected the send request: {resp.text[:300]}")
