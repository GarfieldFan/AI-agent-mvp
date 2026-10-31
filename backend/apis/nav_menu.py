"""Owner-editable public navigation menu (2026-10-31) — the WordPress
"Menus" equivalent. Managed from /editor's Menu tab, read by the
frontend's SiteHeader/SiteFooter on every request.

Same "one concern, one file" + admin_router/public_router split as
`apis/maps.py`/`apis/business_profile.py`. Writes are admin+owner, same
bar as saving a page itself (`apis/pages.py`) — a menu is just as
reversible as page content.

`AppSettings.nav_menu` null means "never configured" and the public read
returns `items: null`, so the frontend keeps its own built-in default
rather than this file hardcoding a second copy of it. Admin links
(Page Editor/Dashboard) are never part of this menu."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import AppSettings, Page, get_or_create_app_settings

admin_router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()

MAX_MENU_ITEMS = 20


class NavMenuItem(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    href: str = Field(min_length=1, max_length=500)

    @field_validator("label")
    @classmethod
    def _strip_label(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Label can't be blank.")
        return value

    @field_validator("href")
    @classmethod
    def _check_href(cls, value: str) -> str:
        # Rendered as a real <a href> on every public page, so only allow
        # shapes that can't run script: a site-relative path, an in-page
        # anchor (e.g. "#chat" opens the chat bubble), or an absolute
        # http(s)/mailto/tel URL. Never "javascript:"/"data:" etc.
        value = value.strip()
        lowered = value.lower()
        if value.startswith("//"):
            raise ValueError("Use a full https:// URL for external links.")
        if not (
            value.startswith("/")
            or value.startswith("#")
            or lowered.startswith(("http://", "https://", "mailto:", "tel:"))
        ):
            raise ValueError("Link must start with /, #, http(s)://, mailto: or tel:.")
        return value


class NavMenu(BaseModel):
    # null = never configured, frontend uses its built-in default.
    items: list[NavMenuItem] | None


class UpdateNavMenuRequest(BaseModel):
    # null resets to the built-in default; [] means "no public links".
    items: list[NavMenuItem] | None = Field(default=None, max_length=MAX_MENU_ITEMS)


def _to_menu(row: AppSettings | None) -> NavMenu:
    if row is None or row.nav_menu is None:
        return NavMenu(items=None)
    # Tolerate a malformed stored entry rather than 500ing every page view.
    items: list[NavMenuItem] = []
    for raw in row.nav_menu:
        try:
            items.append(NavMenuItem.model_validate(raw))
        except ValueError:
            continue
    return NavMenu(items=items)


@admin_router.get("/nav-menu", response_model=NavMenu)
def get_nav_menu(db: Session = Depends(get_db)) -> NavMenu:
    return _to_menu(db.get(AppSettings, 1))


@admin_router.put("/nav-menu", response_model=NavMenu)
def update_nav_menu(req: UpdateNavMenuRequest, db: Session = Depends(get_db)) -> NavMenu:
    row = get_or_create_app_settings(db)
    row.nav_menu = None if req.items is None else [item.model_dump() for item in req.items]
    db.commit()
    db.refresh(row)
    return _to_menu(row)


class SavedPageLink(BaseModel):
    slug: str
    href: str


class NavMenuOverview(BaseModel):
    """Everything owner-agent's `get_site_menu` tool needs to edit the menu
    in one call: what's saved, what visitors actually see right now, and
    which pages exist to link to."""

    items: list[NavMenuItem] | None
    is_default: bool
    effective_items: list[NavMenuItem]
    saved_pages: list[SavedPageLink]


def _href_for_slug(slug: str) -> str:
    # Same slug → route convention the frontend follows (app/page.tsx,
    # app/about/page.tsx, app/p/[slug]).
    if slug == "home":
        return "/"
    if slug == "about":
        return "/about"
    return f"/p/{slug}"


@admin_router.get("/nav-menu/overview", response_model=NavMenuOverview)
def get_nav_menu_overview(db: Session = Depends(get_db)) -> NavMenuOverview:
    menu = _to_menu(db.get(AppSettings, 1))
    slugs = list(db.scalars(select(Page.slug).order_by(Page.slug)))
    if menu.items is not None:
        effective = menu.items
    else:
        # Mirrors the frontend's built-in default (config/nav.ts's
        # buildPublicNav): Home, plus About once an "about" page exists.
        # Kept in sync by hand — it's two lines on each side.
        effective = [NavMenuItem(label="Home", href="/")]
        if "about" in slugs:
            effective.append(NavMenuItem(label="About", href="/about"))
    return NavMenuOverview(
        items=menu.items,
        is_default=menu.items is None,
        effective_items=effective,
        saved_pages=[SavedPageLink(slug=slug, href=_href_for_slug(slug)) for slug in slugs],
    )


@public_router.get("/nav-menu", response_model=NavMenu)
def get_public_nav_menu(db: Session = Depends(get_db)) -> NavMenu:
    return _to_menu(db.get(AppSettings, 1))
