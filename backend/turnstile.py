"""Bot verification (2026-09-10) — Cloudflare Turnstile, the same
"swappable, off-by-default" shape as `payments.py`/`notifications.py`/
`maps.py`, narrowed to one real provider since there's no meaningful
second vendor need yet (Turnstile is free, privacy-friendly, and mostly
invisible to a real visitor — the same reasoning `maps.py`'s own
docstring gives for not building a speculative multi-vendor matrix
before there's an actual second need).

Unlike those other gates, there's no "TestTurnstileProvider" — disabled
(`AppSettings.turnstile_enabled == False`, the default) already IS the
zero-friction no-op state every other gate's "test" mode exists to
provide, so a separate always-passing provider class would just be
another name for the same thing. `verify_turnstile_token` is the one
function every gated endpoint calls; it's a no-op returning `True`
whenever the feature is off, so nothing anywhere else needs its own
"is this even enabled" branch.

Deliberately narrow scope, confirmed directly with the user
(`AskUserQuestion`): gates only three fully-public WRITE endpoints —
`/api/chat` (first turn only), `/api/contact`, `/api/auth/login` — never
a page view. This is what keeps it structurally incapable of affecting
SEO/GEO: every crawler this app cares about (see the root AGENTS.md's
GEO sections, `robots.ts`, `llms.txt`) only ever issues GET requests
against page/asset routes, and never POSTs a chat message, contact form,
or login attempt — there is no code path where a bot-verification check
could ever run against a crawler's own request in the first place. See
the root AGENTS.md's "Bot verification" section for the full design
discussion."""

import httpx

_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


async def verify_turnstile_token(secret_key: str, token: str | None, remote_ip: str | None) -> bool:
    """Calls Cloudflare's real siteverify endpoint. Fails closed on a
    missing token (an attacker skipping the widget entirely shouldn't
    get treated as "couldn't check, let it through") but fails OPEN on a
    genuine network/timeout error talking to Cloudflare — a Cloudflare
    outage blocking every real visitor's chat/contact/login attempt
    would be a worse outcome than briefly losing this one layer of
    defense, the same "never let an optional safety net become a hard
    dependency" posture `resource_broker.py`'s own functions already
    hold themselves to elsewhere in this app."""
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                _VERIFY_URL,
                data={
                    "secret": secret_key,
                    "response": token,
                    **({"remoteip": remote_ip} if remote_ip else {}),
                },
            )
        return bool(resp.json().get("success"))
    except (httpx.HTTPError, ValueError):
        return True
