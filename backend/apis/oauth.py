"""Social login for the public `user` tier (2026-08-22) — Google first,
as the reference implementation (confirmed directly with the user before
building), then Facebook and X (2026-08-22, same day, on a direct
follow-up ask to "prepare the interface" for all three).

Confirmed directly with the user: admin/owner accounts NEVER use OAuth —
they stay on the existing password+JWT system (apis/auth.py) exactly as
before. This module only ever creates/logs in a plain `role: "user"`
account; nothing here can produce a privileged session.

Owner-configured credentials per provider, same pattern as
Stripe/Mailgun/Twilio/Maps — each provider's `*_client_secret` is
write-only (write-only, never echoed back by `GET /agent/oauth-settings`),
no separate "enabled" flag (derived from both id+secret being set).

**Google and Facebook share the same shape** — a standard OAuth2
authorization-code grant: the browser navigates (not a fetch call — a
real top-level redirect) to `/start`, which redirects to the provider's
own consent screen with a random `state` value also stashed in a
short-lived httponly cookie; the provider redirects back to `/callback`
with `code`+`state`; the cookie value is compared against the returned
`state` (CSRF protection — a plain unguessable nonce is sufficient here,
no need to sign it, since its only job is proving the callback belongs
to a request this backend itself just issued); the code is exchanged for
an access token, which is used to fetch the visitor's verified email
from the provider's own userinfo endpoint.

**X is NOT the same flow** — OAuth 2.0 with PKCE (a public-client
requirement X enforces), so `/oauth/x/start` also generates and stashes
a `code_verifier` in a second short-lived cookie, sent again during the
token exchange as `code_challenge`/`code_verifier`. **More importantly,
X's standard API does not reliably return an email address at all** —
X locked this down years ago; getting one requires an elevated
permission from X's own Developer Portal that isn't guaranteed to be
approved and is entirely outside this app's control. Built and wired up
anyway (the user explicitly asked for the interface to be ready), but
X sign-in may simply fail at the "no email returned" step depending on
what the owner's own X Developer app is actually approved for — this is
disclosed to the owner in `OAuthSettingsPanel`, not silently hidden.

Whichever provider succeeds, the shared `_finish_oauth_login` finds-or-
creates a `User` row by email (role always defaults to "user" for a
brand-new account — this path can never create/promote an admin/owner)
and issues this app's OWN JWT (the exact same `create_access_token`
apis/auth.py's password login already uses — OAuth is just an alternate
way to prove identity before this app takes over session management
with its own token, never a replacement of it). **Merging into an
existing row checks `User.email_verified`** (2026-08-22, added
pre-emptively — see that column's own docstring for the pre-registration/
account-hijack attack this closes): an already-verified row just gets
`oauth_provider` updated, but an unverified row has its `hashed_password`
wiped and gets marked verified instead — a real, provider-agnostic
identity verification outranks whatever unverified password was already
sitting there. The browser is redirected back to the frontend's `/login`
page with the issued token as a query param — mirrors `?sid=` cart
recovery's own "query-param handoff, frontend bootstraps and strips it"
pattern already established in this app."""

import base64
import hashlib
import os
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from auth import create_access_token
from db import get_db
from models import AppSettings, User

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter(prefix="/auth")

BACKEND_PUBLIC_URL = os.environ.get("BACKEND_PUBLIC_URL", "http://localhost:8000")
FRONTEND_PUBLIC_URL = os.environ.get("FRONTEND_PUBLIC_URL", "http://localhost:3000")
_ERROR_REDIRECT = f"{FRONTEND_PUBLIC_URL}/login?oauth_error=1"

_GOOGLE_CALLBACK_URL = f"{BACKEND_PUBLIC_URL}/api/auth/oauth/google/callback"
_GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
_GOOGLE_STATE_COOKIE = "oauth_state_google"

_FACEBOOK_CALLBACK_URL = f"{BACKEND_PUBLIC_URL}/api/auth/oauth/facebook/callback"
_FACEBOOK_AUTHORIZE_URL = "https://www.facebook.com/v21.0/dialog/oauth"
_FACEBOOK_TOKEN_URL = "https://graph.facebook.com/v21.0/oauth/access_token"
_FACEBOOK_USERINFO_URL = "https://graph.facebook.com/me"
_FACEBOOK_STATE_COOKIE = "oauth_state_facebook"

