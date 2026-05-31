#!/usr/bin/env bash
# VM-side control helper for the remote DB+Kafka chaos test.
#
# Invoked over SSH by scripts/k6_remote.sh (which generates the load from an
# external machine). Runs ON THE GCP VM against the standing prod stack. Uses
# the prod compose file list via lib-compose.sh so it targets exactly the
# running containers.
#
#   ./scripts/chaos_db_kafka_ctl.sh down              # stop db + all kafka
#   ./scripts/chaos_db_kafka_ctl.sh up                # restart them, wait healthy
#   ./scripts/chaos_db_kafka_ctl.sh count <prefix>    # access_events rows for prefix
#   ./scripts/chaos_db_kafka_ctl.sh cleanup <prefix>  # delete test rows/keys
#
# Redis (master + replicas + sentinels) is intentionally LEFT UP: it is what
# keeps access-api making correct open/close decisions and buffering events
# during the outage.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh   # sets COMPOSE, loads .env (POSTGRES_*, REPORTING_HOST_PORT)

CHAOS_SERVICES=(db kafka-1 kafka-2 kafka-3)

wait_for_reporting_api() {
  local url="http://127.0.0.1:${REPORTING_HOST_PORT:-8000}/api/health/"
  for _ in $(seq 1 60); do
    curl -fsS "${url}" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "reporting-api did not become healthy after recovery." >&2
  return 1
}

cmd="${1:-}"
case "${cmd}" in
  down)
    echo "Chaos: stopping ${CHAOS_SERVICES[*]} (Redis stays up)..."
    "${COMPOSE[@]}" stop "${CHAOS_SERVICES[@]}"
    ;;
  up)
    echo "Chaos: restarting ${CHAOS_SERVICES[*]}..."
    "${COMPOSE[@]}" up -d "${CHAOS_SERVICES[@]}"
    wait_for_reporting_api
    echo "Chaos: services restored and reporting-api healthy."
    ;;
  count)
    prefix="${2:?usage: $0 count <prefix>}"
    "${COMPOSE[@]}" exec -T db \
      psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
      "SELECT count(*) FROM access_events WHERE employee_id LIKE '${prefix}%';"
    ;;
  cleanup)
    prefix="${2:?usage: $0 cleanup <prefix>}"
    # Run several passes: the cleanup deletes access_events and employees in one
    # CTE snapshot, so orphan employee rows only disappear on the pass AFTER
    # their events are gone (same approach as scripts/k6_prod.sh). A short settle
    # first lets async Kafka/reporting writes land before we delete.
    passes="${CLEANUP_PASSES:-3}"
    sleep "${CLEANUP_SETTLE_SECONDS:-8}"
    for pass in $(seq 1 "${passes}"); do
      echo "cleanup pass ${pass}/${passes} for prefix '${prefix}'..."
      ./scripts/cleanup-k6-load-test-data.sh "${prefix}" || true
      [ "${pass}" != "${passes}" ] && sleep 3
    done
    ;;
  *)
    echo "Usage: $0 {down|up|count <prefix>|cleanup <prefix>}" >&2
    exit 2
    ;;
esac
