"""Runs `alembic upgrade head` automatically on backend startup
(2026-09-09) — on the user's own direct ask, off the "non-technical
owners can't be expected to know what a migration is" principle this
whole session's onboarding work is built around (see the root AGENTS.md's
"First-run setup wizard" section). Before this, every schema change
needed a manually-run `docker compose exec backend alembic upgrade head`
— harmless for this project's own development sessions, but a real
blocker for an owner who just wants `docker compose up` to be the one
command they ever need to know.

Uses Alembic's own Python API (`alembic.command.upgrade`), not a shelled-
out subprocess — same config file (`alembic.ini`) and `env.py` the
manual CLI invocation already used, so behavior is identical, just
triggered automatically. Retries briefly since `docker-compose.yml`'s
`depends_on: postgres-db` only guarantees the container has STARTED, not
that Postgres is actually ready to accept connections yet — a real race
this project's own multi-service startup can hit."""

import logging
import time
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.exc import OperationalError

logger = logging.getLogger("backend.migrate")

_RETRY_ATTEMPTS = 10
_RETRY_DELAY_SECONDS = 2


def run_migrations_with_retry() -> None:
    cfg = Config(str(Path(__file__).resolve().parent / "alembic.ini"))
    last_error: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            command.upgrade(cfg, "head")
            logger.info("Database migrations applied (attempt %d).", attempt)
            return
        except OperationalError as e:
            last_error = e
            logger.warning(
                "Database not ready yet for migrations (attempt %d/%d): %s", attempt, _RETRY_ATTEMPTS, e
            )
            time.sleep(_RETRY_DELAY_SECONDS)
    # Deliberately fatal — starting the app with a schema that doesn't
    # match the code is worse than failing loudly at boot, the same
    # reasoning any "crash on bad config" startup check follows.
    raise RuntimeError(f"Could not apply database migrations after {_RETRY_ATTEMPTS} attempts.") from last_error
