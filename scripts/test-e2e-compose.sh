#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE=(docker compose)

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

set -a
. ./.env
set +a

ACCESS_URL="http://127.0.0.1:${ACCESS_HOST_PORT:-8080}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_HOST_PORT:-5173}"
REPORTING_URL="http://127.0.0.1:${REPORTING_HOST_PORT:-8000}"
TEST_EMPLOYEE_ID="E2E_COMPOSE_001"
TEST_GATE_ID="GATE_E2E"

cleanup() {
  if [ "${E2E_CLEANUP:-false}" = "true" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans
  fi
}
trap cleanup EXIT

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-90}"

  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null; then
      echo "$name is ready."
      return 0
    fi
    if [ "$attempt" -eq "$attempts" ]; then
      echo "$name did not become ready at $url" >&2
      "${COMPOSE[@]}" ps >&2 || true
      "${COMPOSE[@]}" logs --tail=120 "$name" >&2 || true
      return 1
    fi
    sleep 2
  done
}

echo "Building and starting Docker Compose stack..."
"${COMPOSE[@]}" up -d --build

wait_for_url access-api "$ACCESS_URL/healthz"
wait_for_url reporting-api "$REPORTING_URL/api/health/"
wait_for_url frontend "$FRONTEND_URL/"

echo "Resetting E2E test employee state..."
curl -fsS -X POST "$ACCESS_URL/api/access/reset/$TEST_EMPLOYEE_ID" >/dev/null

echo "Submitting E2E swipe..."
swipe_response="$(
  curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
    -H "Content-Type: application/json" \
    -d "{\"employeeId\":\"$TEST_EMPLOYEE_ID\",\"gateId\":\"$TEST_GATE_ID\",\"direction\":\"IN\"}"
)"

request_id="$(
  python -c 'import json,sys; print(json.load(sys.stdin)["requestId"])' <<<"$swipe_response"
)"

python -c '
import json
import sys

payload = json.load(sys.stdin)
if payload.get("decision") != "GRANTED":
    raise SystemExit("expected GRANTED decision, got {}".format(payload.get("decision")))
if not payload.get("eventBuffered"):
    raise SystemExit("expected eventBuffered=true")
if not payload.get("kafkaQueued"):
    raise SystemExit("expected kafkaQueued=true")
' <<<"$swipe_response"

echo "Waiting for Reporting API to persist request $request_id..."
for attempt in $(seq 1 60); do
  events_response="$(
    curl -fsS "$REPORTING_URL/api/reports/access/events?employeeId=$TEST_EMPLOYEE_ID&limit=10"
  )"
  if EVENTS_RESPONSE="$events_response" python - "$request_id" <<'PY'
import json
import os
import sys

expected_request_id = sys.argv[1]
payload = json.loads(os.environ["EVENTS_RESPONSE"])
events = payload.get("events") or payload.get("items") or []
sys.exit(0 if any(event.get("requestId") == expected_request_id for event in events) else 1)
PY
  then
    echo "E2E swipe was persisted by Reporting API."
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for Reporting API to persist request $request_id" >&2
"${COMPOSE[@]}" logs --tail=120 access-api reporting-api >&2 || true
exit 1
