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

# Build the prod compose file list (base + prod + observability [+ https]) and
# load .env. Single source of truth shared with the prod helper scripts.
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh
if [ "${ENABLE_HTTPS:-false}" = "true" ]; then
  echo "==> HTTPS enabled (Caddy edge, DOMAIN=${DOMAIN:-<unset!>})"
fi

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

# Health-gate the deploy: a "running" container is not the same as a healthy
# service. These two endpoints are bound to 127.0.0.1 in every mode (HTTP and
# HTTPS), so the check is identical regardless of the Caddy edge. If either
# never comes up, exit non-zero so CD shows a red X (a real failure) instead of
# a misleading green.
check_url() {
  local name="$1" url="$2" attempts="${3:-60}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "  ok   $name"
      return 0
    fi
    sleep 2
  done
  echo "  FAIL $name did not become healthy at $url" >&2
  return 1
}

echo "==> Health checks"
health_ok=true
check_url "reporting-api" "http://127.0.0.1:8000/api/health/" || health_ok=false
check_url "access-api"    "http://127.0.0.1:8080/healthz"     || health_ok=false
if [ "$health_ok" != true ]; then
  echo "ERROR: health checks failed; recent logs:" >&2
  "${COMPOSE[@]}" logs --tail=80 reporting-api access-api access-lb >&2 || true
  exit 1
fi

echo "==> Pruning dangling images"
docker image prune -f >/dev/null

# Record what was actually deployed so anyone can confirm the live version with:
#   cat DEPLOYED_VERSION
DEPLOYED_SHA="$(git rev-parse HEAD)"
cat > DEPLOYED_VERSION <<EOF
commit:    $DEPLOYED_SHA
image_tag: $IMAGE_TAG
https:     ${ENABLE_HTTPS:-false}
deployed:  $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)
EOF
echo "==> Deployed version:"
sed 's/^/    /' DEPLOYED_VERSION

echo "==> Deploy complete (healthy)."
