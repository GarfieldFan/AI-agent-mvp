"""User management (2026-08-22) — the admin/owner-facing counterpart to
apis/my_account.py's self-service `/my/*` routes: instead of "my own
data," this is "every account in the system."

**Listing is admin+owner** (matches this app's usual read-access bar —
most of `agent-console-section.tsx`'s panels are admin+owner-viewable);
**every write (create, role change, delete) is owner-only** — a role
change or account deletion is a genuinely higher-stakes action than
anything an admin panel elsewhere in this app lets an admin do alone,
the same trust split `owner-agent`'s schema-proposal flow already
established for "this changes what data/access looks like going
forward."

**Creating a user here is a real, trusted account-provisioning path** —
mirrors `seed.py`'s own reasoning exactly: an owner personally setting a
password for a new account is proof enough of intent/ownership to mark
`email_verified=True` immediately (skips the "first login reclaims an
unverified password" dance `apis/oauth.py` has to handle for a
self-service signup this app doesn't even have). This is NOT a public
signup endpoint — no route here is reachable without an owner's own JWT.

**Safety guards, both enforced server-side, not just hidden in the UI**:
an owner can never change their own role or delete their own account
(closes the "the only owner locks themselves out" failure mode), and the
system can never be left with zero `role == "owner"` accounts (checked
freshly against the DB on every role-change/delete, not cached) — either
guard alone would still leave a real footgun the other one catches.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, Role, get_current_user, require_role
from auth import hash_password
from db import get_db
from models import User

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


def _require_owner(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """`require_role(...)` (used for the router-level admin+owner read
    gate above) resolves to just the matched `Role`, not the caller's own
    identity — the write routes below need BOTH "is this the owner role"
    AND "who exactly is this" (for the self-modification guards), so they
    depend on this instead."""
    if current.role != Role.owner:
        raise HTTPException(status_code=403, detail="Requires one of roles: ['owner']")
    return current


class UserSummary(BaseModel):
    id: int
    email: str
    role: str
    oauth_provider: str | None
    email_verified: bool
    created_at: datetime


def _to_summary(user: User) -> UserSummary:
    return UserSummary(
        id=user.id,
        email=user.email,
        role=user.role,
        oauth_provider=user.oauth_provider,
        email_verified=user.email_verified,
        created_at=user.created_at,
    )


class UserListResponse(BaseModel):
    items: list[UserSummary]
    total: int


@router.get("/users", response_model=UserListResponse)
def list_users(limit: int = 50, offset: int = 0, db: Session = Depends(get_db)) -> UserListResponse:
    total = db.scalar(select(func.count()).select_from(User)) or 0
    rows = db.scalars(select(User).order_by(User.created_at.desc()).limit(limit).offset(offset)).all()
    return UserListResponse(items=[_to_summary(u) for u in rows], total=total)


class CreateUserRequest(BaseModel):
    email: str
    password: str
    role: str = "user"


@router.post("/users", response_model=UserSummary)
def create_user(
    req: CreateUserRequest,
    current: CurrentUser = Depends(_require_owner),
    db: Session = Depends(get_db),
) -> UserSummary:
    if req.role not in {r.value for r in Role}:
        raise HTTPException(status_code=400, detail=f"role must be one of {[r.value for r in Role]}")
    if not req.password:
        raise HTTPException(status_code=400, detail="password is required")

    existing = db.scalar(select(User).where(User.email == req.email))
    if existing is not None:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    user = User(
        email=req.email,
        hashed_password=hash_password(req.password),
        role=req.role,
        # Owner-provisioned is a trusted creation path — see this
        # module's own docstring.
        email_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _to_summary(user)


def _remaining_owner_count(db: Session, excluding_user_id: int | None = None) -> int:
    stmt = select(func.count()).select_from(User).where(User.role == Role.owner.value)
    if excluding_user_id is not None:
        stmt = stmt.where(User.id != excluding_user_id)
    return db.scalar(stmt) or 0


class UpdateUserRoleRequest(BaseModel):
    role: str


@router.patch("/users/{user_id}/role", response_model=UserSummary)
def update_user_role(
    user_id: int,
    req: UpdateUserRoleRequest,
    current: CurrentUser = Depends(_require_owner),
    db: Session = Depends(get_db),
) -> UserSummary:
    if req.role not in {r.value for r in Role}:
        raise HTTPException(status_code=400, detail=f"role must be one of {[r.value for r in Role]}")

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if user.email == current.email:
        raise HTTPException(status_code=400, detail="You can't change your own role")

    if user.role == Role.owner.value and req.role != Role.owner.value:
        if _remaining_owner_count(db, excluding_user_id=user.id) == 0:
            raise HTTPException(status_code=400, detail="Can't demote the last remaining owner")

    user.role = req.role
    db.commit()
    db.refresh(user)
    return _to_summary(user)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    current: CurrentUser = Depends(_require_owner),
    db: Session = Depends(get_db),
) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if user.email == current.email:
        raise HTTPException(status_code=400, detail="You can't delete your own account")

    if user.role == Role.owner.value and _remaining_owner_count(db, excluding_user_id=user.id) == 0:
        raise HTTPException(status_code=400, detail="Can't delete the last remaining owner")

    db.delete(user)
    db.commit()
