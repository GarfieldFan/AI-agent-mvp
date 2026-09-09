#!/usr/bin/env bash
#
# Bootstraps a FRESH Ubuntu/Debian server (EC2 or any VPS) into a running
# copy of this app — Docker install, repo clone/update, .env generation,
# `docker compose up`, and (optionally) a real domain with automatic
# HTTPS via Nginx + Let's Encrypt. See deploy/README.md for the one-time
# AWS-console (or your VPS provider's own) steps this script does NOT and
# cannot do for you — launching the instance itself, opening its
# firewall/security-group ports, pointing a domain's DNS at it.
#
# Usage (run as root, e.g. via `sudo`):
#   ./deploy/setup-server.sh                                   # plain HTTP, server's own IP
#   ./deploy/setup-server.sh --domain example.com --email you@example.com   # + automatic HTTPS
#
# Safe to re-run: every step below is written to be idempotent — a
# second run (e.g. to add a domain to an already-running plain-HTTP
# deploy, or after a partial failure) never re-clobbers a `.env` you've
# already customized, never creates a second owner account, and reuses
# an already-obtained TLS certificate rather than requesting a new one.
set -euo pipefail

# --- Argument parsing -------------------------------------------------
DOMAIN=""
EMAIL=""
# Defaults to this project's own real origin — override with --repo if
# you're deploying your own fork. If this repo is private, cloning it
# from a fresh server needs its own auth (a deploy key, a PAT in the
# URL, or an already-uploaded checkout you cd into before running this
# script instead of letting it clone) — see deploy/README.md.
REPO_URL="https://github.com/GarfieldFan/AI-agent-mvp.git"
TARGET_DIR="/opt/ai-employee"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) TARGET_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$DOMAIN" && -z "$EMAIL" ]]; then
  echo "--domain requires --email too (Let's Encrypt needs it for renewal/expiry notices)." >&2
  exit 1
fi

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$1" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this as root (e.g. \"sudo $0 ...\") — it installs system packages and edits system Nginx config." >&2
  exit 1
fi

# --- OS check ----------------------------------------------------------
if [[ ! -f /etc/os-release ]] || ! grep -qE '^ID=(ubuntu|debian)' /etc/os-release; then
  echo "This script only supports Ubuntu/Debian (apt-based) servers. See deploy/README.md for the tested target." >&2
  exit 1
fi

# --- Docker install (official apt-repo method, idempotent) -------------
log "Installing prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
else
  log "Docker already installed — skipping"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# --- Clone or update the repo ------------------------------------------
if [[ -f "$TARGET_DIR/docker-compose.yml" ]]; then
  log "Existing checkout found at $TARGET_DIR — pulling latest"
  git -C "$TARGET_DIR" pull --ff-only || warn "git pull failed (local changes / diverged history?) — continuing with what's on disk."
elif [[ -f "./docker-compose.yml" && -f "./deploy/setup-server.sh" ]]; then
  log "Running from inside an existing checkout — using $(pwd) instead of cloning"
  TARGET_DIR="$(pwd)"
else
  log "Cloning $REPO_URL into $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# --- .env bootstrap (never overwrites an existing file) -----------------
if [[ ! -f .env ]]; then
  log "Creating .env from .env.example"
  cp .env.example .env
fi

# Upserts KEY=VALUE into .env — replaces an existing line for that key
# (any value, so a stale placeholder gets corrected) or appends if the
# key isn't present at all yet. Never touches any other line.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

# A real random JWT_SECRET — only if it's still .env.example's own
# published-in-this-repo insecure literal (or missing outright). Leaves
# an already-customized real secret alone, so re-running this script
# never invalidates every session the owner already has.
if ! grep -q '^JWT_SECRET=' .env || grep -q '^JWT_SECRET=dev-only-insecure-secret-change-me' .env; then
  log "Generating a real JWT_SECRET"
  set_env JWT_SECRET "$(openssl rand -hex 32)"
fi

# ComfyUI's own .env.example default is a Windows path (D:\...) meant for
# local dev — invalid as a Linux bind-mount source and, with no ":-"
# fallback in docker-compose.yml's volumes: entry, would break `docker
# compose up` outright on a fresh Linux clone. This server has no GPU
# image-gen worker attached; a harmless empty local directory keeps the
# bind mount valid — image generation just reports "not reachable"
# (already-existing graceful-degradation behavior, see
# apis/model_settings.py's own ComfyUI reachability probe), same as any
# other unreachable-but-unconfigured provider in this app.
if ! grep -q '^COMFYUI_HOST_OUTPUT_DIR=' .env || grep -q '^COMFYUI_HOST_OUTPUT_DIR=D:' .env; then
  mkdir -p "$TARGET_DIR/data/comfy_output"
  set_env COMFYUI_HOST_OUTPUT_DIR "$TARGET_DIR/data/comfy_output"
