# Dev-oriented image: docker-compose bind-mounts the source directory over
# /app for hot reload, so this only needs to get dependencies installed and
# `next dev` running — no multi-stage production build here.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Runs as the image's built-in non-root `node` user (uid/gid 1000,
# 2026-08-19 security-audit fix) rather than root, the image's default.
# node_modules/.next are anonymous volumes (see docker-compose.yml) —
# Docker seeds a fresh anonymous volume from whatever's already at that
# path *in this image layer*, ownership included, so chown here (before
# USER switches) is what makes that seeded copy actually writable by
# `node` at runtime instead of root. `.next` is .dockerignore'd (Next
# only ever creates it at runtime) — mkdir it explicitly first, or
# there's nothing at that path for chown to act on and Docker seeds the
# fresh volume as an empty, root-owned directory instead (hit this for
# real: `next dev` crashed with EACCES on `mkdir '/app/.next/dev'` before
# this line was added).
RUN mkdir -p /app/.next && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "run", "dev"]
