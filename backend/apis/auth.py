"""Real login — replaces the old `X-Debug-Role` placeholder.

Demo scope: no signup, no password reset — a small fixed set of seeded
accounts (see ../seed.py) covering owner/admin/user. Enough to demo real
JWT-based RBAC end to end without building a full account system.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, get_current_user
from auth import create_access_token, verify_password
from db import get_db
from models import User

router = APIRouter(prefix="/auth")


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    role: str


@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    user = db.scalar(select(User).where(User.email == req.email))
    if user is None or not verify_password(req.password, user.hashed_password):
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