fi

if [[ -n "$DOMAIN" ]]; then
  log "Configuring .env for https://$DOMAIN"
  set_env HOST "$DOMAIN"
  set_env PUBLIC_ORIGIN "https://$DOMAIN"
  set_env PUBLIC_OWNER_AGENT_URL "https://$DOMAIN/owner-agent"
  set_env BIND_HOST "127.0.0.1"
fi

# --- Firewall: only touch ufw if it's already active on this box --------
# Deliberately never force-enables ufw — this script has no way to know
# whether the owner is relying on it, a different firewall, or their
# cloud provider's own security group instead, and turning it on for the
# first time here without first confirming SSH stays allowed would risk
# locking the owner out of their own remote session. Only ADD rules to
# an already-active ufw; otherwise just print what needs to be open.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "ufw is active — allowing 80/443"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  if [[ -z "$DOMAIN" ]]; then
    ufw allow "${BACKEND_PORT:-8000}/tcp" >/dev/null 2>&1 || true
    ufw allow "${FRONTEND_PORT:-3000}/tcp" >/dev/null 2>&1 || true
    ufw allow "${OWNER_AGENT_PORT:-8100}/tcp" >/dev/null 2>&1 || true
  fi
fi

# --- Bring the app up ----------------------------------------------------
log "Pulling images and starting the stack (this can take a few minutes on first run)"
docker compose pull --quiet || true  # best-effort — build-only images (backend/frontend/owner-agent) have nothing to pull
docker compose up -d --build

log "Waiting for the backend to become reachable"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2 || echo 8000)/openapi.json" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

# --- First-owner bootstrap (production-safe — see backend/create_owner.py) ---
log "Ensuring a real owner account exists"
OWNER_OUTPUT="$(docker compose exec -T backend python create_owner.py || true)"
echo "$OWNER_OUTPUT" | grep -v '^OWNER_PASSWORD=' || true

# --- Optional domain + automatic HTTPS -----------------------------------
if [[ -n "$DOMAIN" ]]; then
  log "Installing Nginx + Certbot"
  apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null

  BACKEND_PORT_VAL="$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2 || echo 8000)"
  FRONTEND_PORT_VAL="$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2 || echo 3000)"
  OWNER_AGENT_PORT_VAL="$(grep -E '^OWNER_AGENT_PORT=' .env | cut -d= -f2 || echo 8100)"

  sed \
    -e "s/__DOMAIN__/$DOMAIN/g" \
    -e "s/__BACKEND_PORT__/${BACKEND_PORT_VAL:-8000}/g" \
    -e "s/__FRONTEND_PORT__/${FRONTEND_PORT_VAL:-3000}/g" \
    -e "s/__OWNER_AGENT_PORT__/${OWNER_AGENT_PORT_VAL:-8100}/g" \
    deploy/nginx.conf.template > /etc/nginx/sites-available/ai-employee.conf
  ln -sf /etc/nginx/sites-available/ai-employee.conf /etc/nginx/sites-enabled/ai-employee.conf

  # Move the stock "It works!" default site out of the way rather than
  # deleting it outright — it would otherwise conflict on port 80, but a
  # disable-by-rename is trivially reversible if that's ever wanted back.
  if [[ -e /etc/nginx/sites-enabled/default ]]; then
    mv /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/default.disabled-by-ai-employee-deploy
  fi

  nginx -t
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl reload nginx

  log "Requesting a Let's Encrypt certificate for $DOMAIN"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    log "HTTPS is live at https://$DOMAIN"
  else
    warn "Certbot failed — this is almost always DNS not pointed at this server's IP yet. The site is still reachable over plain HTTP at http://$DOMAIN meanwhile; once the domain's A record resolves here, just re-run: certbot --nginx -d $DOMAIN --agree-tos -m $EMAIL --redirect"
  fi
fi

# --- Summary --------------------------------------------------------------
log "Done"
if [[ -n "$DOMAIN" ]]; then
  echo "Site: http://$DOMAIN (https:// once DNS/certbot above succeeds)"
else
  echo "Site: http://<this-server's-public-IP>:${FRONTEND_PORT_VAL:-3000}"
fi
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
echo "This app has no automatic backups — snapshot the server's disk (or"
echo "at least pg_dump the postgres-db volume) on whatever schedule"
echo "matters to you. See deploy/README.md for what to do next."
