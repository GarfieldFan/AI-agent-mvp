"""Owner-only JWT auth — deliberately duplicated from backend/apis/deps.py
and backend/auth.py rather than imported. There is no way to import across
a container boundary (this is a separate image with no access to backend/'s
source tree), and this repo's isolation principle (see root AGENTS.md,
"Agent execution must eventually be isolated") treats that boundary as a
feature, not friction: this service's only capability is calling backend's
already-RBAC-gated REST endpoints over HTTP, forwarding the caller's own
token so backend independently re-checks on every real action too.

Stricter than backend's agent.py router (admin OR owner): this service
requires owner specifically, matching "the owner commands the agent."
"""

import os

import jwt
from fastapi import Header, HTTPException

# Same default as backend/auth.py's JWT_SECRET — sourced from the same
# docker-compose env var so there's one source of truth for the shared
# secret's default, not two independently-hardcoded literals.
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-only-insecure-secret-change-me")
JWT_ALGORITHM = "HS256"


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


async def require_owner(authorization: str | None = Header(default=None)) -> str:
    """Returns the raw bearer token (for forwarding to backend on every tool
    call) if it decodes to a valid, unexpired, owner-role JWT. Raises 401 for
    a missing/invalid/expired token, 403 for a valid token that isn't owner
    — unlike backend/apis/deps.py's get_current_user, there's no anonymous
    fallback here: this endpoint has no public/unauthenticated use case."""
    token = _extract_bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if payload.get("role") != "owner":
        raise HTTPException(status_code=403, detail="Requires the owner role")

    return token
