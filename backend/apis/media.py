"""CTE media library — list/upload images for the click-to-edit image
field editor (frontend/src/components/theme/cte/). Admin/owner only, same
gating as apis/documents.py.

Two independent image sources, deliberately not merged into one
directory: `COMFYUI_OUTPUT_DIR` (apis/api.py — wherever the image-gen
backend writes its own output; "generate" in the CTE image editor lands
here automatically, no extra save step) and `MEDIA_UPLOAD_DIR` (this
file — CTE's own "upload a file" path). Kept separate on purpose: the
image-gen backend is expected to change/move over time (see the root
AGENTS.md's CTE section — the same "swappable, not hardcoded" principle
already applied to the chat/embedding AI providers, extended here to
image generation), so user uploads shouldn't be tied to wherever that
backend happens to write files today. The media library (GET /agent/media)
just lists both and merges them for browsing.
"""

import base64
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from apis.api import COMFYUI_OUTPUT_DIR, COMFYUI_PUBLIC_URL
from apis.deps import Role, require_role

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Lives under the existing ./backend bind mount (see docker-compose.yml) —
# no separate named volume needed, and backend/.dockerignore already
# excludes `storage` from image builds (same pattern DOCUMENT_STORAGE_DIR
# uses). Served back out via main.py's StaticFiles mount at /api/media/uploads.
MEDIA_UPLOAD_DIR = Path(os.environ.get("MEDIA_UPLOAD_DIR", "/app/storage/media"))

BACKEND_PUBLIC_URL = os.environ.get("BACKEND_PUBLIC_URL", "http://localhost:8000")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


class MediaItem(BaseModel):
    filename: str
    url: str
    source: str  # "comfyui" | "upload"
    created_at: datetime


def _list_dir(directory: Path, source: str, url_for: Callable[[str], str]) -> list[MediaItem]:
    if not directory.is_dir():
        return []
    items = []
    for entry in directory.iterdir():
        if not entry.is_file() or entry.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        items.append(
            MediaItem(
                filename=entry.name,
                url=url_for(entry.name),
                source=source,
                created_at=datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc),
            )
        )
    return items


@router.get("/agent/media", response_model=list[MediaItem])
def list_media() -> list[MediaItem]:
    """Merged, newest-first listing of both image sources — see this
    module's docstring for why they're two directories, not one."""
    comfy_items = _list_dir(
        COMFYUI_OUTPUT_DIR,
        "comfyui",
        lambda name: f"{COMFYUI_PUBLIC_URL}/view?filename={name}&subfolder=&type=output",
    )
    upload_items = _list_dir(
        MEDIA_UPLOAD_DIR,
        "upload",
        lambda name: f"{BACKEND_PUBLIC_URL}/api/media/uploads/{name}",
    )
    return sorted(comfy_items + upload_items, key=lambda item: item.created_at, reverse=True)


class UploadMediaRequest(BaseModel):
    filename: str
    content_base64: str


class UploadMediaResponse(BaseModel):
    filename: str
    url: str


def save_media_bytes(raw_bytes: bytes, prefix: str, suffix: str = ".png") -> str:
    """Persists raw image bytes under MEDIA_UPLOAD_DIR and returns a
    stable, servable URL — shared by upload_media below and
    providers/openai.py's/providers/gemini.py's image providers, which
    need this for the same reason CTE's own uploads do: a generated
    image needs to keep existing after the request completes, and this
    project has no reason to trust a cloud vendor's own (often
    short-lived) hosted URL for that."""
    MEDIA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{prefix}_{uuid.uuid4().hex}{suffix}"
    (MEDIA_UPLOAD_DIR / stored_name).write_bytes(raw_bytes)
    return f"{BACKEND_PUBLIC_URL}/api/media/uploads/{stored_name}"


def resolve_media_local_path(url: str) -> Path | None:
    """Maps a MEDIA_UPLOAD_DIR-served URL back to the local file it came
    from — mirrors chat_attachments.py's resolve_local_path (same
    paranoid posture: exact prefix match, exactly one path segment, a
    resolve()-based containment check before ever touching disk), for
    the one case a client-supplied media URL turns into an actual
    filesystem read: owner-agent's generate_landing_page_from_url tool,
    which needs real bytes to send to the vision model. Deliberately
    doesn't resolve COMFYUI_OUTPUT_DIR URLs (ComfyUI-generated images
    aren't design mockups a landing page would ever be generated from —
    only this module's own uploads are). Returns None (never raises) for
    anything that doesn't check out."""
    prefix = f"{BACKEND_PUBLIC_URL}/api/media/uploads/"
    if not url.startswith(prefix):
        return None

    name = url[len(prefix) :]
    if not name or "/" in name or name in (".", ".."):
        return None

    candidate = (MEDIA_UPLOAD_DIR / name).resolve()
    try:
        candidate.relative_to(MEDIA_UPLOAD_DIR.resolve())
    except ValueError:
        return None

    return candidate if candidate.is_file() else None


@router.post("/agent/media/upload", response_model=UploadMediaResponse)
def upload_media(req: UploadMediaRequest) -> UploadMediaResponse:
    content_b64 = req.content_base64
    # Tolerate a data-URI prefix, same as apis/documents.py and apis/api.py.
    if content_b64.strip().lower().startswith("data:") and "," in content_b64:
        content_b64 = content_b64.split(",", 1)[1]

    try:
        raw_bytes = base64.b64decode(content_b64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {e}")

    suffix = Path(req.filename).suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        suffix = ".png"

    url = save_media_bytes(raw_bytes, prefix="upload", suffix=suffix)
    return UploadMediaResponse(filename=url.rsplit("/", 1)[-1], url=url)
