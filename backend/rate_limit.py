"""Per-IP request-rate limiting for this app's fully public, no-auth
endpoints: `/api/chat`, `/api/chat/upload` (apis/chat.py — no `require_role`
gate at all, see the root AGENTS.md's RBAC note), `/api/auth/login`
(the classic brute-force target, and every other route's own front door),
`/api/cart/add` (apis/products.py's public_router — a real mutation,
2026-08-19), `/api/crm/resume/request`/`/api/crm/resume/verify`
(apis/crm_resume.py, 2026-08-20 — an email-bombing target and a
brute-force-a-code target respectively), and `/api/contact`
(apis/contact.py, 2026-09-09 — the same "public, no-auth, writes a real
CrmEntry" shape as `/api/cart/add`).

Everything else in this backend already sits behind `require_role` — a
stolen/guessed JWT is a much bigger problem than a fast caller, and rate-
limiting an authenticated admin/owner (e.g. the owner-agent's own chain of
backend calls) would get in the way of legitimate use for no real security
benefit. So this stays scoped to the routes above, plus (2026-09-10,
`PREFIX_RULES` below) every fully-public GET read route.

**That last part reverses this file's own earlier reasoning** — public
GET routes ("plain SELECTs") were originally judged to need no rule at
all, same posture as an already-unlimited `GET /pages/{slug}`. A real
stress test found that assumption wrong: a burst of a couple hundred
concurrent requests to just ONE such route (no auth, no botnet, one
machine) exhausted this app's entire DB connection pool and left the
whole backend unresponsive to ALL traffic — not just that route — for
90+ seconds with no self-recovery, requiring a container restart. See
`db.py`'s own `pool_size`/`pool_timeout` for the other half of this fix
(fail fast under contention instead of hanging forever) — the rules
below are what stop a single IP from creating that contention at all.

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

**Known caveat, not solved here**: once a real deployment puts Nginx in
front of `backend` (`deploy/`'s `--domain` mode), every request this
middleware sees arrives from Nginx's own connecting IP, not the real
visitor's — the identical reason `X-Forwarded-For` isn't trusted above
applies in reverse once a real trusted hop DOES exist. In that specific
topology, per-IP limiting here degrades toward "one shared budget for
the whole site's traffic" rather than per-visitor. This is why
`deploy/nginx.conf.template` also gained its own `limit_req`/`limit_conn`
(2026-09-10) — Nginx sees the real client IP directly and is the correct
place to enforce this once it's in the request path at all; the rules in
this file remain the real, effective protection for the plain
docker-compose topology (no domain, no Nginx, backend port reachable
directly) and as defense-in-depth otherwise.
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
    # — same tier as /api/chat/upload. The read-only product/search
    # routes get their own, much more generous rule in PREFIX_RULES below.
    ("POST", "/api/cart/add"): RateLimitRule(window_seconds=300, max_requests=30),
    # apis/crm_resume.py (2026-08-20) — /request triggers a real email
    # send, so a generous limit here directly bounds how badly this could
    # be used to spam a stranger's inbox with codes (the per-entry
    # resume_code_attempts cap doesn't help against THIS route, which
    # doesn't need a correct code, just an email address). /verify is the
    # classic brute-force-a-code target — this IP-level budget is the
    # first line of defense; the per-entry attempt cap (survives even if
    # a caller spreads guesses across many source IPs) is the second.
    ("POST", "/api/crm/resume/request"): RateLimitRule(window_seconds=3600, max_requests=5),
    ("POST", "/api/crm/resume/verify"): RateLimitRule(window_seconds=900, max_requests=15),
    # apis/contact.py's public "contact us" form — same tier as
    # /api/chat/upload, bounds a scripted flood of CrmEntry rows.
    ("POST", "/api/contact"): RateLimitRule(window_seconds=300, max_requests=10),
}

# (method, path PREFIX) -> rule, for a public route *family* that
# includes a dynamic segment (a slug, a product id, a search query, ...)
# — every request under the prefix shares ONE per-IP budget, so a caller
# can't dodge the limit by hitting a different slug/id/query each time.
# Matched as `path == prefix or path.startswith(prefix + "/")` (see
# `_prefix_rule_for`), never a bare substring check, so e.g.
# "/api/products" can never accidentally also swallow the real, different
# "/api/product-fields" route. A short window (10s) with a generous cap
# (60) is deliberately closer to a concurrency cap than a rate limit —
# real human browsing never approaches it; the stress test that found
# this gap broke down somewhere between 150 (fine) and 220 (broke)
# concurrent requests, so 60 leaves a wide margin under that while still
# making the exact attack that was found impossible to reproduce.
PREFIX_RULES: dict[tuple[str, str], RateLimitRule] = {
    ("GET", "/api/pages"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/products"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/product-fields"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/business-profile"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/map-embed"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/payment-config"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/checkout/session-status"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/turnstile-config"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/cart"): RateLimitRule(window_seconds=10, max_requests=60),
    ("GET", "/api/auth/oauth-providers"): RateLimitRule(window_seconds=10, max_requests=60),
}


def _prefix_rule_for(method: str, path: str) -> tuple[str, RateLimitRule] | None:
    """Longest-prefix match against PREFIX_RULES — a boundary-aware
    startswith, not a bare substring, so "/api/pages" matches
    "/api/pages" and "/api/pages/home" but never "/api/pagesfoo"."""
    best: tuple[str, RateLimitRule] | None = None
    for (rule_method, prefix), rule in PREFIX_RULES.items():
        if rule_method != method:
            continue
        if path == prefix or path.startswith(prefix + "/"):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, rule)
    return best


# (method, path, ip) -> recent request timestamps (monotonic clock, so a
# system clock adjustment can't reset or extend anyone's window). A caller
# who never revisits a limited route leaves one small entry behind for the
# life of the process — an accepted, bounded-in-practice memory cost for a
# single-container MVP, not worth a background eviction thread over.
_hits: dict[tuple[str, str, str], deque[float]] = {}


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rule = RULES.get((request.method, request.url.path))
        # `bucket_path` is what every request under a matched PREFIX_RULES
        # entry shares — the prefix itself, not each distinct slug/id/query
        # — so hitting /api/pages/a, /api/pages/b, /api/pages/c, ... all
        # draws from the same per-IP budget instead of each getting its
        # own fresh one.
        bucket_path = request.url.path
        if rule is None:
            prefix_match = _prefix_rule_for(request.method, request.url.path)
            if prefix_match is None:
                return await call_next(request)
            bucket_path, rule = prefix_match

        client_ip = request.client.host if request.client else "unknown"
        key = (request.method, bucket_path, client_ip)
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
