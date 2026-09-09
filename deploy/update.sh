#!/usr/bin/env bash
#
# Pulls the latest code and restarts the stack — the ongoing-maintenance
# counterpart to setup-server.sh's one-time bootstrap. Run from inside
# the deployed checkout (wherever setup-server.sh cloned it, /opt/
# ai-employee by default):
#   sudo ./deploy/update.sh
#
# Migrations run automatically on backend startup (see backend/migrate.py
# and the root AGENTS.md's "Automatic database migrations" section) —
# nothing extra to run here for a schema change.
set -euo pipefail

if [[ ! -f docker-compose.yml ]]; then
  echo "Run this from the root of your deployed checkout (the directory with docker-compose.yml in it)." >&2
  exit 1
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Rebuilding and restarting"
docker compose pull --quiet || true
docker compose up -d --build

echo "==> Done — docker compose ps:"
docker compose ps
