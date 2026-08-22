"""Owner-facing CRUD for `ScheduledTask` (2026-08-21, see
`backend/scheduler.py`'s module docstring for the full design) — one of
two interfaces onto the same generic recurring-task mechanism, the other
being owner-agent's `manage_scheduled_task` tool. Every write here also
calls back into `scheduler.py` so the running `AsyncIOScheduler` reflects
the change immediately, without an app restart."""

from datetime import datetime

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

import scheduler
from apis.deps import CurrentUser, Role, get_current_user, require_role
from db import get_db
from models import ScheduledTask
from scheduler import TASK_REGISTRY

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


def _validate_cron(cron_expression: str) -> None:
    try:
        CronTrigger.from_crontab(cron_expression)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{cron_expression!r} isn't a valid 5-field cron expression: {e}")


def _validate_task_type(task_type: str) -> None:
    if task_type not in TASK_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"{task_type!r} isn't a schedulable task type. Known types: {sorted(TASK_REGISTRY)}",
        )


class ScheduledTaskSummary(BaseModel):
    id: int
    name: str
    task_type: str
    task_args: dict
    cron_expression: str
    enabled: bool
    last_run_at: datetime | None
    last_run_status: str | None
    last_run_error: str | None
    created_by: str | None
    created_at: datetime


def _to_summary(task: ScheduledTask) -> ScheduledTaskSummary:
    return ScheduledTaskSummary(
        id=task.id,
        name=task.name,
        task_type=task.task_type,
        task_args=task.task_args or {},
        cron_expression=task.cron_expression,
        enabled=task.enabled,
        last_run_at=task.last_run_at,
        last_run_status=task.last_run_status,
        last_run_error=task.last_run_error,
        created_by=task.created_by,
        created_at=task.created_at,
    )


@router.get("/scheduled-tasks", response_model=list[ScheduledTaskSummary])
def list_scheduled_tasks(db: Session = Depends(get_db)) -> list[ScheduledTaskSummary]:
    """Deliberately unpaginated — owner-curated, not user-generated, so
    realistically a handful of rows, same "a handful per site" reasoning
    as `apis/pages.py`'s `list_pages`."""
    tasks = db.scalars(select(ScheduledTask).order_by(ScheduledTask.created_at.desc())).all()
    return [_to_summary(t) for t in tasks]


@router.get("/scheduled-task-types", response_model=list[str])
def list_scheduled_task_types() -> list[str]:
    """The current TASK_REGISTRY's keys — what the dashboard's task_type
    picker (and owner-agent's manage_scheduled_task tool description)
    both read from, so neither hardcodes a copy of this list."""
    return sorted(TASK_REGISTRY)


class ScheduledTaskRequest(BaseModel):
    name: str
    task_type: str
    task_args: dict = {}
    cron_expression: str
    enabled: bool = True


@router.post("/scheduled-tasks", response_model=ScheduledTaskSummary)
def create_scheduled_task(
    req: ScheduledTaskRequest, db: Session = Depends(get_db), current: CurrentUser = Depends(get_current_user)
) -> ScheduledTaskSummary:
    """Create-or-update BY NAME, not a plain create — same
    `upsert_intent_view` precedent as `apis/intent_schemas.py`'s
    `POST /agent/intent-views`: owner-agent has no memory of a numeric id
    across separate `/run` calls, so a follow-up command like "actually
    run that every Monday instead" needs to find and update the SAME row
    by the name the owner already gave it, not create a duplicate. The
    dashboard's own edit flow uses `PUT .../{id}` instead, once it
    already has a specific row's real id in hand."""
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="name must not be empty.")
    _validate_task_type(req.task_type)
    _validate_cron(req.cron_expression)

    name = req.name.strip()
    task = db.execute(select(ScheduledTask).where(ScheduledTask.name == name)).scalar_one_or_none()
    if task is None:
        task = ScheduledTask(name=name, created_by=current.email)
        db.add(task)

    task.task_type = req.task_type
    task.task_args = req.task_args
    task.cron_expression = req.cron_expression
    task.enabled = req.enabled
    db.commit()
    db.refresh(task)
    scheduler.sync_job(task)
    return _to_summary(task)


@router.put("/scheduled-tasks/{task_id}", response_model=ScheduledTaskSummary)
def update_scheduled_task(task_id: int, req: ScheduledTaskRequest, db: Session = Depends(get_db)) -> ScheduledTaskSummary:
    task = db.get(ScheduledTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"No scheduled task {task_id}")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="name must not be empty.")
    _validate_task_type(req.task_type)
    _validate_cron(req.cron_expression)

    task.name = req.name.strip()
    task.task_type = req.task_type
    task.task_args = req.task_args
    task.cron_expression = req.cron_expression
    task.enabled = req.enabled
    db.commit()
    db.refresh(task)
    scheduler.sync_job(task)
    return _to_summary(task)


@router.delete("/scheduled-tasks/{task_id}", status_code=204)
def delete_scheduled_task(task_id: int, db: Session = Depends(get_db)) -> None:
    task = db.get(ScheduledTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"No scheduled task {task_id}")
    db.delete(task)
    db.commit()
    scheduler.remove_job(task_id)


@router.post("/scheduled-tasks/{task_id}/run-now", response_model=ScheduledTaskSummary)
async def run_scheduled_task_now(task_id: int, db: Session = Depends(get_db)) -> ScheduledTaskSummary:
    """Runs the task immediately, bypassing its cron schedule — lets an
    owner verify a newly-created task actually works without waiting for
    its next scheduled fire. Awaited synchronously so the response
    reflects the real outcome (last_run_status/last_run_error) rather
    than an immediate "started" with no way to know if it worked — the
    same "budget minutes, not seconds" tradeoff this app already accepts
    for `generate_landing_page`/ComfyUI generation. A slow task type
    (e.g. `resync_url_document` against a large legal document) makes
    this a slow request; that's expected, not a bug."""
    task = db.get(ScheduledTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"No scheduled task {task_id}")
    await scheduler.run_task_now(task_id)
    db.refresh(task)
    return _to_summary(task)
