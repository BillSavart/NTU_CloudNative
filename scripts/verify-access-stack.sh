#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
EMPLOYEE_ID="${EMPLOYEE_ID:-VERIFY001}"
TOPIC="${KAFKA_TOPIC:-access-events}"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
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

kafka_offset_sum() {
  docker-compose exec -T kafka-1 /opt/kafka/bin/kafka-get-offsets.sh \
    --bootstrap-server localhost:9092 \
    --topic "$TOPIC" |
    awk -F: '{sum += $3} END {print sum + 0}'
}

need docker-compose
need curl
need python3

cd "$ROOT_DIR"

log "Starting local access stack"
docker-compose up -d --scale access-api=3 access-lb

log "Container status"
docker-compose ps

log "Waiting for load balancer health"
for _ in {1..60}; do
  if health="$(curl -fsS "$BASE_URL/healthz" 2>/dev/null)"; then
    break
  fi
  sleep 2
done
[[ -n "${health:-}" ]] || fail "Access API health check did not become ready"
printf '%s\n' "$health"
assert_json_field "$health" status ok
assert_json_field "$health" redis ok

log "Checking load balancer reaches multiple Access API instances"
instances=()
for _ in {1..12}; do
  ping="$(curl -fsS "$BASE_URL/ping")"
  instance="$(json_field "$ping" instanceId)"
  [[ -n "$instance" ]] && instances+=("$instance")
done
unique_instances="$(printf '%s\n' "${instances[@]}" | sort -u | wc -l | tr -d ' ')"
printf 'Instances seen through LB: %s\n' "$(printf '%s ' "${instances[@]}")"
if [[ "$unique_instances" -lt 2 ]]; then
  fail "load balancer only reached $unique_instances Access API instance(s)"
fi

log "Checking Redis Sentinel master"
master="$(docker-compose exec -T redis-sentinel-1 redis-cli -p 26379 sentinel get-master-addr-by-name mymaster | tr '\r' ' ')"
printf '%s\n' "$master"
if ! printf '%s\n' "$master" | grep -q 'redis'; then
  fail "Redis Sentinel did not report redis as master"
fi

log "Checking Redis roles"
docker-compose exec -T redis redis-cli role
docker-compose exec -T redis-replica-1 redis-cli role
docker-compose exec -T redis-replica-2 redis-cli role

log "Creating Kafka topic if needed"
docker-compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 3

log "Checking Kafka topic replication"
topic_desc="$(docker-compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic "$TOPIC")"
printf '%s\n' "$topic_desc"
printf '%s\n' "$topic_desc" | grep -q 'PartitionCount: 3' || fail "Kafka topic does not have 3 partitions"
printf '%s\n' "$topic_desc" | grep -q 'ReplicationFactor: 3' || fail "Kafka topic does not have replication factor 3"

log "Recording Kafka offsets before fresh verification events"
offset_before="$(kafka_offset_sum)"
printf 'Kafka offset sum before: %s\n' "$offset_before"

log "Testing anti-passback flow"
curl -fsS -X POST "$BASE_URL/api/access/reset/$EMPLOYEE_ID" >/dev/null

entry_1="$(curl -fsS -X POST "$BASE_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_01\",\"direction\":\"IN\"}")"
printf 'First IN: %s\n' "$entry_1"
assert_json_field "$entry_1" decision GRANTED
assert_json_field "$entry_1" eventBuffered true

entry_2="$(curl -fsS -X POST "$BASE_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_01\",\"direction\":\"IN\"}")"
printf 'Second IN: %s\n' "$entry_2"
assert_json_field "$entry_2" decision DENIED
assert_json_field "$entry_2" reason ANTI_PASSBACK_VIOLATION

exit_1="$(curl -fsS -X POST "$BASE_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_01\",\"direction\":\"OUT\"}")"
printf 'OUT: %s\n' "$exit_1"
assert_json_field "$exit_1" decision GRANTED

log "Checking Redis state and mirrored events"
curl -fsS "$BASE_URL/api/access/state/$EMPLOYEE_ID"
printf '\n'
curl -fsS "$BASE_URL/api/access/events?limit=3"
printf '\n'

log "Checking Kafka offsets advanced"
sleep 2
offset_after="$(kafka_offset_sum)"
printf 'Kafka offset sum after: %s\n' "$offset_after"
offset_delta="$((offset_after - offset_before))"
if [[ "$offset_delta" -lt 3 ]]; then
  fail "Kafka offsets only advanced by $offset_delta; expected at least 3"
fi

log "Checking Access API metrics"
metrics="$(curl -fsS "$BASE_URL/metrics")"
printf '%s\n' "$metrics"
printf '%s\n' "$metrics" | grep -q 'access_api_events_dropped_total 0' || fail "Access API dropped events during smoke test"

log "Access stack verification passed"
