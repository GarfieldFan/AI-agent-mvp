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

engine = create_engine(DATABASE_URL)
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
