"""Shared pytest fixtures.

First real test suite in this backend (2026-08-20) — every prior
verification in this project was live curl/manual checking (see
HISTORY.md/AGENTS.md's own "verified end-to-end via curl" pattern
throughout). These tests follow the same "hit the real thing, don't
mock" culture rather than introducing a parallel mocked-unit-test
philosophy: `db_session` below runs against the real dev Postgres this
project already uses (same DATABASE_URL the app itself connects with),
and the LLM-dependent tests in test_intent_schema_scope.py hit whatever
chat provider is actually configured in AppSettings — slow and only
semi-deterministic (a real model call, not a pure function), which is
exactly why those are marked `slow` and excluded from the default run.

Run from inside the backend container (needs the same DB/network access
the app itself has — Ollama/custom LLM endpoints are only reachable from
there, same as every other verification in this project):
    docker compose exec backend pytest                  # fast tests only
    docker compose exec backend pytest -m slow           # the live-LLM ones too
    docker compose exec backend pytest -m "" -q          # everything, quiet
"""

import pytest
from sqlalchemy.orm import Session

from db import engine


@pytest.fixture
def db_session():
    """A real session against the shared dev database, wrapped so nothing
    a test does ever survives it. Deliberately NOT sqlite-in-memory or a
    mocked session: the whole point of test_intent_schema_lifecycle.py is
    to verify real Postgres FK `ON DELETE CASCADE`/`SET NULL` behavior
    (alembic/versions/a7d3e9f1c5b2 and c2e8b4d6f9a1) actually holds.

    Uses SQLAlchemy's documented "join an external transaction, with
    savepoints" pattern (`join_transaction_mode="create_savepoint"`),
    not a plain `SessionLocal()` + rollback — some of the app functions
    these tests call (`_apply_lead_capture`) call `db.commit()`
    internally, same as they do for real in the running app. Binding the
    session to a connection that's already inside an outer transaction
    means each internal `commit()` only ends/restarts a SAVEPOINT rather
    than committing for real; the outer `trans.rollback()` below always
    discards everything regardless of how many times the code under test
    called `commit()`."""
    connection = engine.connect()
    trans = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        connection.close()
