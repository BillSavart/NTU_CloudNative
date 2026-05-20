#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOPIC="${KAFKA_TOPIC:-access-events}"
EMPLOYEE_ID="${EMPLOYEE_ID:-E2E_$(date +%Y%m%d%H%M%S)}"
E2E_CLEANUP="${E2E_CLEANUP:-false}"

export ACCESS_HOST_PORT="${ACCESS_HOST_PORT:-18080}"
export REPORTING_HOST_PORT="${REPORTING_HOST_PORT:-18000}"
export POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-15432}"
export REDIS_HOST_PORT="${REDIS_HOST_PORT:-16379}"
export REDIS_SENTINEL_1_HOST_PORT="${REDIS_SENTINEL_1_HOST_PORT:-36379}"
export REDIS_SENTINEL_2_HOST_PORT="${REDIS_SENTINEL_2_HOST_PORT:-36380}"
export REDIS_SENTINEL_3_HOST_PORT="${REDIS_SENTINEL_3_HOST_PORT:-36381}"
export KAFKA_1_HOST_PORT="${KAFKA_1_HOST_PORT:-49092}"
export KAFKA_2_HOST_PORT="${KAFKA_2_HOST_PORT:-59092}"
export KAFKA_3_HOST_PORT="${KAFKA_3_HOST_PORT:-39093}"

ACCESS_URL="${ACCESS_URL:-http://127.0.0.1:${ACCESS_HOST_PORT}}"
REPORTING_URL="${REPORTING_URL:-http://127.0.0.1:${REPORTING_HOST_PORT}}"

cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  dump_debug
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "missing docker compose or docker-compose" >&2
    exit 1
  fi
}

json_field() {
  local json="$1"
  local field="$2"
  python3 -c 'import json,sys; value=json.loads(sys.argv[1]).get(sys.argv[2], ""); print(json.dumps(value) if isinstance(value, bool) else value)' "$json" "$field"
}

assert_json_field() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local actual
  actual="$(json_field "$json" "$field")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Response was: %s\n' "$json" >&2
    fail "expected .$field=$expected, got $actual"
  fi
}

wait_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/tmp/e2e-response.json 2>/dev/null; then
      cat /tmp/e2e-response.json
      return 0
    fi
    sleep 2
  done

  fail "$name did not become ready: $url"
}

dump_debug() {
  printf '\n==> docker compose ps\n' >&2
  compose ps >&2 || true
  printf '\n==> access-api logs\n' >&2
  compose logs --tail=100 access-api access-lb >&2 || true
  printf '\n==> reporting-api logs\n' >&2
  compose logs --tail=100 reporting-api >&2 || true
  printf '\n==> kafka logs\n' >&2
  compose logs --tail=80 kafka-1 kafka-2 kafka-3 >&2 || true
}

cleanup() {
  if [[ "$E2E_CLEANUP" == "true" ]]; then
    compose down -v
  fi
}
trap cleanup EXIT

need docker
need curl
need python3

[[ -f .env ]] || {
  cat > .env <<'ENV'
POSTGRES_DB=access_control
POSTGRES_USER=root
POSTGRES_PASSWORD=ntu-cloudnative-ci
REDIS_PASSWORD=ntu-cloudnative-ci
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=ntu-cloudnative-ci
APP_SECRET_KEY=ntu-cloudnative-ci-secret
ENV
}

log "Starting Docker Compose E2E stack"
compose up -d --build \
  db \
  redis redis-replica-1 redis-replica-2 \
  redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 \
  kafka-1 kafka-2 kafka-3 \
  access-api access-lb \
  reporting-api

log "Waiting for Access API"
access_health="$(wait_url "Access API" "$ACCESS_URL/healthz" 90)"
printf '%s\n' "$access_health"
assert_json_field "$access_health" status ok

log "Waiting for Reporting API"
reporting_health="$(wait_url "Reporting API" "$REPORTING_URL/api/health/" 90)"
printf '%s\n' "$reporting_health"
assert_json_field "$reporting_health" status ok

log "Ensuring Kafka topic exists"
compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 3

log "Resetting test employee state"
curl -fsS -X POST "$ACCESS_URL/api/access/reset/$EMPLOYEE_ID" >/dev/null

log "Sending first IN swipe"
first_swipe="$(curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_E2E\",\"direction\":\"IN\"}")"
printf '%s\n' "$first_swipe"
assert_json_field "$first_swipe" decision GRANTED
assert_json_field "$first_swipe" eventBuffered true
assert_json_field "$first_swipe" employeeId "$EMPLOYEE_ID"

log "Waiting for Reporting API to expose the event"
event_found=false
for _ in $(seq 1 60); do
  events="$(curl -fsS "$REPORTING_URL/api/reports/access/events?employeeId=$EMPLOYEE_ID&limit=5")"
  if printf '%s\n' "$events" | grep -q "$EMPLOYEE_ID"; then
    event_found=true
    printf '%s\n' "$events"
    break
  fi
  sleep 1
done
[[ "$event_found" == "true" ]] || fail "Reporting API did not return employeeId=$EMPLOYEE_ID"

log "Sending duplicate IN swipe"
second_swipe="$(curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_E2E\",\"direction\":\"IN\"}")"
printf '%s\n' "$second_swipe"
assert_json_field "$second_swipe" decision DENIED
assert_json_field "$second_swipe" reason ANTI_PASSBACK_VIOLATION

log "Checking summary contains events"
summary="$(curl -fsS "$REPORTING_URL/api/reports/access/summary")"
printf '%s\n' "$summary"
total_events="$(json_field "$summary" totalEvents)"
if [[ "$total_events" -lt 1 ]]; then
  fail "expected totalEvents >= 1, got $total_events"
fi

log "Docker Compose E2E passed"
