"""Storage + AI analysis for public-chat file attachments — shared by
apis/chat.py (upload endpoint, automatic per-turn lead-info extraction)
and apis/agent.py (owner-triggered deep scan, POST
/agent/crm/entries/{id}/scan, also reachable as owner-agent's
scan_crm_attachment tool). Kept as one module, not duplicated in each
caller, so the storage layout, the safe-path resolution, and the vision/
document-analysis plumbing can't drift between the two call sites.

Storage layout: `CHAT_UPLOAD_DIR/<conversation_id>/<uuid4><ext>` — one
folder per conversation (a signed-in visitor's account email, or an
anonymous visitor's client-generated session_id, see
apis/chat.py's `_conversation_id`), not a single flat directory. Groups a
visitor's files together for a human reviewing them, at the cost of a
messier directory tree than one uuid-per-file — worth it once a visitor
might attach more than one file over a conversation. The uuid4 filename
inside that folder is unchanged from the earlier flat layout: still never
the client-supplied name (path-traversal/collision safety), still the
identifier POST /chat/upload returns.

Analysis: an image goes to the owner-selected vision model, via the same
`ChatProvider.chat()` call (any provider — see resolve_vision_provider,
apis/model_settings.py) apis/agent.py's generate_landing_page uses; a
PDF's extracted text (backend/ingest.py's
parse_document, the same parser RAG ingestion uses) goes to the
owner-selected plain chat model instead — no vision model can read a PDF
directly, and this backend has no PDF-to-image rendering step. Two
different callers, two different failure postures: `extract_lead_info`
(automatic, runs on every chat turn with an attachment) swallows every
failure since it's a nice-to-have that must never block or slow-fail the
reply the visitor is waiting on; `scan_with_instructions` (owner-
triggered, explicit request) raises, since a silent no-op there would
just look like the feature doing nothing.
"""

import base64
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from apis.media import BACKEND_PUBLIC_URL
from apis.model_settings import resolve_chat_provider, resolve_vision_provider
from ingest import parse_document
from llm_json import parse_lenient_json
from models import ChatMessage, CrmEntry
from providers.base import ProviderNotConfigured

# Lives alongside apis/media.py's MEDIA_UPLOAD_DIR and
# apis/documents.py's STORAGE_DIR under the same bind-mounted
# ./backend/storage — see .gitignore and backend/.dockerignore, both
# already scoped to the whole `storage/` tree, not per-subdirectory.
CHAT_UPLOAD_DIR = Path(os.environ.get("CHAT_UPLOAD_DIR", "/app/storage/chat_uploads"))

# Images (a damage photo, a site photo) + PDF (a spec sheet, a prior
# estimate) — deliberately no .svg/.html (script-capable if ever opened
# directly) and no office formats (no parser wired up for those here,
# unlike apis/documents.py's RAG ingest which is admin-gated anyway).
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
CHAT_UPLOAD_EXTENSIONS = IMAGE_EXTENSIONS | {".pdf"}
_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

# A public, unauthenticated endpoint gets a hard cap regardless of what
# the rest of this app allows elsewhere — 8MB comfortably covers a phone
# photo or a short PDF without leaving the door open to trivial disk-fill
# abuse from an anonymous caller.
CHAT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024

_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9@._-]")


def safe_conversation_id(raw: str) -> str:
    """Turns a caller-supplied identity (an account email or a client-
    generated session_id — see apis/chat.py) into a safe folder name: only
    a small allowlist of characters survives, and an all-stripped or empty
    result falls back to "anonymous" rather than an empty/traversal-prone
    path segment."""
    cleaned = _UNSAFE_ID_CHARS.sub("_", raw).strip("._")
    return cleaned[:120] or "anonymous"


def save_upload(conversation_id: str, filename: str, raw_bytes: bytes) -> str:
    """Validates extension, writes the file under this conversation's own
    folder with a random uuid4 name, returns the public URL. Raises
    ValueError for an unsupported extension — callers turn that into a
    400, same as the old inline validation this replaces."""
    suffix = Path(filename).suffix.lower()
    if suffix not in CHAT_UPLOAD_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type {suffix!r} — allowed: {', '.join(sorted(CHAT_UPLOAD_EXTENSIONS))}."
        )

    conv_dir = CHAT_UPLOAD_DIR / safe_conversation_id(conversation_id)
    conv_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    (conv_dir / stored_name).write_bytes(raw_bytes)

    return f"{BACKEND_PUBLIC_URL}/api/chat/uploads/{conv_dir.name}/{stored_name}"


