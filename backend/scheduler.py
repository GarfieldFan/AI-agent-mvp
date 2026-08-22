"""Generic recurring-task engine (2026-08-21) — not embed-specific
despite the feature that motivated it (an owner wanting a URL-sourced
legal/regulation document re-fetched daily). See `models.ScheduledTask`'s
own docstring for the full design: `task_type` is a dispatch key into
`TASK_REGISTRY` below; any already-existing, already-real maintenance
action in this app (re-sync a URL document, re-embed everything, clean up
orphaned chat uploads, purge stale CRM entries, ...) becomes schedulable
by adding one small registry entry that calls the function that already
exists — this module doesn't know or care what a task_type actually
does, only when to run it and where to record the result.

APScheduler runs IN-PROCESS inside the backend container (an
`AsyncIOScheduler`, since uvicorn already runs an asyncio event loop) —
no separate worker process/container, the first background-job
infrastructure this project has needed. Started once at app startup
(`main.py`'s lifespan), loaded from every `ScheduledTask` row with
`enabled=True`; the CRUD API (`apis/scheduled_tasks.py`) calls back into
this module's `sync_job`/`remove_job` after every create/update/delete so
a change takes effect immediately, without an app restart.

Dev-mode note: uvicorn's `--reload` (WatchFiles) restarts the whole
worker process on every code change, which restarts the scheduler too —
harmless (jobs are reloaded fresh from the DB on the next startup, the
same as a real restart), just worth knowing if a scheduled task's
`last_run_at` looks like it skipped a beat during active development."""

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from db import SessionLocal
from models import ScheduledTask

logger = logging.getLogger("scheduler")

_scheduler = AsyncIOScheduler()


async def _run_resync_url_document(args: dict) -> None:
    from apis.documents import _run_url_ingest

    document_id = args.get("document_id")
    if not isinstance(document_id, int):
        raise ValueError("resync_url_document requires an integer 'document_id' argument.")
    # Optional (2026-08-21) — re-runs the LLM status-note classification
    # on every recurring re-sync, not just the original ingest, so a
    # newly-repealed/superseded status is picked up automatically.
    await _run_url_ingest(document_id, suggest_status_note=bool(args.get("suggest_status_note", False)))


async def _run_reembed_all_documents(args: dict) -> None:
    from apis.documents import reembed_all_documents

    db = SessionLocal()
    try:
        await reembed_all_documents(db=db)
    finally:
        db.close()


async def _run_cleanup_chat_uploads(args: dict) -> None:
    from chat_attachments import cleanup_orphaned_uploads

    db = SessionLocal()
    try:
        cleanup_orphaned_uploads(db, older_than_hours=args.get("older_than_hours", 24))
    finally:
        db.close()


async def _run_cleanup_stale_crm_entries(args: dict) -> None:
    from crm_retention import cleanup_stale_crm_entries

    db = SessionLocal()
    try:
        cleanup_stale_crm_entries(db)
    finally:
        db.close()


# One entry per schedulable action. Adding a new one is almost always a
# thin adapter over a function that already exists elsewhere in this
# app — see the four above, none of which contain any real new logic,
# just session handling + arg unpacking.
TASK_REGISTRY: dict[str, Callable[[dict], Awaitable[None]]] = {
    "resync_url_document": _run_resync_url_document,
    "reembed_all_documents": _run_reembed_all_documents,
    "cleanup_chat_uploads": _run_cleanup_chat_uploads,
    "cleanup_stale_crm_entries": _run_cleanup_stale_crm_entries,
}


async def _execute_task(task_id: int) -> None:
    """The actual APScheduler job body — resolves the current task_type/
    args fresh from the DB (never captured at schedule-time), runs the
    matching registry handler, and records success/failure back onto the
    ScheduledTask row. Every failure is caught and stored, never raised —
    an unhandled exception here would silently kill the whole
    AsyncIOScheduler's job execution, not just this one task."""
    db = SessionLocal()
    try:
        task = db.get(ScheduledTask, task_id)
        if task is None or not task.enabled:
            return
        task_type, task_args = task.task_type, dict(task.task_args or {})
    finally:
        db.close()

    handler = TASK_REGISTRY.get(task_type)
    now = datetime.utcnow()
    try:
        if handler is None:
            raise ValueError(f"Unknown task_type {task_type!r} — was it removed from TASK_REGISTRY?")
        await handler(task_args)
        status, error = "success", None
    except Exception as e:
        logger.exception("Scheduled task id=%s (%s) failed", task_id, task_type)
        status, error = "error", str(e)

    db = SessionLocal()
    try:
        task = db.get(ScheduledTask, task_id)
        if task is not None:
            task.last_run_at = now
            task.last_run_status = status
            task.last_run_error = error
            db.commit()
    finally:
        db.close()


def _cron_trigger(cron_expression: str) -> CronTrigger:
    return CronTrigger.from_crontab(cron_expression)


def sync_job(task: ScheduledTask) -> None:
    """Adds/updates/removes this task's APScheduler job to match its
    current enabled/cron_expression state. Called by the CRUD API after
    every create/update, and once per row at startup."""
    if not task.enabled:
        remove_job(task.id)
        return
    _scheduler.add_job(
        _execute_task,
        trigger=_cron_trigger(task.cron_expression),
        args=[task.id],
        id=f"scheduled_task_{task.id}",
        replace_existing=True,
    )


def remove_job(task_id: int) -> None:
    job_id = f"scheduled_task_{task_id}"
    if _scheduler.get_job(job_id):
        _scheduler.remove_job(job_id)


def start_scheduler() -> None:
    if _scheduler.running:
        return
    db = SessionLocal()
    try:
        tasks = db.execute(select(ScheduledTask).where(ScheduledTask.enabled.is_(True))).scalars().all()
        for task in tasks:
            try:
                sync_job(task)
            except Exception:
                logger.exception(
                    "Failed to schedule task id=%s (cron=%r) — skipping, other tasks unaffected",
                    task.id,
                    task.cron_expression,
                )
    finally:
        db.close()
    _scheduler.start()


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


async def run_task_now(task_id: int) -> None:
    """Immediate one-off execution, bypassing the cron schedule entirely
    — POST /agent/scheduled-tasks/{id}/run-now calls this so an owner can
    verify a newly-created task actually works without waiting for its
    next scheduled fire."""
    await _execute_task(task_id)
