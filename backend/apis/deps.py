"""Role resolution and RBAC gating — backed by real JWTs as of 2026-08-04
(see ../auth.py for signing/verification, apis/auth.py for the login
route that issues them). Previously read a plain `X-Debug-Role` header;
that placeholder is gone now that real login exists.

No token, or an invalid/expired one, always resolves to the anonymous
`user` role rather than erroring — the public chatbot must keep working
without anyone logging in. Only routes gated by `require_role(...)`
actually reject an insufficiently-privileged caller.

Never trust the frontend's role display alone (see
frontend/src/components/common/role-badge.tsx) — every privileged route
must depend on `require_role` itself, not on the caller having hidden a
button.
"""

from enum import Enum
from typing import NamedTuple

from fastapi import Depends, Header, HTTPException

from auth import decode_access_token


class Role(str, Enum):
    owner = "owner"
    admin = "admin"
    user = "user"


class CurrentUser(NamedTuple):
    email: str | None
    role: Role


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


async def get_current_user(authorization: str | None = Header(default=None)) -> CurrentUser:
    token = _extract_bearer_token(authorization)
    payload = decode_access_token(token) if token else None
    if payload is None:
        return CurrentUser(email=None, role=Role.user)

    role = payload.get("role")
    if role not in {r.value for r in Role}:
        return CurrentUser(email=None, role=Role.user)

    return CurrentUser(email=payload.get("email"), role=Role(role))


async def get_current_role(current: CurrentUser = Depends(get_current_user)) -> Role:
    return current.role


async def require_authenticated_user(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """401s unless a real, valid JWT was presented — unlike get_current_user
    (which never rejects, so the public/tool-free chat path keeps working
    for anonymous visitors), this is for a NEW class of route (2026-08-22,
    apis/my_account.py) that isn't gated by role at all — any logged-in
    account (user/admin/owner) can see their OWN data — but does require
    someone to actually be logged in, since "your own data" is
    meaningless for an anonymous caller."""
    if current.email is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return current


def require_role(*allowed: Role):
    """FastAPI dependency factory: raises 403 unless the resolved role is
    one of `allowed`. Usage: `Depends(require_role(Role.admin, Role.owner))`."""

    async def _check(role: Role = Depends(get_current_role)) -> Role:
        if role not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Requires one of roles: {[r.value for r in allowed]}",
            )
        return role

    return _check
