"""One-time PRODUCTION-safe owner-account bootstrap — deliberately NOT
seed.py.

seed.py's three demo accounts (shared password "0000", displayed openly
on the frontend's own /login page) are for the local docker-compose demo
ONLY — that file's own docstring says plainly there's "nothing behind
these accounts worth protecting" there and to never reuse the pattern
"anywhere real credentials matter." A real internet-facing deployment
(deploy/setup-server.sh, see that script and deploy/README.md) is
exactly that "anywhere real credentials matter" case: running seed.py
against a publicly reachable server would leave a well-known
owner@example.com / 0000 account — full owner privileges — sitting on
the open internet the instant the containers come up, for anyone to try
before the real owner ever logs in once.

This script creates exactly ONE real owner account instead, with a
freshly generated random password printed ONCE to stdout (the caller —
deploy/setup-server.sh — is responsible for actually showing it to the
person running the deploy; this script itself never writes it anywhere
else, e.g. no log file). Refuses to run again once ANY owner account
already exists, so re-running deploy/setup-server.sh after a partial/
failed first attempt never creates a second owner or silently resets a
password the real owner has already changed.

Run via `docker compose exec backend python create_owner.py [email]`
(email optional, defaults to owner@example.com).
"""

import secrets
import sys

from auth import hash_password
from db import SessionLocal
from models import User


def main() -> None:
    email = sys.argv[1] if len(sys.argv) > 1 else "owner@example.com"
    db = SessionLocal()
    try:
        if db.query(User).filter(User.role == "owner").first():
            print("An owner account already exists — nothing to do.")
            return

        password = secrets.token_urlsafe(18)
        db.add(
            User(
                email=email,
                hashed_password=hash_password(password),
                role="owner",
                # Same trust bar as seed.py's own demo accounts and
                # apis/users.py's owner-created accounts — this script is
                # only ever run by whoever controls the server itself, so
                # personally provisioning it is proof enough of intent/
                # ownership. See models.User.email_verified's own docstring.
                email_verified=True,
            )
        )
        db.commit()
        # Printed exactly once, to stdout only — deploy/setup-server.sh
        # is the only intended caller and shows this directly to whoever
        # ran the deploy. Never written to a log file or any other
        # durable location by this script.
        print(f"OWNER_EMAIL={email}")
        print(f"OWNER_PASSWORD={password}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
