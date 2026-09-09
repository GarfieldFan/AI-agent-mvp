"""Real, live tests against Cloudflare's actual siteverify API
(2026-09-10) — same "hit the real thing, don't mock" culture this test
suite already holds itself to (see conftest.py's own docstring). Uses
Cloudflare's own officially-documented dummy test secrets, meant for
exactly this — no real Cloudflare account or site needed:
https://developers.cloudflare.com/turnstile/troubleshooting/testing/
"""

import pytest

from turnstile import verify_turnstile_token

_ALWAYS_PASS_SECRET = "1x0000000000000000000000000000000AA"
_ALWAYS_FAIL_SECRET = "2x0000000000000000000000000000000AA"


@pytest.mark.asyncio
async def test_verify_turnstile_token_passes_with_dummy_pass_secret():
    assert await verify_turnstile_token(_ALWAYS_PASS_SECRET, "any-token-at-all", "127.0.0.1") is True


@pytest.mark.asyncio
async def test_verify_turnstile_token_fails_with_dummy_fail_secret():
    assert await verify_turnstile_token(_ALWAYS_FAIL_SECRET, "any-token-at-all", "127.0.0.1") is False


@pytest.mark.asyncio
async def test_verify_turnstile_token_fails_closed_on_missing_token():
    """A missing token never even reaches Cloudflare — an attacker
    skipping the widget entirely must not be treated as "couldn't check,
    let it through"."""
    assert await verify_turnstile_token(_ALWAYS_PASS_SECRET, None, "127.0.0.1") is False
    assert await verify_turnstile_token(_ALWAYS_PASS_SECRET, "", "127.0.0.1") is False


@pytest.mark.asyncio
async def test_verify_turnstile_token_fails_open_on_network_error(monkeypatch):
    """The opposite direction — a genuine network/timeout error talking
    to Cloudflare must NOT block every real visitor's chat/contact/login
    attempt. See turnstile.py's own docstring for the full reasoning."""
    import httpx

    class _BrokenClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            raise httpx.ConnectError("simulated network failure")

    monkeypatch.setattr(httpx, "AsyncClient", _BrokenClient)
    assert await verify_turnstile_token(_ALWAYS_PASS_SECRET, "any-token", "127.0.0.1") is True
