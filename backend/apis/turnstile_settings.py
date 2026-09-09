"""Owner-facing Cloudflare Turnstile configuration + the public config
lookup the frontend needs to decide whether to render the widget at all.
Mirrors `apis/maps.py`'s shape exactly: one settings row, a write-only
secret, admin_router for the owner-facing CRUD, public_router for what
an anonymous visitor's browser needs. See `backend/turnstile.py`'s own
docstring for the full design reasoning."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import AppSettings

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()


def is_turnstile_enabled(row: AppSettings | None) -> bool:
    """A configured secret key is required too, not just the enabled
    flag — flipping the switch on with no site/secret key saved yet
    would otherwise silently reject every chat/contact/login attempt
    with no way for a real visitor to ever pass verification."""
    return bool(row and row.turnstile_enabled and row.turnstile_site_key and row.turnstile_secret_key)


class TurnstileSettings(BaseModel):
    turnstile_enabled: bool
    turnstile_site_key: str | None
    turnstile_secret_key_set: bool


@admin_router.get("/turnstile-settings", response_model=TurnstileSettings)
def get_turnstile_settings(db: Session = Depends(get_db)) -> TurnstileSettings:
    row = db.get(AppSettings, 1)
    return TurnstileSettings(
        turnstile_enabled=bool(row and row.turnstile_enabled),
        turnstile_site_key=row.turnstile_site_key if row else None,
        turnstile_secret_key_set=bool(row and row.turnstile_secret_key),
    )


class UpdateTurnstileSettingsRequest(BaseModel):
    turnstile_enabled: bool
    turnstile_site_key: str | None = None
    # None = leave the previously-saved key alone (matches
    # apis/maps.py's google_maps_api_key semantics) — only send this when
    # the owner actually typed a new one.
    turnstile_secret_key: str | None = None


@admin_router.put("/turnstile-settings", response_model=TurnstileSettings)
def update_turnstile_settings(req: UpdateTurnstileSettingsRequest, db: Session = Depends(get_db)) -> TurnstileSettings:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.turnstile_enabled = req.turnstile_enabled
    if req.turnstile_site_key is not None:
        row.turnstile_site_key = req.turnstile_site_key or None
    if req.turnstile_secret_key is not None:
        row.turnstile_secret_key = req.turnstile_secret_key or None

    db.commit()
    db.refresh(row)
    return TurnstileSettings(
        turnstile_enabled=row.turnstile_enabled,
        turnstile_site_key=row.turnstile_site_key,
        turnstile_secret_key_set=bool(row.turnstile_secret_key),
    )


class TurnstileConfigResponse(BaseModel):
    # Whether the frontend should render the widget at all — True only
    # when the owner both flipped the switch AND saved a real site/secret
    # key pair (is_turnstile_enabled's own guard, reused here so this
    # endpoint and the actual enforcement in chat.py/contact.py/auth.py
    # can never disagree about whether the feature is really on).
    enabled: bool
    site_key: str | None


@public_router.get("/turnstile-config", response_model=TurnstileConfigResponse)
def get_turnstile_config(db: Session = Depends(get_db)) -> TurnstileConfigResponse:
    """Public, no-auth — a page-view-time lookup only (never gated
    itself, see backend/turnstile.py's own docstring for why nothing in
    this feature ever gates a GET). `site_key` isn't a secret: it's
    designed to be embedded directly in browser-side JS on every real
    Turnstile integration, the same posture as Stripe's own publishable
    key."""
    row = db.get(AppSettings, 1)
    return TurnstileConfigResponse(enabled=is_turnstile_enabled(row), site_key=row.turnstile_site_key if row else None)
