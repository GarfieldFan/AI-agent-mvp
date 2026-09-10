"""SQLAlchemy engine/session setup.

First real DB usage in this backend — `postgres-db` has been running in
docker-compose since the start, but nothing used it until the page-storage
feature (backend/models.py, apis/pages.py) needed real persistence.
"""

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://my_user:my_password@postgres-db:5432/my_mvp_db"
)

# Explicit pool sizing (2026-09-10) — was `create_engine(DATABASE_URL)`
# with no overrides, silently defaulting to SQLAlchemy's own
# pool_size=5/max_overflow=10 (15 connections total) with an
# uncustomized pool_timeout. A real stress test found this exact cap:
# a burst of a couple hundred concurrent requests to a single public,
# unauthenticated, DB-backed GET route (no botnet needed — one machine)
# exhausted all 15 connections and left the whole backend unresponsive
# to ALL traffic for 90+ seconds with no self-recovery, requiring a
# container restart — `pg_stat_activity` showed exactly 15 connections
# stuck `idle in transaction`. `pool_timeout=10` is the actual fix for
# that failure mode: a request that can't get a connection within 10s
# now raises (caught by main.py's global exception handler — logged,
# a clean 500, optionally alerts the owner — see error_alerts.py) instead
# of hanging indefinitely. `pool_size`/`max_overflow` are also doubled
# from the previous default (30 total instead of 15) so a real burst of
# legitimate concurrent traffic has more headroom before hitting that
# timeout at all. `pool_pre_ping=True` is a standard, low-risk addition
# alongside this — detects a connection Postgres has silently closed
# before handing it to a request, rather than that request failing with
# a confusing "server closed the connection unexpectedly" error.
# See rate_limit.py's PREFIX_RULES for the other half of this fix — this
# alone raises the ceiling and fails fast past it, but doesn't stop a
# single IP from creating that contention in the first place.
engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_timeout=10,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db() -> Session:
    """FastAPI dependency: yields a session, closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
