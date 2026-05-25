#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCESS_URL="${ACCESS_URL:-http://localhost:8080}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
REPORTING_URL="${REPORTING_URL:-http://localhost:8000}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
TOPIC="${KAFKA_TOPIC:-access-events}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"
EMPLOYEE_ID="${EMPLOYEE_ID:-DEMO${RUN_ID}}"
RESET=true
BUILD=true

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/demo-local-oneclick.sh [--no-build] [--no-reset]

What it does:
  1. Ensures a local .env exists.
  2. Starts the full Docker Compose demo stack with observability and frontend.
  3. Waits for Access API, Reporting API, Prometheus, Grafana, and Dashboard.
  4. Resets and seeds demo accounts unless --no-reset is used.
  5. Sends a small access swipe flow and checks Reporting API can read it.
  6. Prints demo URLs, demo accounts, and the suggested presentation flow.

Options:
  --no-build   Reuse existing images.
  --no-reset   Keep existing reporting data and only run a smoke swipe.
  -h, --help   Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      BUILD=false
      shift
      ;;
    --no-reset)
      RESET=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

compose() {
  docker-compose -f docker-compose.yml -f observability/docker-compose.observability.yml "$@"
}

wait_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-90}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/tmp/demo-local-response.txt 2>/dev/null; then
      printf '%s ready: %s\n' "$name" "$url"
      return 0
    fi
    sleep 2
  done

  echo "$name did not become ready: $url" >&2
  compose ps >&2 || true
  exit 1
}

json_field() {
  local json="$1"
  local field="$2"
  python3 -c 'import json,sys; value=json.loads(sys.argv[1]).get(sys.argv[2], ""); print(value)' "$json" "$field"
}

ensure_env() {
  if [[ -f .env ]]; then
    return
  fi

  log "Creating local .env for demo"
  cat > .env <<'ENV'
POSTGRES_DB=access_control
POSTGRES_USER=root
POSTGRES_PASSWORD=imlab306
REDIS_PASSWORD=imlab306
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=imlab306
APP_SECRET_KEY=local-demo-secret
FRONTEND_HOST_PORT=5173
ENV
}

wait_for_reporting_event() {
  local employee_id="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "$REPORTING_URL/api/reports/access/events?employeeId=$employee_id&limit=5" | grep -q "$employee_id"; then
      return 0
    fi
    sleep 1
  done

  echo "Reporting API did not expose employeeId=$employee_id in time" >&2
  exit 1
}

need docker-compose
need curl
need python3
ensure_env

log "Starting full local demo stack"
up_args=(up -d)
if [[ "$BUILD" == true ]]; then
  up_args+=(--build)
fi
up_args+=(
  db
  redis redis-replica-1 redis-replica-2
  redis-sentinel-1 redis-sentinel-2 redis-sentinel-3
  kafka-1 kafka-2 kafka-3
  access-api access-lb
  reporting-api
  frontend
  prometheus grafana
  redis-exporter postgres-exporter kafka-exporter
)
compose "${up_args[@]}"

log "Waiting for services"
wait_url "Access API" "$ACCESS_URL/healthz"
wait_url "Reporting API" "$REPORTING_URL/api/health/"
wait_url "Dashboard" "$FRONTEND_URL/"
wait_url "Dashboard API proxy" "$FRONTEND_URL/api/health/"
wait_url "Prometheus" "$PROMETHEUS_URL/-/ready"
wait_url "Grafana" "$GRAFANA_URL/api/health"

log "Ensuring Kafka topic exists"
compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 3 >/dev/null

if [[ "$RESET" == true ]]; then
  log "Resetting and seeding demo data"
  ./scripts/reset-reporting-db.sh --yes
  ./scripts/seed-reporting-demo-data.sh
else
  log "Keeping existing reporting data"
fi

log "Running access swipe smoke test"
curl -fsS -X POST "$ACCESS_URL/api/access/reset/$EMPLOYEE_ID" >/dev/null

first_swipe="$(curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_DEMO\",\"direction\":\"IN\"}")"
second_swipe="$(curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_DEMO\",\"direction\":\"IN\"}")"
out_swipe="$(curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
  -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"$EMPLOYEE_ID\",\"gateId\":\"GATE_DEMO\",\"direction\":\"OUT\"}")"

printf 'First IN decision:  %s\n' "$(json_field "$first_swipe" decision)"
printf 'Second IN decision: %s\n' "$(json_field "$second_swipe" decision)"
printf 'OUT decision:       %s\n' "$(json_field "$out_swipe" decision)"

wait_for_reporting_event "$EMPLOYEE_ID"

log "Checking Prometheus targets"
curl -fsS "$PROMETHEUS_URL/api/v1/query?query=up" | python3 -c '
import json, sys
data = json.load(sys.stdin)["data"]["result"]
for item in data:
    print("{}: {}".format(item["metric"].get("job", "unknown"), item["value"][1]))
'

log "Local demo is ready"
cat <<EOF

Open these pages:
  Dashboard:          $FRONTEND_URL
  Reporting Health:   $REPORTING_URL/api/health/
  Prometheus Targets: $PROMETHEUS_URL/targets
  Grafana:            $GRAFANA_URL

Dashboard demo login:
  admin / demo123
  executive / demo123
  manager / demo123
  employee / demo123

Grafana login:
  admin / imlab306

Smoke-test employee:
  $EMPLOYEE_ID

Suggested demo flow:
  1. Open Dashboard and login as admin / demo123.
  2. Show Reporting API health.
  3. Explain Access API anti-passback with the smoke-test decisions above.
  4. Open Prometheus targets and show all jobs are up.
  5. Open Grafana dashboard: Dashboards -> NTU Cloud Native -> Access Control Observability.
  6. For a longer demo, run: ./scripts/demo-full-system.sh

EOF
