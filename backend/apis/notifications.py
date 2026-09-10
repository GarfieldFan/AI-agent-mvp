"""Owner-facing email/SMS provider configuration + test-send endpoints.

Mirrors `apis/payments.py`'s pattern exactly, applied to
`backend/notifications.py`'s two provider families — see that module's
own docstring for the full "why." One settings row, two independent
provider pickers (email/SMS), write-only secrets, a test-send action
per capability so an owner can verify real credentials actually work
without needing to wire this into any business trigger first."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import AppSettings
from notifications import (
    EmailProvider,
    MailgunEmailProvider,
    NotificationProviderNotConfigured,
    SMSProvider,
    TestEmailProvider,
    TestSMSProvider,
    TwilioSMSProvider,
)

logger = logging.getLogger("backend.notifications")

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


async def notify_owner(db: Session, subject: str, body: str) -> None:
    """Best-effort business-event notification (2026-09-10) — reuses the
    exact same `AppSettings.alert_email` + `resolve_email_provider`
    pattern `error_alerts.py`'s crash-alert path already established
    (2026-09-09), extended here from "the backend crashed" to real
    order/payment events (a new paid order, a failed payment, a
    region-blocked checkout — see the callers in apis/products.py and
    apis/payments.py). No new settings field, no new provider, no new
    component — an owner who already set `alert_email` for crash alerts
    gets order notifications there too; one who hasn't configured email
    at all gets a clean no-op via `TestEmailProvider`.

    Unlike error_alerts.py's crash alerts, deliberately no cooldown here
    — each of these is a genuinely distinct business event worth its own
    notification, not a repeating failure to throttle. Never raises —
    every failure mode (not configured, bad credentials, a real send
    rejection) is caught and logged, exactly mirroring
    error_alerts.py's own `_maybe_send_alert`, since a notification
    failure must never be why an order/checkout call itself fails."""
    row = db.get(AppSettings, 1)
    alert_email = row.alert_email if row else None
    if not alert_email or not is_email_configured(db):
        return
    try:
        _name, provider = resolve_email_provider(db)
        await provider.send_email(alert_email, subject, body)
    except NotificationProviderNotConfigured as e:
        logger.error("Order-event notification email was not sent: %s", e)
    except Exception:
        logger.exception("Failed to send an order-event notification email")


def resolve_email_provider(db: Session) -> tuple[str, EmailProvider]:
    row = db.get(AppSettings, 1)
    name = (row.email_provider if row else None) or "test"
    if name == "mailgun":
        if not row or not row.mailgun_api_key or not row.mailgun_domain or not row.mailgun_from_address:
            raise NotificationProviderNotConfigured(
                "Mailgun is selected as the email provider but its API key/domain/from-address "
                "aren't all configured yet — set them in the dashboard's Notification settings."
            )
        return name, MailgunEmailProvider(row.mailgun_api_key, row.mailgun_domain, row.mailgun_from_address)
    return "test", TestEmailProvider()


def is_email_configured(db: Session) -> bool:
    """True only when a REAL email provider (not "test") is selected AND
    has every credential it needs — the gate `apis/crm_resume.py`'s
    OTP-based cross-session recovery checks before doing anything at
    all, since there's no way to deliver a code without real email.
    Deliberately a cheap DB-only check, not a live connectivity probe on
    every call — the owner's own "Send test email" button (this
    module's `send_test_email`) is the real verification step; this
    just checks the same config that button already exists to
    validate, so a provider that's configured but has bad/expired
    credentials still reports `True` here (it "should" work) even if a
    real send would fail — matching test-email's own job of catching
    that case ahead of time, not this gate's."""
    row = db.get(AppSettings, 1)
    if row is None or (row.email_provider or "test") == "test":
        return False
    return bool(row.mailgun_domain and row.mailgun_from_address and row.mailgun_api_key)


def resolve_sms_provider(db: Session) -> tuple[str, SMSProvider]:
    row = db.get(AppSettings, 1)
    name = (row.sms_provider if row else None) or "test"
    if name == "twilio":
        if not row or not row.twilio_account_sid or not row.twilio_auth_token or not row.twilio_from_number:
            raise NotificationProviderNotConfigured(
                "Twilio is selected as the SMS provider but its Account SID/Auth Token/from-number "
                "aren't all configured yet — set them in the dashboard's Notification settings."
            )
        return name, TwilioSMSProvider(row.twilio_account_sid, row.twilio_auth_token, row.twilio_from_number)
    return "test", TestSMSProvider()


