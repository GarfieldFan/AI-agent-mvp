# Dev-oriented image: docker-compose bind-mounts the source directory over
# /app for hot reload, so this only needs to get dependencies installed and
# `next dev` running — no multi-stage production build here.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
