"""Seeds the three demo accounts used to exercise RBAC end to end.

Run manually after migrating: `docker compose exec backend python seed.py`.
Idempotent — re-running just skips any email that already exists, so it's
safe to run again after a fresh migration. Note: "skips" means it does NOT
update the password on an existing account — changing DEMO_PASSWORD and
re-running does nothing to accounts that already exist. To actually change
an existing demo account's password, update it directly (see the root
AGENTS.md for the one-off script used on 2026-08-04, or just delete the
`users` rows and re-run this).

DEMO CREDENTIALS ONLY. The shared password below is intentionally simple
and is displayed on the frontend's /login page — there is nothing behind
these accounts worth protecting in this local docker-compose demo. Do not
reuse this pattern anywhere real credentials matter.
"""

from auth import hash_password
from db import SessionLocal
from models import User

DEMO_PASSWORD = "0000"

DEMO_USERS = [
    {"email": "owner@example.com", "role": "owner"},
    {"email": "admin@example.com", "role": "admin"},
    {"email": "user@example.com", "role": "user"},
]


def main() -> None:
    db = SessionLocal()
    try:
        for demo in DEMO_USERS:
            existing = db.query(User).filter(User.email == demo["email"]).first()
            if existing:
                print(f"skip (already exists): {demo['email']}")
                continue
            db.add(
                User(
                    email=demo["email"],
                    hashed_password=hash_password(DEMO_PASSWORD),
                    role=demo["role"],
                )
            )
            print(f"created: {demo['email']} ({demo['role']})")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
