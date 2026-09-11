#!/usr/bin/env bash
#
# One-command local install/start for macOS testers — NOT the same job
# as deploy/setup-server.sh (that one bootstraps a fresh Ubuntu/Debian
# CLOUD server: installs Docker itself via apt, configures ufw, sets up
# Nginx + Let's Encrypt for a real public domain). None of that applies
# to a Mac running this for local testing: Docker Desktop is a GUI app
# you install yourself (macOS won't let a script silently install one),
# there's no public domain/HTTPS involved, and no firewall to configure.
# This script only handles what's actually different for a local Mac
# run: checking Docker Desktop is present and running, then the same
# .env bootstrap + `docker compose up` + owner-account creation
# deploy/setup-server.sh already does for a server.
#
# Usage:
#   ./deploy/install-mac.sh
set -euo pipefail

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$1" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS. On Windows, use deploy/install-windows.ps1;" >&2
  echo "on a Linux cloud server, use deploy/setup-server.sh." >&2
  exit 1
fi

# --- Docker Desktop check (never auto-installed — see the header) ------
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  warn "Docker Desktop isn't installed or isn't running."
  echo
  if command -v brew >/dev/null 2>&1; then
    echo "Install it with Homebrew, then open it once from Launchpad/Applications"
    echo "(first launch needs to finish its own setup before the docker command works):"
    echo
    echo "    brew install --cask docker"
    echo
  else
    echo "Download and install it from:"
    echo
    echo "    https://www.docker.com/products/docker-desktop/"
    echo
  fi
  echo "Then re-run this script."
  exit 1
fi

# --- Find or clone the repo ---------------------------------------------
REPO_URL="https://github.com/GarfieldFan/AI-agent-mvp.git"
if [[ -f "./docker-compose.yml" && -f "./deploy/install-mac.sh" ]]; then
  log "Running from inside an existing checkout — using $(pwd)"
elif [[ -f "$HOME/ai-employee/docker-compose.yml" ]]; then
  log "Existing checkout found at $HOME/ai-employee — using it"
  cd "$HOME/ai-employee"
else
  if ! command -v git >/dev/null 2>&1; then
    echo "git isn't installed — install it (e.g. \"xcode-select --install\") or download the" >&2
    echo "code as a .zip from $REPO_URL and run this script from inside it instead." >&2
    exit 1
  fi
  log "Cloning into $HOME/ai-employee"
  git clone "$REPO_URL" "$HOME/ai-employee"
  cd "$HOME/ai-employee"
fi
TARGET_DIR="$(pwd)"

# --- .env bootstrap (never overwrites an existing file) -----------------
if [[ ! -f .env ]]; then
  log "Creating .env from .env.example"
  cp .env.example .env
fi

set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

if ! grep -q '^JWT_SECRET=' .env || grep -q '^JWT_SECRET=dev-only-insecure-secret-change-me' .env; then
  log "Generating a real JWT_SECRET"
  set_env JWT_SECRET "$(openssl rand -hex 32)"
fi

# .env.example's own COMFYUI_HOST_OUTPUT_DIR default is a Windows path
# (D:\...) from this project's own dev machine — invalid here regardless
# of what it's set to, since no real ComfyUI is attached on a fresh test
# machine. A harmless empty local directory keeps the bind mount valid;
# image generation just reports "not reachable" (existing graceful-
# degradation behavior), same fix deploy/setup-server.sh makes for Linux.
if ! grep -qE '^COMFYUI_HOST_OUTPUT_DIR=' .env || ! [[ -d "$(grep -E '^COMFYUI_HOST_OUTPUT_DIR=' .env | cut -d= -f2-)" ]]; then
  mkdir -p "$TARGET_DIR/data/comfy_output"
  set_env COMFYUI_HOST_OUTPUT_DIR "$TARGET_DIR/data/comfy_output"
fi

# --- Bring the app up -----------------------------------------------------
log "Pulling images and starting the stack (this can take a few minutes on first run)"
docker compose pull --quiet || true  # best-effort — build-only images have nothing to pull
docker compose up -d --build

log "Waiting for the backend to become reachable"
BACKEND_PORT_VAL="$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2 || echo 8000)"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${BACKEND_PORT_VAL:-8000}/openapi.json" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

# --- First-owner bootstrap (production-safe — see backend/create_owner.py) ---
log "Ensuring a real owner account exists"
OWNER_OUTPUT="$(docker compose exec -T backend python create_owner.py || true)"
echo "$OWNER_OUTPUT" | grep -v '^OWNER_PASSWORD=' || true

# --- Summary --------------------------------------------------------------
FRONTEND_PORT_VAL="$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2 || echo 3000)"
log "Done"
echo "Site: http://localhost:${FRONTEND_PORT_VAL:-3000}"
if echo "$OWNER_OUTPUT" | grep -q '^OWNER_PASSWORD='; then
  echo
  echo "############################################################"
  echo "# A real owner account was just created — SAVE THIS NOW,"
  echo "# it will never be shown again:"
  echo "#   $(echo "$OWNER_OUTPUT" | grep '^OWNER_EMAIL=')"
  echo "#   $(echo "$OWNER_OUTPUT" | grep '^OWNER_PASSWORD=')"
  echo "############################################################"
fi
echo
echo "To stop: docker compose down (from $TARGET_DIR)"
echo "To update later: git pull && docker compose up -d --build"
