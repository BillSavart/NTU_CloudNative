#!/usr/bin/env bash
# Production deploy for the single-VM Docker Compose stack.
#
# Run by .github/workflows/cd.yml over SSH after images are pushed to GHCR,
# or manually on the VM:  IMAGE_TAG=latest ./scripts/deploy.sh
#
# Env (all optional except when pulling private GHCR images):
#   IMAGE_TAG     image tag to deploy (default: latest)
#   IMAGE_PREFIX  GHCR image prefix   (default: the prod compose default)
#   GHCR_USER     GitHub username for `docker login ghcr.io`
#   GHCR_TOKEN    PAT / token with read:packages (skip login if unset)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export IMAGE_TAG="${IMAGE_TAG:-latest}"

# Read ENABLE_HTTPS (and any other vars) from .env so the toggle works without
# the caller exporting it. Done before the compose array is built.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1090
  . <(sed 's/\r$//' .env)
  set +a
fi

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.prod.yml)
# Add the Caddy/TLS edge when HTTPS is enabled (needs DOMAIN set in .env).
if [ "${ENABLE_HTTPS:-false}" = "true" ]; then
  COMPOSE_FILES+=(-f docker-compose.https.yml)
  echo "==> HTTPS enabled (Caddy edge, DOMAIN=${DOMAIN:-<unset!>})"
fi

COMPOSE=(docker compose "${COMPOSE_FILES[@]}")
APP_SERVICES=(access-api reporting-api frontend simulator)

echo "==> Syncing repo to origin/main (compose files & bind-mounted configs)"
# .env and other gitignored files are preserved by reset --hard.
git fetch --prune origin
git reset --hard origin/main

if [ ! -f .env ]; then
  echo "ERROR: .env is missing on the VM. Copy .env.example and set real secrets." >&2
  exit 1
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "==> Logging in to GHCR as ${GHCR_USER:?GHCR_USER required when GHCR_TOKEN is set}"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

echo "==> Pulling app images (tag: $IMAGE_TAG)"
"${COMPOSE[@]}" pull "${APP_SERVICES[@]}"

echo "==> Starting / updating the stack"
# reporting-api auto-runs Alembic migrations on startup (app/main.py).
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> Current state"
"${COMPOSE[@]}" ps

echo "==> Pruning dangling images"
docker image prune -f >/dev/null

echo "==> Deploy complete."