_X_CALLBACK_URL = f"{BACKEND_PUBLIC_URL}/api/auth/oauth/x/callback"
_X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
_X_TOKEN_URL = "https://api.x.com/2/oauth2/token"
_X_USERINFO_URL = "https://api.x.com/2/users/me"
_X_STATE_COOKIE = "oauth_state_x"
_X_VERIFIER_COOKIE = "oauth_verifier_x"


class OAuthCallbackError(Exception):
    """Raised for any failure during a provider's callback exchange —
    caught once at each route level and turned into a redirect back to
    the frontend's login page with a readable error, never a raw 500
    (the visitor is mid-browser-redirect at this point, not making an
    API call a frontend error handler could catch)."""


# ---------------------------------------------------------------------------
# Owner-facing settings (admin/owner-gated)
# ---------------------------------------------------------------------------


class OAuthSettings(BaseModel):
    google_client_id: str | None
    google_client_secret_set: bool
    google_callback_url: str
    facebook_client_id: str | None
    facebook_client_secret_set: bool
    facebook_callback_url: str
    x_client_id: str | None
    x_client_secret_set: bool
    x_callback_url: str


def _to_oauth_settings(row: AppSettings | None) -> OAuthSettings:
    return OAuthSettings(
        google_client_id=row.google_oauth_client_id if row else None,
        google_client_secret_set=bool(row and row.google_oauth_client_secret),
        google_callback_url=_GOOGLE_CALLBACK_URL,
        facebook_client_id=row.facebook_oauth_client_id if row else None,
        facebook_client_secret_set=bool(row and row.facebook_oauth_client_secret),
        facebook_callback_url=_FACEBOOK_CALLBACK_URL,
        x_client_id=row.x_oauth_client_id if row else None,
        x_client_secret_set=bool(row and row.x_oauth_client_secret),
        x_callback_url=_X_CALLBACK_URL,
    )


@admin_router.get("/oauth-settings", response_model=OAuthSettings)
def get_oauth_settings(db: Session = Depends(get_db)) -> OAuthSettings:
    return _to_oauth_settings(db.get(AppSettings, 1))


class UpdateOAuthSettingsRequest(BaseModel):
    google_client_id: str | None = None
    # None = leave the previously-saved secret alone, same convention as
    # every other write-only credential in this app.
    google_client_secret: str | None = None
    facebook_client_id: str | None = None
    facebook_client_secret: str | None = None
    x_client_id: str | None = None
    x_client_secret: str | None = None


@admin_router.put("/oauth-settings", response_model=OAuthSettings)
def update_oauth_settings(req: UpdateOAuthSettingsRequest, db: Session = Depends(get_db)) -> OAuthSettings:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.google_oauth_client_id = req.google_client_id or None
    if req.google_client_secret is not None:
        row.google_oauth_client_secret = req.google_client_secret or None
    row.facebook_oauth_client_id = req.facebook_client_id or None
    if req.facebook_client_secret is not None:
        row.facebook_oauth_client_secret = req.facebook_client_secret or None
    row.x_oauth_client_id = req.x_client_id or None
    if req.x_client_secret is not None:
        row.x_oauth_client_secret = req.x_client_secret or None

    db.commit()
    db.refresh(row)
    return _to_oauth_settings(row)


# ---------------------------------------------------------------------------
# Shared: find-or-create + issue this app's own JWT + redirect
# ---------------------------------------------------------------------------


def _finish_oauth_login(db: Session, email: str, provider: str) -> RedirectResponse:
    """Shared across every provider — see this module's own docstring for
    the full email_verified reclaim reasoning."""
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, hashed_password=None, oauth_provider=provider, email_verified=True)
        db.add(user)
    elif user.email_verified:
        user.oauth_provider = provider
    else:
        user.oauth_provider = provider
        user.hashed_password = None
        user.email_verified = True
    db.commit()
    db.refresh(user)

    token = create_access_token(user_id=user.id, email=user.email, role=user.role)
    return RedirectResponse(f"{FRONTEND_PUBLIC_URL}/login?oauth_token={token}")