class NotificationSettings(BaseModel):
    email_provider: str
    mailgun_domain: str | None
    mailgun_from_address: str | None
    mailgun_api_key_set: bool
    sms_provider: str
    twilio_account_sid: str | None
    twilio_from_number: str | None
    twilio_auth_token_set: bool
    # Where error_alerts.py sends an automatic alert on a genuinely
    # unhandled backend error — not a secret, safe to echo back. Reuses
    # whichever provider is configured above (no separate credential set).
    alert_email: str | None


@router.get("/notification-settings", response_model=NotificationSettings)
def get_notification_settings(db: Session = Depends(get_db)) -> NotificationSettings:
    row = db.get(AppSettings, 1)
    return NotificationSettings(
        email_provider=(row.email_provider if row else None) or "test",
        mailgun_domain=row.mailgun_domain if row else None,
        mailgun_from_address=row.mailgun_from_address if row else None,
        mailgun_api_key_set=bool(row and row.mailgun_api_key),
        sms_provider=(row.sms_provider if row else None) or "test",
        twilio_account_sid=row.twilio_account_sid if row else None,
        twilio_from_number=row.twilio_from_number if row else None,
        twilio_auth_token_set=bool(row and row.twilio_auth_token),
        alert_email=row.alert_email if row else None,
    )


class UpdateNotificationSettingsRequest(BaseModel):
    email_provider: str
    mailgun_domain: str | None = None
    mailgun_from_address: str | None = None
    # None = leave the previously-saved secret alone (matches
    # apis/payments.py's stripe_secret_key semantics) — only send this
    # when the owner actually typed a new one.
    mailgun_api_key: str | None = None
    sms_provider: str
    twilio_account_sid: str | None = None
    twilio_from_number: str | None = None
    twilio_auth_token: str | None = None
    alert_email: str | None = None


@router.put("/notification-settings", response_model=NotificationSettings)
def update_notification_settings(
    req: UpdateNotificationSettingsRequest, db: Session = Depends(get_db)
) -> NotificationSettings:
    if req.email_provider not in ("test", "mailgun"):
        raise HTTPException(status_code=400, detail=f"{req.email_provider!r} isn't a supported email provider.")
    if req.sms_provider not in ("test", "twilio"):
        raise HTTPException(status_code=400, detail=f"{req.sms_provider!r} isn't a supported SMS provider.")

    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.email_provider = req.email_provider
    row.mailgun_domain = req.mailgun_domain
    row.mailgun_from_address = req.mailgun_from_address
    if req.mailgun_api_key is not None:
        row.mailgun_api_key = req.mailgun_api_key or None

    row.sms_provider = req.sms_provider
    row.twilio_account_sid = req.twilio_account_sid
    row.twilio_from_number = req.twilio_from_number
    if req.twilio_auth_token is not None:
        row.twilio_auth_token = req.twilio_auth_token or None

    row.alert_email = (req.alert_email or "").strip() or None

    db.commit()
    db.refresh(row)
    return NotificationSettings(
        email_provider=row.email_provider or "test",
        mailgun_domain=row.mailgun_domain,
        mailgun_from_address=row.mailgun_from_address,
        mailgun_api_key_set=bool(row.mailgun_api_key),
        sms_provider=row.sms_provider or "test",
        twilio_account_sid=row.twilio_account_sid,
        twilio_from_number=row.twilio_from_number,
        twilio_auth_token_set=bool(row.twilio_auth_token),
        alert_email=row.alert_email,
    )


class TestEmailRequest(BaseModel):
    to: str


class TestSendResponse(BaseModel):
    provider: str


@router.post("/notification-settings/test-email", response_model=TestSendResponse)
async def send_test_email(req: TestEmailRequest, db: Session = Depends(get_db)) -> TestSendResponse:
    """Sends (or, under the default "test" provider, pretends to send) a
    fixed test message — proves a real provider's credentials actually
    work without needing any business trigger wired up yet. Reports
    which provider actually handled the call, so a "test" response is
    never mistaken for a real delivery."""
    try:
        name, provider = resolve_email_provider(db)
        await provider.send_email(
            req.to, "Test email from your AI Employee dashboard", "This is a test message — if you received this, your email provider is configured correctly."
        )
    except NotificationProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    return TestSendResponse(provider=name)


class TestSmsRequest(BaseModel):
    to: str


@router.post("/notification-settings/test-sms", response_model=TestSendResponse)
async def send_test_sms(req: TestSmsRequest, db: Session = Depends(get_db)) -> TestSendResponse:
    try:
        name, provider = resolve_sms_provider(db)
        await provider.send_sms(req.to, "Test SMS from your AI Employee dashboard.")
    except NotificationProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    return TestSendResponse(provider=name)
