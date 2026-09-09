"""Real login — replaces the old `X-Debug-Role` placeholder.

Demo scope: no signup, no password reset — a small fixed set of seeded
accounts (see ../seed.py) covering owner/admin/user. Enough to demo real
JWT-based RBAC end to end without building a full account system.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, get_current_user
from apis.turnstile_settings import is_turnstile_enabled
from auth import create_access_token, verify_password
from db import get_db
from models import AppSettings, User
from turnstile import verify_turnstile_token

router = APIRouter(prefix="/auth")


class LoginRequest(BaseModel):
    email: str
    password: str
    # Cloudflare Turnstile response token (2026-09-10) — see
    # backend/turnstile.py's own docstring. Checked before the password
    # itself, same "reject cheaply, first" posture as chat.py/contact.py.
    turnstile_token: str | None = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    role: str


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    settings_row = db.get(AppSettings, 1)
    if is_turnstile_enabled(settings_row):
        client_ip = request.client.host if request.client else None
        if not await verify_turnstile_token(settings_row.turnstile_secret_key, req.turnstile_token, client_ip):
            raise HTTPException(status_code=428, detail="Bot verification required.")

    user = db.scalar(select(User).where(User.email == req.email))
    # An OAuth-only account (models.User.hashed_password is now nullable,
    # 2026-08-22) has no password to check against at all — always fails
    # this path, correctly, since its only real login path is the OAuth
    # flow (apis/oauth.py).
    if user is None or user.hashed_password is None or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_access_token(user_id=user.id, email=user.email, role=user.role)
    return LoginResponse(access_token=token, email=user.email, role=user.role)


class MeResponse(BaseModel):
    email: str
    role: str


@router.get("/me", response_model=MeResponse)
async def me(current: CurrentUser = Depends(get_current_user)) -> MeResponse:
    if current.email is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return MeResponse(email=current.email, role=current.role.value)
