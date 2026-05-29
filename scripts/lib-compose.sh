# Single source of truth for the GCP production compose file list.
# Source it (don't execute) AFTER cd'ing to the repo root:
#
#   . scripts/lib-compose.sh
#
# Sets:
#   COMPOSE_FILES   array of -f args for the standing prod stack
#   COMPOSE         full `docker compose -f ...` command as an array
# Exports:
#   K6_COMPOSE_FILES   space-joined -f list, consumed by
#                      scripts/cleanup-k6-load-test-data.sh so cleanup runs
#                      against the same prod stack
# Also loads .env so ENABLE_HTTPS / POSTGRES_* / REDIS_PASSWORD are available.
#
# The standing GCP stack = base + prod override + observability (exporters +
# remote-write Prometheus + k6 service) + the HTTPS edge when enabled. HTTPS
# must stay LAST so its !reset port rules win.

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1090
  . <(sed 's/\r$//' .env)
  set +a
fi

COMPOSE_FILES=(
  -f docker-compose.yml
  -f docker-compose.prod.yml
  -f observability/docker-compose.observability.yml
)
if [ "${ENABLE_HTTPS:-false}" = "true" ]; then
  COMPOSE_FILES+=(-f docker-compose.https.yml)
fi

COMPOSE=(docker compose "${COMPOSE_FILES[@]}")
export K6_COMPOSE_FILES="${COMPOSE_FILES[*]}"
