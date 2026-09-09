"""Owner-facing view onto `error_alerts.py`'s basic error log (2026-09-09)
— a small, dedicated file, same "one concern, one file" precedent as
`apis/chat_settings.py`/`apis/crm_resume.py`. The alert-email address
itself lives in `apis/notifications.py`'s `NotificationSettings`
(alongside Mailgun/Twilio — it's one more "where do alerts go" setting
in that same panel), not here — this file is purely: read the log, and
deliberately trigger the real error path once to prove the whole
log+alert pipeline actually works."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from apis.deps import Role, require_role
from error_alerts import read_recent_errors

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


class ErrorLogEntry(BaseModel):
    timestamp: str
    method: str
    path: str
    error: str
    traceback: str


@router.get("/error-log", response_model=list[ErrorLogEntry])
def get_error_log(limit: int = 50) -> list[ErrorLogEntry]:
    """Most-recent-first. Reads directly from the JSONL file — no DB
    table for this (see error_alerts.py's own docstring for why "basic"
    was the right scope here)."""
    return [ErrorLogEntry(**entry) for entry in read_recent_errors(limit=limit)]


@router.post("/error-log/test")
def trigger_test_error() -> None:
    """Deliberately raises an unhandled exception so it flows through the
    REAL path (main.py's global exception handler -> error_alerts.py's
    logging + cooldown-gated email alert) — a genuine end-to-end test of
    the whole pipeline, not a separate, parallel "pretend send" like the
    notification panel's own test-email/test-sms buttons. The owner sees
    a plain 500 in the dashboard (expected) and should then check the
    error log / their alert inbox."""
    raise RuntimeError("This is a test error, deliberately triggered from the dashboard's error-log panel.")
