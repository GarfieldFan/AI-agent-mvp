"""Basic error logging + automatic email alerting on severe (genuinely
unhandled) backend errors (2026-09-09) — on the user's own direct ask:
this project had neither before this.

Deliberately scoped to UNHANDLED exceptions only — a real bug, a crash,
a dependency (DB, an AI provider) failing in a way this app didn't
already account for. Every deliberate `raise HTTPException(...)` already
in this codebase (including ProviderNotConfigured's 503 when no AI
provider is configured yet) is handled by Starlette's own dedicated
exception handler and never reaches `unhandled_exception_handler` below
— an owner who simply hasn't finished setup yet isn't "an error," and
emailing them about it would spam a fresh install's inbox nonstop. The
right response to THAT case is the frontend's own contact-form fallback
(see `chat-panel.tsx`'s `chatUnavailable` state), not an email alert.

Two independent, always-attempted, best-effort effects:
1. **Log** — every occurrence is appended as one JSON line to a
   bind-mounted `logs/errors.jsonl` (mirrors `owner-agent/logging_.py`'s
   own "stdout + a durable JSONL file" pattern) — durable across a
   container restart, readable via `GET /agent/error-log` without
   needing `docker compose logs`.
2. **Email alert** — sent via whatever email provider is already
   configured (`apis/notifications.py`'s `resolve_email_provider`), to
   `AppSettings.alert_email` if the owner has set one. No separate
   "enabled" flag — same posture as `is_email_configured`. Cooldown-
   gated (`ALERT_COOLDOWN_SECONDS`, in-process/single-worker — same
   assumption `rate_limit.py` already documents) so a crash loop sends
   one alert, not hundreds."""

import json
import logging
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("backend.errors")

LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "errors.jsonl"

ALERT_COOLDOWN_SECONDS = 900  # 15 minutes — see module docstring.
_last_alert_sent_at: float | None = None


def _append_log(entry: dict) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        logger.exception("Failed to write to the error log file")


def read_recent_errors(limit: int = 50) -> list[dict]:
    """Tails LOG_FILE — most-recent-first. Used by `GET /agent/error-log`
    (apis/agent.py). Missing file / unreadable lines are tolerated, not
    fatal — this is a diagnostic aid, never allowed to itself 500."""
    if not LOG_FILE.exists():
        return []
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    entries: list[dict] = []
    for line in reversed(lines[-limit:]):
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
        if len(entries) >= limit:
            break
    return entries


async def _maybe_send_alert(entry: dict) -> None:
    global _last_alert_sent_at
    now = time.monotonic()
    if _last_alert_sent_at is not None and now - _last_alert_sent_at < ALERT_COOLDOWN_SECONDS:
        return

    # Local imports — this module is registered at app-startup time
    # (main.py), before apis.notifications/db/models are necessarily
    # safe to import at module scope; deferring here also means this
    # (rarely-hit) path is the only place paying that import cost.
    from apis.notifications import is_email_configured, resolve_email_provider
    from db import SessionLocal
    from models import AppSettings
    from notifications import NotificationProviderNotConfigured

    db = SessionLocal()
    try:
        row = db.get(AppSettings, 1)
        alert_email = row.alert_email if row else None
        if not alert_email or not is_email_configured(db):
            return

        try:
            _name, provider = resolve_email_provider(db)
            await provider.send_email(
                alert_email,
                f"[AI MVP] Server error on {entry['method']} {entry['path']}",
                (
                    f"An unhandled error occurred at {entry['timestamp']}.\n\n"
                    f"{entry['method']} {entry['path']}\n\n{entry['error']}\n\n"
                    f"Full traceback:\n{entry['traceback']}"
                ),
            )
            _last_alert_sent_at = now
        except NotificationProviderNotConfigured as e:
            # Real gap caught during live verification: this exception
            # covers BOTH "no credentials configured" AND "the provider's
            # real API rejected the request" (see MailgunEmailProvider/
            # TwilioSMSProvider's own `raise NotificationProviderNotConfigured
            # (f"... rejected the send request: ...")` for a bad/expired
            # key) — silently `pass`ing here (the first cut of this
            # function) meant a bad Mailgun key would fail an alert with
            # ZERO trace anywhere, not even a log line. Always log now;
            # `is_email_configured` already prevents this from firing on
            # the ordinary "not configured yet" case, so anything that
            # reaches here is a genuine send failure worth knowing about.
            logger.error("Error-alert email was not sent: %s", e)
        except Exception:
            logger.exception("Failed to send the error-alert email")
    finally:
        db.close()


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Registered in main.py via `app.add_exception_handler(Exception, ...)`
    — only ever reaches a genuinely unhandled exception, never a
    deliberate `raise HTTPException(...)` (see this module's own
    docstring)."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "method": request.method,
        "path": request.url.path,
        "error": f"{type(exc).__name__}: {exc}",
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
    logger.error("Unhandled error on %s %s: %s", entry["method"], entry["path"], entry["error"])
    _append_log(entry)

    try:
        await _maybe_send_alert(entry)
    except Exception:
        logger.exception("Failed to run the error-alert path")

    return JSONResponse(status_code=500, content={"detail": "Internal server error."})
