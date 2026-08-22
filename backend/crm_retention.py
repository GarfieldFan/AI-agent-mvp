"""Retention cleanup for abandoned, schema-linked `CrmEntry` rows
(2026-08-20) — the real gap flagged when the OTP-based cross-session
resume feature (`apis/crm_resume.py`) was built: without this, a
visitor's partially-filled structured intake (real PII — incident
details, phone, an attached photo) would sit in the database forever if
they never came back to finish it, since resuming never requires any
owner action at all. The user's own explicit split, confirmed directly:
an entry with real collected data gets a 7-day grace period (rolling,
from the underlying conversation's own last activity, not a fixed
from-creation deadline — a visitor spread out over several days
shouldn't get cut off arbitrarily) before purge; an entry with
essentially nothing collected yet gets only 24 hours — mirrors
`chat_attachments.cleanup_orphaned_uploads`'s own existing 24h precedent
for an analogous "abandoned, nothing real lost" case.

**Deliberately scoped to ONLY the PII-carrying `CrmEntry` row itself —
never `ChatSession`/`ChatMessage`.** Those persist for `ReportPanel`'s
own chat-volume reporting (session/message counts over time), which this
cleanup would otherwise silently corrupt if it started deleting session
rows too — a real, considered scope boundary, not an oversight. An entry
is only ever purged here if the OWNER has never engaged with it
(`status` still the default `"new"`) — anything already contacted/closed
is a real business record `CrmPanel`/`ReviewQueuePanel` depend on, never
touched by this.

No automatic scheduling — this project has no background job queue (see
`chat_attachments.py`'s own precedent for the identical constraint):
manually triggered only, via `POST /agent/crm/cleanup-stale-entries`
(dry_run supported) or owner-agent's `cleanup_stale_crm_entries` tool,
same posture as `cleanup_chat_uploads`."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import ChatSession, CrmEntry

STALE_EMPTY_HOURS = 24
STALE_PARTIAL_DAYS = 7


@dataclass
class CleanupResult:
    scanned: int = 0
    deleted: int = 0
    deleted_ids: list[int] = field(default_factory=list)


def cleanup_stale_crm_entries(db: Session, dry_run: bool = False) -> CleanupResult:
    """Scans every schema-linked, still-`"new"` `CrmEntry` and deletes
    the ones past their own retention window. `dry_run=True` previews
    without touching the database, same contract as
    `cleanup_orphaned_uploads`'s own `dry_run` param."""
    now = datetime.utcnow()
    candidates = (
        db.execute(select(CrmEntry).where(CrmEntry.intent_schema_id.isnot(None), CrmEntry.status == "new"))
        .scalars()
        .all()
    )

    result = CleanupResult(scanned=len(candidates))
    for entry in candidates:
        # Last real activity is the underlying conversation's own
        # last_seen_at when that session still exists; falls back to
        # this entry's own created_at if the session was already
        # removed some other way (chat_session_id is ON DELETE SET
        # NULL, see models.py's CrmEntry docstring).
        session = db.get(ChatSession, entry.chat_session_id) if entry.chat_session_id else None
        last_active = session.last_seen_at if session else entry.created_at
        has_real_data = bool(entry.collected_fields)
        threshold = timedelta(days=STALE_PARTIAL_DAYS) if has_real_data else timedelta(hours=STALE_EMPTY_HOURS)
        if now - last_active < threshold:
            continue
        result.deleted += 1
        result.deleted_ids.append(entry.id)
        if not dry_run:
            db.delete(entry)

    if not dry_run:
        db.commit()
    return result
