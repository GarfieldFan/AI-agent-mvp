"""Per-IP request-rate limiting for this app's fully public, no-auth
endpoints: `/api/chat`, `/api/chat/upload` (apis/chat.py — no `require_role`
gate at all, see the root AGENTS.md's RBAC note), `/api/auth/login`
(the classic brute-force target, and every other route's own front door),
and `/api/cart/add` (apis/products.py's public_router — a real mutation,
2026-08-19).

Everything else in this backend already sits behind `require_role` — a
stolen/guessed JWT is a much bigger problem than a fast caller, and rate-
limiting an authenticated admin/owner (e.g. the owner-agent's own chain of
backend calls) would get in the way of legitimate use for no real security
benefit. So this stays scoped to the routes above, not a blanket global
limiter — the public product read/search routes are plain SELECTs, same
posture as the already-unlimited `GET /pages/{slug}`, so they get no rule.

In-memory, single-process, sliding-window-by-trimming (not a token
bucket) — deliberately the simplest thing that works, not slowapi/Redis:
this app runs as one uvicorn worker in one container (see docker-
compose.yml), so there's no multi-process state to share, and adding
Redis just for this would be exactly the kind of new-infra-for-its-own-
sake the rest of this project avoids (see the root AGENTS.md's provider-
swap philosophy — infra gets added when a real need forces it, not
speculatively). If this app ever runs multiple workers/replicas, this
in-memory state stops being shared across them and the effective limit
multiplies accordingly — a real limitation worth knowing about, not
silently wrong.

Trusts `request.client.host` only — never `X-Forwarded-For`. This stack
has no reverse proxy in front of `backend` (docker-compose maps its port
straight out), so there's no trusted hop that could have set that header
correctly; honoring it here would let any caller claim to be any IP and
trivially bypass the limit.
"""

import time
from collections import deque
from dataclasses import dataclass

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


@dataclass(frozen=True)
class RateLimitRule:
    window_seconds: float
    max_requests: int


# (method, exact path) -> rule. Exact match, not a prefix — "/api/chat"
# must never accidentally also cover "/api/chat/upload"'s own budget.
RULES: dict[tuple[str, str], RateLimitRule] = {
    # A real chat turn can now trigger up to three model calls (attachment
    # analysis, the reply, lead-capture extraction — see apis/chat.py), so
    # this budget is generous enough for a real conversation while still
    # blocking a scripted flood.
    ("POST", "/api/chat"): RateLimitRule(window_seconds=300, max_requests=20),
    ("POST", "/api/chat/upload"): RateLimitRule(window_seconds=300, max_requests=10),
    # Classic anti-brute-force cadence — enough attempts for someone who
    # fat-fingered their password twice, not enough to meaningfully guess
    # one of the 3 seeded demo passwords.
    ("POST", "/api/auth/login"): RateLimitRule(window_seconds=900, max_requests=10),
    # A real public mutation (2026-08-19, apis/products.py's add_to_cart)
    # — same tier as /api/chat/upload, not the read-only product/search
    # routes (no rule needed there, same posture as GET /pages/{slug}).
    ("POST", "/api/cart/add"): RateLimitRule(window_seconds=300, max_requests=30),
}

# (method, path, ip) -> recent request timestamps (monotonic clock, so a
# system clock adjustment can't reset or extend anyone's window). A caller
# who never revisits a limited route leaves one small entry behind for the
# life of the process — an accepted, bounded-in-practice memory cost for a
# single-container MVP, not worth a background eviction thread over.
_hits: dict[tuple[str, str, str], deque[float]] = {}


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rule = RULES.get((request.method, request.url.path))
        if rule is None:
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        key = (request.method, request.url.path, client_ip)
        now = time.monotonic()

        hits = _hits.get(key, deque())
        while hits and now - hits[0] > rule.window_seconds:
            hits.popleft()

        if len(hits) >= rule.max_requests:
            retry_after = rule.window_seconds - (now - hits[0])
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests — please slow down and try again shortly."},
                headers={"Retry-After": str(max(1, int(retry_after)))},
            )

        hits.append(now)
        _hits[key] = hits
        return await call_next(request)
