"""Map embed provider abstraction (2026-08-21) — same "swappable, not
hardcoded" pattern as backend/payments.py and backend/notifications.py,
applied to a fourth capability domain: showing a business location.

Deliberately narrow. There's no "test provider does nothing" shape here
the way payment/email have — a map has no side effect to skip, only a URL
to build (or not build). `TestMapProvider` (the default, no configuration
needed) returns no embed at all; `MapBlock` (frontend) always has a plain
"open in Google Maps" link regardless, built from the caller's own query
text, not this provider — the redirect-only fallback the owner asked
about is unconditional, never gated on any provider being configured.
`GoogleMapsProvider` layers a real, live, in-page iframe on top of that
floor once a real API key exists.

Only the Google Maps Embed API is implemented (not a full
Google/Mapbox/OpenStreetMap matrix) — Google's Embed API needs nothing
but a key and a place/address query string, no client-side JS SDK, no
map-tile styling config; a second real provider can be added the same way
`providers/custom.py` was added for chat once there's a real second need,
not preemptively. Google's own Embed API key is DESIGNED to be used
client-side (it's meant to sit in an iframe `src` a browser loads
directly, restricted server-side via Google Cloud Console's HTTP-referrer
allowlist, not treated as a secret the way a Stripe secret key or a
Mailgun API key is) — but this module still never hands the raw key to
the browser: `build_embed_url()` runs server-side and returns the
already-assembled iframe `src`, keeping the key out of the frontend's own
code/state entirely, the same posture as every other credential in this
app even where it wasn't strictly required."""

from typing import Protocol
from urllib.parse import quote


class MapProvider(Protocol):
    def build_embed_url(self, query: str) -> str | None:
        """Returns a ready-to-use `<iframe src>` for the given place/
        address query, or None if this provider can't produce one (the
        default TestMapProvider, or a real provider missing its key)."""
        ...


class TestMapProvider:
    """The default — no embed. Costs nothing, needs no configuration, so
    every other route/page in this app keeps working with a plain
    redirect-only map link (see MapBlock's own fallback, built client-side
    from the query text, not from this provider)."""

    def build_embed_url(self, query: str) -> str | None:
        return None


class GoogleMapsProvider:
    """Google Maps Embed API (https://developers.google.com/maps/documentation/embed/embed-api)
    — a single templated iframe URL, no request made from this backend at
    all (Google's own iframe fetches the map tiles directly from the
    visitor's browser)."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    def build_embed_url(self, query: str) -> str | None:
        return f"https://www.google.com/maps/embed/v1/place?key={quote(self.api_key)}&q={quote(query)}"