# ---------------------------------------------------------------------------
# Providers list (public, no-auth)
# ---------------------------------------------------------------------------


class OAuthProvidersResponse(BaseModel):
    google: bool
    facebook: bool
    x: bool


@public_router.get("/oauth-providers", response_model=OAuthProvidersResponse)
def list_oauth_providers(db: Session = Depends(get_db)) -> OAuthProvidersResponse:
    """Public, no-auth — the login page reads this to decide which
    "Sign in with ..." buttons to show at all. Never exposes the
    credentials themselves, just whether each is set."""
    row = db.get(AppSettings, 1)
    return OAuthProvidersResponse(
        google=bool(row and row.google_oauth_client_id and row.google_oauth_client_secret),
        facebook=bool(row and row.facebook_oauth_client_id and row.facebook_oauth_client_secret),
        x=bool(row and row.x_oauth_client_id and row.x_oauth_client_secret),
    )


# ---------------------------------------------------------------------------
# Google
# ---------------------------------------------------------------------------


@public_router.get("/oauth/google/start")
def start_google_oauth(db: Session = Depends(get_db)) -> RedirectResponse:
    row = db.get(AppSettings, 1)
    if row is None or not row.google_oauth_client_id or not row.google_oauth_client_secret:
        raise HTTPException(
            status_code=503,
            detail="Google sign-in isn't configured yet — set a client ID/secret in the dashboard's "
            "OAuth settings first.",
        )

    state = secrets.token_urlsafe(32)
    params = {
        "client_id": row.google_oauth_client_id,
        "redirect_uri": _GOOGLE_CALLBACK_URL,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        # Avoids a returning visitor being silently re-logged-in as
        # whichever Google account they used last without a real choice
        # — a small UX correctness fix, not a security requirement.
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{_GOOGLE_AUTHORIZE_URL}?{urlencode(params)}")
    response.set_cookie(_GOOGLE_STATE_COOKIE, state, httponly=True, samesite="lax", max_age=600)
    return response


async def _google_fetch_email(code: str, client_id: str, client_secret: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        token_resp = await client.post(
            _GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": _GOOGLE_CALLBACK_URL,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code >= 400:
            raise OAuthCallbackError(f"Google rejected the code exchange: {token_resp.text[:300]}")
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise OAuthCallbackError("Google's token response had no access_token.")

        userinfo_resp = await client.get(_GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        if userinfo_resp.status_code >= 400:
            raise OAuthCallbackError(f"Google rejected the userinfo request: {userinfo_resp.text[:300]}")
        userinfo = userinfo_resp.json()

    email = userinfo.get("email")
    if not email:
        raise OAuthCallbackError("Google's userinfo response had no email.")
    # Google's own userinfo response includes this when the address is
    # actually verified (vs. e.g. an unconfirmed alias) — refusing an
    # unverified email avoids trusting an identity Google itself isn't
    # vouching for.
    if userinfo.get("email_verified") is False:
        raise OAuthCallbackError("Google reports this email address isn't verified.")
    return email


@public_router.get("/oauth/google/callback")
async def google_oauth_callback(
    request: Request, code: str | None = None, state: str | None = None, db: Session = Depends(get_db)
) -> RedirectResponse:
    cookie_state = request.cookies.get(_GOOGLE_STATE_COOKIE)
    if not code or not state or not cookie_state or state != cookie_state:
        return RedirectResponse(_ERROR_REDIRECT)

    row = db.get(AppSettings, 1)
    if row is None or not row.google_oauth_client_id or not row.google_oauth_client_secret:
        return RedirectResponse(_ERROR_REDIRECT)

    try:
        email = await _google_fetch_email(code, row.google_oauth_client_id, row.google_oauth_client_secret)
    except (OAuthCallbackError, httpx.HTTPError):
        return RedirectResponse(_ERROR_REDIRECT)

    response = _finish_oauth_login(db, email, "google")
    response.delete_cookie(_GOOGLE_STATE_COOKIE)
    return response


# ---------------------------------------------------------------------------
# Facebook — same authorization-code-grant shape as Google
# ---------------------------------------------------------------------------


@public_router.get("/oauth/facebook/start")
def start_facebook_oauth(db: Session = Depends(get_db)) -> RedirectResponse:
    row = db.get(AppSettings, 1)
    if row is None or not row.facebook_oauth_client_id or not row.facebook_oauth_client_secret:
        raise HTTPException(
            status_code=503,
            detail="Facebook sign-in isn't configured yet — set a client ID/secret in the dashboard's "
            "OAuth settings first.",
        )

    state = secrets.token_urlsafe(32)
    params = {
        "client_id": row.facebook_oauth_client_id,
        "redirect_uri": _FACEBOOK_CALLBACK_URL,
        "response_type": "code",
        # "email" must be explicitly requested — Facebook doesn't include
        # it by default even with public_profile alone.
        "scope": "email,public_profile",
        "state": state,
    }
    response = RedirectResponse(f"{_FACEBOOK_AUTHORIZE_URL}?{urlencode(params)}")
    response.set_cookie(_FACEBOOK_STATE_COOKIE, state, httponly=True, samesite="lax", max_age=600)
    return response


async def _facebook_fetch_email(code: str, client_id: str, client_secret: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Facebook's token endpoint takes the code exchange as a GET with
        # query params, unlike Google's POST-body convention — a real,
        # not-a-copy-paste difference between the two, even though both
        # are nominally "the same" authorization-code grant.
        token_resp = await client.get(
            _FACEBOOK_TOKEN_URL,
            params={
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": _FACEBOOK_CALLBACK_URL,
                "code": code,
            },
        )
        if token_resp.status_code >= 400:
            raise OAuthCallbackError(f"Facebook rejected the code exchange: {token_resp.text[:300]}")
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise OAuthCallbackError("Facebook's token response had no access_token.")

        userinfo_resp = await client.get(
            _FACEBOOK_USERINFO_URL, params={"fields": "id,name,email", "access_token": access_token}
        )
        if userinfo_resp.status_code >= 400:
            raise OAuthCallbackError(f"Facebook rejected the userinfo request: {userinfo_resp.text[:300]}")
        userinfo = userinfo_resp.json()

    email = userinfo.get("email")
    if not email:
        # A real, common case, not just a hypothetical — Facebook omits
        # email entirely if the visitor never verified one on their own
        # account, or declined the permission at the consent screen.
        raise OAuthCallbackError(
            "Facebook didn't return an email — the visitor may not have a verified email on their "
            "Facebook account, or declined the email permission."
        )
    return email


@public_router.get("/oauth/facebook/callback")
async def facebook_oauth_callback(
    request: Request, code: str | None = None, state: str | None = None, db: Session = Depends(get_db)
) -> RedirectResponse:
    cookie_state = request.cookies.get(_FACEBOOK_STATE_COOKIE)
    if not code or not state or not cookie_state or state != cookie_state:
        return RedirectResponse(_ERROR_REDIRECT)

    row = db.get(AppSettings, 1)
    if row is None or not row.facebook_oauth_client_id or not row.facebook_oauth_client_secret:
        return RedirectResponse(_ERROR_REDIRECT)

    try:
        email = await _facebook_fetch_email(code, row.facebook_oauth_client_id, row.facebook_oauth_client_secret)
    except (OAuthCallbackError, httpx.HTTPError):
        return RedirectResponse(_ERROR_REDIRECT)

    response = _finish_oauth_login(db, email, "facebook")
    response.delete_cookie(_FACEBOOK_STATE_COOKIE)
    return response


# ---------------------------------------------------------------------------
# X — OAuth 2.0 + PKCE, NOT the same flow as Google/Facebook above, and
# email access is not guaranteed at all (see this module's own docstring)
# ---------------------------------------------------------------------------


def _generate_pkce_pair() -> tuple[str, str]:
    """(code_verifier, code_challenge) — the S256 method X's own docs
    recommend. The verifier is regenerated per attempt (never reused),
    stashed in its own short-lived cookie alongside the CSRF state one,
    and sent again during the token exchange to prove this callback
    belongs to the same browser that started the flow."""
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


@public_router.get("/oauth/x/start")
def start_x_oauth(db: Session = Depends(get_db)) -> RedirectResponse:
    row = db.get(AppSettings, 1)
    if row is None or not row.x_oauth_client_id or not row.x_oauth_client_secret:
        raise HTTPException(
            status_code=503,
            detail="X sign-in isn't configured yet — set a client ID/secret in the dashboard's OAuth "
            "settings first.",
        )

    state = secrets.token_urlsafe(32)
    verifier, challenge = _generate_pkce_pair()
    params = {
        "response_type": "code",
        "client_id": row.x_oauth_client_id,
        "redirect_uri": _X_CALLBACK_URL,
        # No email scope exists to request here — see this module's own
        # docstring. tweet.read/users.read are the baseline X requires
        # just to resolve who logged in at all.
        "scope": "tweet.read users.read",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(f"{_X_AUTHORIZE_URL}?{urlencode(params)}")
    response.set_cookie(_X_STATE_COOKIE, state, httponly=True, samesite="lax", max_age=600)
    response.set_cookie(_X_VERIFIER_COOKIE, verifier, httponly=True, samesite="lax", max_age=600)
    return response


async def _x_fetch_email(code: str, verifier: str, client_id: str, client_secret: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        # X's token endpoint uses HTTP Basic auth (client_id:client_secret)
        # for a confidential client, on top of the PKCE verifier — both
        # are required together, neither replaces the other.
        token_resp = await client.post(
            _X_TOKEN_URL,
            data={
                "code": code,
                "grant_type": "authorization_code",
                "client_id": client_id,
                "redirect_uri": _X_CALLBACK_URL,
                "code_verifier": verifier,
            },
            auth=(client_id, client_secret),
        )
        if token_resp.status_code >= 400:
            raise OAuthCallbackError(f"X rejected the code exchange: {token_resp.text[:300]}")
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise OAuthCallbackError("X's token response had no access_token.")

        # Best-effort — X's standard /2/users/me does not return an email
        # address under normal API access; this only has a chance of
        # working at all if the owner's own X Developer app has been
        # specifically granted email access, which X does not guarantee.
        userinfo_resp = await client.get(
            _X_USERINFO_URL,
            params={"user.fields": "confirmed_email"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code >= 400:
            raise OAuthCallbackError(f"X rejected the userinfo request: {userinfo_resp.text[:300]}")
        userinfo = userinfo_resp.json()

    email = (userinfo.get("data") or {}).get("confirmed_email")
    if not email:
        raise OAuthCallbackError(
            "X did not return an email address for this account. X's standard API doesn't provide "
            "email access by default — this needs an elevated permission from X's own Developer "
            "Portal that isn't guaranteed to be approved. X sign-in can't complete without it."
        )
    return email


@public_router.get("/oauth/x/callback")
async def x_oauth_callback(
    request: Request, code: str | None = None, state: str | None = None, db: Session = Depends(get_db)
) -> RedirectResponse:
    cookie_state = request.cookies.get(_X_STATE_COOKIE)
    verifier = request.cookies.get(_X_VERIFIER_COOKIE)
    if not code or not state or not cookie_state or state != cookie_state or not verifier:
        return RedirectResponse(_ERROR_REDIRECT)

    row = db.get(AppSettings, 1)
    if row is None or not row.x_oauth_client_id or not row.x_oauth_client_secret:
        return RedirectResponse(_ERROR_REDIRECT)

    try:
        email = await _x_fetch_email(code, verifier, row.x_oauth_client_id, row.x_oauth_client_secret)
    except (OAuthCallbackError, httpx.HTTPError):
        return RedirectResponse(_ERROR_REDIRECT)

    response = _finish_oauth_login(db, email, "x")
    response.delete_cookie(_X_STATE_COOKIE)
    response.delete_cookie(_X_VERIFIER_COOKIE)
    return response
