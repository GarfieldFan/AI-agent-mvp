"""Page storage: save/list/restore generated pages (admin/owner), and a
public read endpoint the actual site fetches from at render time.

Every save creates a NEW `PageVersion` rather than overwriting — "restore"
works by copying an old version's content into a new version on top, so
history is never destroyed and a bad generation is always undoable. See
models.py's module docstring for the same note on the DB side.

Two routers, deliberately not one: `admin_router` (save/list/restore) is
gated by the same RBAC dependency as backend/apis/agent.py — a plain
`user` can never reach these. `public_router` (read the current version to
actually render the site) has no such gate; anyone visiting the site needs
to be able to fetch page content.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from models import Page, PageVersion

admin_router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()


class SaveVersionRequest(BaseModel):
    # Same shape as GenerateLandingPageResponse / the frontend's
    # GeneratedPage — {"sections": [...], "accent_color": "..."}. Kept as
    # a plain dict rather than re-importing agent.py's Pydantic models:
    # this endpoint stores whatever content shape the frontend sends
    # as-is, it doesn't need to re-validate the page-section schema
    # (that already happened once, when the content was generated).
    content: dict
    note: str | None = None


class PageVersionSummary(BaseModel):
    id: int
    created_at: datetime
    note: str | None


class SaveVersionResponse(BaseModel):
    slug: str
    version: PageVersionSummary


class PageSummary(BaseModel):
    slug: str
    created_at: datetime
    version_count: int
    latest_version_at: datetime | None


def _get_or_create_page(db: Session, slug: str) -> Page:
    page = db.scalar(select(Page).where(Page.slug == slug))
    if page is None:
        page = Page(slug=slug)
        db.add(page)
        db.flush()  # assigns page.id without committing yet
    return page


def _get_page_or_404(db: Session, slug: str) -> Page:
    page = db.scalar(select(Page).where(Page.slug == slug))
    if page is None:
        raise HTTPException(status_code=404, detail=f"No page with slug {slug!r}")
    return page


@admin_router.post("/agent/pages/{slug}/versions", response_model=SaveVersionResponse)
def save_version(slug: str, req: SaveVersionRequest, db: Session = Depends(get_db)) -> SaveVersionResponse:
    """Save `content` as a new version of `slug`, creating the page if it doesn't exist yet."""
    page = _get_or_create_page(db, slug)
    version = PageVersion(page_id=page.id, content=req.content, note=req.note)
    db.add(version)
    db.commit()
    db.refresh(version)
    return SaveVersionResponse(
        slug=slug,
        version=PageVersionSummary(id=version.id, created_at=version.created_at, note=version.note),
    )


@admin_router.get("/agent/pages", response_model=list[PageSummary])
def list_pages(db: Session = Depends(get_db)) -> list[PageSummary]:
    """List every page that has at least one saved version — powers the
    "save to an existing page" picker in the frontend's generator panel."""
    pages = db.scalars(select(Page).order_by(Page.created_at.desc())).all()
    summaries = []
    for page in pages:
        versions = page.versions  # already ordered newest-first (see models.py)
        summaries.append(
            PageSummary(
                slug=page.slug,
                created_at=page.created_at,
                version_count=len(versions),
                latest_version_at=versions[0].created_at if versions else None,
            )
        )
    return summaries


class PageVersionListResponse(BaseModel):
    items: list[PageVersionSummary]
    total: int


@admin_router.get("/agent/pages/{slug}/versions", response_model=PageVersionListResponse)
def list_versions(
    slug: str, limit: int = 20, offset: int = 0, db: Session = Depends(get_db)
) -> PageVersionListResponse:
    """Paginated (2026-08-20, was `page.versions` loaded wholesale via
    the ORM relationship — real UI pain for a page with a long edit
    history, see the root AGENTS.md). Queries `PageVersion` directly
    instead of the relationship so `limit`/`offset` actually apply at
    the SQL level."""
    page = _get_page_or_404(db, slug)
    total = db.execute(
        select(func.count()).select_from(PageVersion).where(PageVersion.page_id == page.id)
    ).scalar_one()
    versions = (
        db.execute(
            select(PageVersion)
            .where(PageVersion.page_id == page.id)
            .order_by(PageVersion.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )
    return PageVersionListResponse(
        items=[PageVersionSummary(id=v.id, created_at=v.created_at, note=v.note) for v in versions],
        total=total,
    )


@admin_router.post("/agent/pages/{slug}/versions/{version_id}/restore", response_model=SaveVersionResponse)
def restore_version(slug: str, version_id: int, db: Session = Depends(get_db)) -> SaveVersionResponse:
    """Copies an old version's content into a brand-new version on top —
    never deletes or rewinds history, so restoring is itself undoable."""
    page = _get_page_or_404(db, slug)
    old_version = db.scalar(
        select(PageVersion).where(PageVersion.id == version_id, PageVersion.page_id == page.id)
    )
    if old_version is None:
        raise HTTPException(status_code=404, detail=f"No version {version_id} for page {slug!r}")

    new_version = PageVersion(
        page_id=page.id,
        content=old_version.content,
        note=f"Restored from version {version_id}",
    )
    db.add(new_version)
    db.commit()
    db.refresh(new_version)
    return SaveVersionResponse(
        slug=slug,
        version=PageVersionSummary(id=new_version.id, created_at=new_version.created_at, note=new_version.note),
    )


@admin_router.delete("/agent/pages/{slug}", status_code=204)
def delete_page(slug: str, db: Session = Depends(get_db)) -> None:
    """Deletes a page and every one of its versions — unlike everything
    else in this router (a save is always a new version, restore only
    ever adds one on top), this IS destructive and has no undo. Cascades
    to page_versions via the FK's ondelete=CASCADE (see models.py)."""
    page = _get_page_or_404(db, slug)
    db.delete(page)
    db.commit()


class PublicPageSummary(BaseModel):
    slug: str
    updated_at: datetime


@public_router.get("/pages", response_model=list[PublicPageSummary])
def list_public_pages(db: Session = Depends(get_db)) -> list[PublicPageSummary]:
    """Public, no-auth — just slugs + last-updated, no content (unlike
    admin_router's list_pages above). Added 2026-08-21 specifically for
    frontend/src/app/sitemap.ts, which needs to enumerate every published
    page without an admin token — a page's own slug isn't sensitive, the
    whole point of publishing one is being publicly reachable."""
    pages = db.scalars(select(Page).order_by(Page.created_at.desc())).all()
    return [
        PublicPageSummary(slug=page.slug, updated_at=page.versions[0].created_at)
        for page in pages
        if page.versions
    ]


@public_router.get("/pages/{slug}")
def get_current_page(slug: str, db: Session = Depends(get_db)) -> dict:
    """Public: the current (latest) content for `slug`, or 404 if nothing's
    been saved for it yet. The frontend falls back to its own hand-authored
    default template on a 404 — see frontend/src/config/default-theme.ts."""
    page = db.scalar(select(Page).where(Page.slug == slug))
    if page is None or not page.versions:
        raise HTTPException(status_code=404, detail=f"No content saved for page {slug!r}")
    return page.versions[0].content