def delete_file(file_path: Path) -> None:
    """Removes one uploaded file and, if that was the last file in its
    conversation folder, the now-empty folder too — keeps
    `CHAT_UPLOAD_DIR` from accumulating empty directories as conversations
    get cleaned up over time. Best-effort: a failed `rmdir` (folder not
    actually empty, e.g. a race with a concurrent upload) is silently
    ignored, only the file removal itself is load-bearing."""
    file_path.unlink(missing_ok=True)
    try:
        file_path.parent.rmdir()
    except OSError:
        pass  # not empty (or already gone) — fine, nothing else to do


def resolve_local_path(url: str) -> Path | None:
    """Maps a POST /chat/upload URL back to the local file it came from —
    the one place a client-supplied string (ChatRequest.attachment_url is
    never re-verified against what POST /chat/upload actually returned;
    CrmEntryRequest.attachment_url is admin-supplied but still untrusted
    input) turns into an actual filesystem path, so this is deliberately
    paranoid: exact prefix match, exactly two path segments (conversation
    folder + filename, no nesting), and a resolve()-based containment
    check before ever touching disk. Returns None (never raises) for
    anything that doesn't check out, including a URL that just doesn't
    point at a file that exists — every caller treats that as "nothing to
    analyze," not an error."""
    prefix = f"{BACKEND_PUBLIC_URL}/api/chat/uploads/"
    if not url.startswith(prefix):
        return None

    parts = url[len(prefix) :].split("/")
    if len(parts) != 2 or any(not p or p in (".", "..") for p in parts):
        return None

    candidate = (CHAT_UPLOAD_DIR / parts[0] / parts[1]).resolve()
    try:
        candidate.relative_to(CHAT_UPLOAD_DIR.resolve())
    except ValueError:
        return None

    return candidate if candidate.is_file() else None


def _content_type_for_suffix(suffix: str) -> str:
    return "application/pdf" if suffix == ".pdf" else "application/octet-stream"


async def _run_model_on_file(
    db: Session, file_path: Path, system_prompt: str, user_instruction: str, *, json_mode: bool = False
) -> str:
    """The shared vision-or-document call both public functions below
    build on. Raises ProviderNotConfigured/httpx.HTTPError/ValueError on
    failure — callers decide how to degrade."""
    suffix = file_path.suffix.lower()
    raw_bytes = file_path.read_bytes()

    if suffix in IMAGE_EXTENSIONS:
        vision = resolve_vision_provider(db)
        image_b64 = base64.b64encode(raw_bytes).decode()
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_instruction},
                    {"type": "image_url", "image_url": {"url": f"data:{_IMAGE_MIME[suffix]};base64,{image_b64}"}},
                ],
            },
        ]
        return await vision.chat(messages, system=system_prompt, json_mode=json_mode)

    # Not an image (only .pdf reaches here — CHAT_UPLOAD_EXTENSIONS has no
    # other non-image members) — extract text the same way RAG ingestion
    # does and hand it to the plain (non-vision) chat provider instead.
    text = parse_document(raw_bytes, _content_type_for_suffix(suffix), file_path.name)
    provider = resolve_chat_provider(db)
    prompt = f"Document content:\n{text[:12000]}\n\n{user_instruction}"
    return await provider.chat([{"role": "user", "content": prompt}], system=system_prompt, json_mode=json_mode)


_LEAD_INFO_SYSTEM_PROMPT = (
    "You read a file (image or document) a website visitor attached to their chat conversation and "
    "extract basic contact/intent information from it, if actually visible or legible. Respond with ONLY "
    "a single JSON object, no markdown fences, no commentary before or after it:\n"
    '{"name": "<full name, or null>", "phone": "<phone number, or null>", "email": "<email address, or '
    'null>", "intent_summary": "<one short sentence on what this file appears to be for — e.g. an '
    'insurance claim photo, a signed estimate, an ID for an appointment — or null if unclear>"}\n\n'
    "Never invent a value that isn't actually present/legible in the file — use null rather than guess."
)


async def extract_lead_info(db: Session, file_path: Path) -> dict | None:
    """Best-effort automatic extraction — see this module's docstring for
    why this swallows every failure and returns None rather than raising.
    Called from apis/chat.py's chat() on every turn that carries a fresh
    attachment."""
    try:
        raw = await _run_model_on_file(
            db,
            file_path,
            _LEAD_INFO_SYSTEM_PROMPT,
            "Extract the fields described in your instructions from this file.",
            json_mode=True,
        )
        parsed = parse_lenient_json(raw)
    except (httpx.HTTPError, ProviderNotConfigured, ValueError, OSError):
        return None

    info = {k: parsed.get(k) for k in ("name", "phone", "email", "intent_summary")}
    return info if any(info.values()) else None


