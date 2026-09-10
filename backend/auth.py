"""Password hashing + JWT issuing/verification for real login.

Demo-scope auth (see apis/auth.py for the login route, apis/deps.py for
how the JWT gets verified on every request): no refresh tokens, no
password reset, no email verification. Real signed JWTs backed by a real
`users` table, replacing the `X-Debug-Role` placeholder — good enough to
demo real RBAC, not a production auth system.
"""

import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

# TEMPORARY/demo-only fallback. A real deployment must set this via a
# secret manager, never a hardcoded default — fine for a local
# docker-compose demo that never leaves the host, not fine for anything
# actually exposed to the internet.
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-only-insecure-secret-change-me")
JWT_ALGORITHM = "HS256"
# Long enough that a demo run never needs a re-login mid-flow.
JWT_EXPIRES_MINUTES = 60 * 24


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(*, user_id: int, email: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "email": email,
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """Returns the decoded payload, or None if the token is missing,
    expired, or has an invalid signature. Callers treat None the same as
    "not logged in" — this never raises."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
