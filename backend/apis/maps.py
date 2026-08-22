"""Owner-facing map-provider configuration + the public embed-URL lookup
`MapBlock` (frontend) calls. Mirrors `apis/payments.py`/
`apis/notifications.py`'s pattern: one settings row, a write-only secret,
and a `resolve_*` helper other code calls to get a ready-to-use provider —
see `backend/maps.py`'s own docstring for the map-specific "why"."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from maps import GoogleMapsProvider, MapProvider, TestMapProvider
from models import AppSettings

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()


def resolve_map_provider(db: Session) -> tuple[str, MapProvider]:
    row = db.get(AppSettings, 1)
    name = (row.map_provider if row else None) or "test"
    if name == "google" and row and row.google_maps_api_key:
        return name, GoogleMapsProvider(row.google_maps_api_key)
    return "test", TestMapProvider()


class MapSettings(BaseModel):
    map_provider: str
    google_maps_api_key_set: bool


@admin_router.get("/map-settings", response_model=MapSettings)
def get_map_settings(db: Session = Depends(get_db)) -> MapSettings:
    row = db.get(AppSettings, 1)
    return MapSettings(
        map_provider=(row.map_provider if row else None) or "test",
        google_maps_api_key_set=bool(row and row.google_maps_api_key),
    )


class UpdateMapSettingsRequest(BaseModel):
    map_provider: str
    # None = leave the previously-saved key alone (matches
    # apis/payments.py's stripe_secret_key semantics) — only send this
    # when the owner actually typed a new one.
    google_maps_api_key: str | None = None


@admin_router.put("/map-settings", response_model=MapSettings)
def update_map_settings(req: UpdateMapSettingsRequest, db: Session = Depends(get_db)) -> MapSettings:
    if req.map_provider not in ("test", "google"):
        raise HTTPException(status_code=400, detail=f"{req.map_provider!r} isn't a supported map provider.")

    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    row.map_provider = req.map_provider
    if req.google_maps_api_key is not None:
        row.google_maps_api_key = req.google_maps_api_key or None

    db.commit()
    db.refresh(row)
    return MapSettings(
        map_provider=row.map_provider or "test",
        google_maps_api_key_set=bool(row.google_maps_api_key),
    )


class MapEmbedResponse(BaseModel):
    embed_url: str | None
    maps_url: str


@public_router.get("/map-embed", response_model=MapEmbedResponse)
def get_map_embed(query: str, db: Session = Depends(get_db)) -> MapEmbedResponse:
    """Public, no-auth (same tier as GET /api/product-fields) — a place/
    address query string isn't sensitive. `maps_url` (a plain
    google.com/maps search link) is always present regardless of
    configuration, the redirect-only floor MapBlock falls back to with
    zero setup; `embed_url` is only set once a real provider is
    configured, for a live in-page iframe on top of that floor."""
    _name, provider = resolve_map_provider(db)
    return MapEmbedResponse(
        embed_url=provider.build_embed_url(query),
        maps_url=f"https://www.google.com/maps/search/?api=1&query={quote(query)}",
    )