_SCAN_SYSTEM_PROMPT = (
    "You analyze a file (image or document) attached to a captured lead and answer the site owner's "
    "question about it as accurately as possible, based only on what's actually visible or legible. Say "
    "so plainly if the requested information isn't present rather than guessing."
)


async def scan_with_instructions(db: Session, file_path: Path, instructions: str) -> str:
    """Owner-triggered deep scan — apis/agent.py's POST
    /agent/crm/entries/{id}/scan, also reachable as owner-agent's
    scan_crm_attachment tool. Freeform instructions, freeform text answer,
    no JSON schema — unlike extract_lead_info above, this raises on
    failure rather than swallowing it; a silent no-op here would just look
    like the feature doing nothing to the admin/owner who explicitly asked
    for it."""
    return await _run_model_on_file(db, file_path, _SCAN_SYSTEM_PROMPT, instructions, json_mode=False)


# Matches apis/chat.py's `_attachment_note` marker exactly — the one place
# an attachment URL survives in ChatMessage.content once persisted.
_ATTACHMENT_MARKER_RE = re.compile(r"\[Attached file: (\S+)\]")

# A visitor uploads, then (normally, within seconds) sends the chat turn
# that references it — but nothing enforces that they actually do. This
# is how long an unreferenced file gets to "prove" it's actually attached
# to something before cleanup_orphaned_uploads is willing to touch it, so
# a slow typer mid-conversation never has their in-flight upload deleted
# out from under them.
DEFAULT_ORPHAN_AGE_HOURS = 24


def _referenced_upload_urls(db: Session) -> set[str]:
    """Every attachment URL this app still has a reason to keep — either a
    captured lead points at it (`CrmEntry.attachment_url`) or it's inlined
    in a persisted chat transcript (`ChatMessage.content`'s `[Attached
    file: ...]` marker, see apis/chat.py's `_attachment_note`). Two lookups
    total, not one per file, so scanning a whole upload tree stays cheap
    even with many files."""
    urls = {
        url for (url,) in db.query(CrmEntry.attachment_url).filter(CrmEntry.attachment_url.isnot(None))
    }
    for (content,) in db.query(ChatMessage.content).filter(ChatMessage.content.like("%[Attached file:%")):
        urls.update(_ATTACHMENT_MARKER_RE.findall(content))
    return urls


def cleanup_orphaned_uploads(
    db: Session, *, older_than_hours: int = DEFAULT_ORPHAN_AGE_HOURS, dry_run: bool = False
) -> dict:
    """Walks `CHAT_UPLOAD_DIR` and removes every file that's (a) not
    referenced by any `CrmEntry` or `ChatMessage` and (b) older than
    `older_than_hours` — a visitor who uploaded a photo and then abandoned
    the conversation before it ever became a lead or got logged leaves
    exactly this kind of orphan behind, with nothing else in this app ever
    cleaning it up on its own. `dry_run=True` reports what *would* be
    deleted without touching disk, for a "let me see first" pass — real
    deletion always goes through `delete_file` so an emptied-out
    conversation folder gets removed too, not just its last file.

    Reachable via `POST /agent/storage/cleanup-uploads` (apis/agent.py,
    admin/owner) or the owner-agent's `cleanup_chat_uploads` tool."""
    referenced = _referenced_upload_urls(db)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)

    scanned = 0
    freed_bytes = 0
    deleted_files: list[str] = []

    if CHAT_UPLOAD_DIR.is_dir():
        for conv_dir in CHAT_UPLOAD_DIR.iterdir():
            if not conv_dir.is_dir():
                continue
            for file_path in conv_dir.iterdir():
                if not file_path.is_file():
                    continue
                scanned += 1

                url = f"{BACKEND_PUBLIC_URL}/api/chat/uploads/{conv_dir.name}/{file_path.name}"
                if url in referenced:
                    continue

                mtime = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
                if mtime > cutoff:
                    continue

                freed_bytes += file_path.stat().st_size
                deleted_files.append(f"{conv_dir.name}/{file_path.name}")
                if not dry_run:
                    delete_file(file_path)

    return {
        "scanned": scanned,
        "orphaned": len(deleted_files),
        # freed_bytes/deleted_files describe what's orphaned either way (a
        # dry run should still say what it WOULD do) — only `deleted`
        # itself reflects whether anything was actually removed.
        "deleted": 0 if dry_run else len(deleted_files),
        "freed_bytes": freed_bytes,
        "deleted_files": deleted_files,
    }
