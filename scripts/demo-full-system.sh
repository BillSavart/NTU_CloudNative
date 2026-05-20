#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCESS_URL="${ACCESS_URL:-http://127.0.0.1:8080}"
REPORTING_URL="${REPORTING_URL:-http://127.0.0.1:8000}"
TOPIC="${KAFKA_TOPIC:-access-events}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"
FULL=false
REBUILD=true
CLEAN_ORPHANS=false

usage() {
  cat <<'USAGE'
用法：
  ./scripts/demo-full-system.sh [--full] [--no-build] [--clean-orphans]

流程：
  1. 啟動完整 Docker Compose stack
  2. 清空 PostgreSQL 報表資料與 Redis recovery buffer
  3. 執行基本 Anti-Passback 刷卡 demo
  4. 執行壓力測試
  5. 停 Reporting API 與 Kafka，模擬跨區網路/報表路徑中斷
  6. 在中斷期間刷卡，確認 Access API 仍用 local Redis 判斷並寫入 Redis Stream
  7. Kafka 保持中斷，只啟動 Reporting API，確認 Redis recovery 補回 PostgreSQL
  8. 恢復 Kafka 並顯示查詢指令

選項：
  --full           壓測改跑 90,000 人完整尖峰模擬
  --no-build       不重新 build image
  --clean-orphans  移除舊版 compose service 留下的 orphan containers
  -h, --help       顯示說明
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)
      FULL=true
      shift
      ;;
    --no-build)
      REBUILD=false
      shift
      ;;
    --clean-orphans)
      CLEAN_ORPHANS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知參數：$1" >&2
      usage
      exit 2
      ;;
  esac
done

log() {
  printf '\n========== %s ==========\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少必要指令：$1" >&2
    exit 1
  }
}

json_field() {
  local json="$1"
  local field="$2"
  python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$json" "$field"
}

wait_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-90}"
  local response=""

  for _ in $(seq 1 "$attempts"); do
    if response="$(curl -fsS "$url" 2>/dev/null)"; then
      printf '%s\n' "$response"
      return 0
    fi
    sleep 2
  done

  echo "$name did not become ready: $url" >&2
  return 1
}

wait_for_event_in_reporting() {
  local employee_id="$1"
  local attempts="${2:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$REPORTING_URL/api/reports/access/events?limit=200" | grep -q "$employee_id"; then
      return 0
    fi
    sleep 2
  done

  echo "Reporting API did not show recovered employeeId=$employee_id" >&2
  return 1
}

ensure_env() {
  [[ -f .env ]] || {
    echo "找不到 .env，請先 cp .env.example .env 並設定密碼。" >&2
    exit 1
  }
  if ! grep -q '^REDIS_PASSWORD=.' .env; then
    echo ".env 缺少 REDIS_PASSWORD，請先設定 Redis 密碼。" >&2
    exit 1
  fi
}

swipe() {
  local employee_id="$1"
  local gate_id="$2"
  local direction="$3"
  curl -fsS -X POST "$ACCESS_URL/api/access/swipe" \
    -H 'Content-Type: application/json' \
    -d "{\"employeeId\":\"$employee_id\",\"gateId\":\"$gate_id\",\"direction\":\"$direction\"}"
}

cd "$ROOT_DIR"

need docker-compose
need curl
need go
need python3
ensure_env

basic_employee="DEMO${RUN_ID}"
recovery_employee="REC${RUN_ID}"

if [[ "$FULL" == true ]]; then
  LOAD_EMPLOYEES="${EMPLOYEES:-90000}"
  LOAD_EMPLOYEE_PREFIX="${EMPLOYEE_PREFIX:-E${RUN_ID}}"
  LOAD_GATES="${GATES:-50}"
  LOAD_DURATION="${DURATION:-30m}"
  LOAD_TIME_SCALE="${TIME_SCALE:-10}"
  LOAD_WORKERS="${WORKERS:-200}"
  LOAD_PROGRESS_EVERY="${PROGRESS_EVERY:-3s}"
else
  LOAD_EMPLOYEES="${EMPLOYEES:-1000}"
  LOAD_EMPLOYEE_PREFIX="${EMPLOYEE_PREFIX:-LOAD${RUN_ID}}"
  LOAD_GATES="${GATES:-10}"
  LOAD_DURATION="${DURATION:-2m}"
  LOAD_TIME_SCALE="${TIME_SCALE:-120}"
  LOAD_WORKERS="${WORKERS:-50}"
  LOAD_PROGRESS_EVERY="${PROGRESS_EVERY:-3s}"
fi

log "1/9 啟動完整 stack"
compose_args=(up -d --scale access-api=3)
if [[ "$REBUILD" == true ]]; then
  compose_args+=(--build --force-recreate)
fi
if [[ "$CLEAN_ORPHANS" == true ]]; then
  compose_args+=(--remove-orphans)
fi
compose_args+=(
  db
  redis redis-replica-1 redis-replica-2
  redis-sentinel-1 redis-sentinel-2 redis-sentinel-3
  kafka-1 kafka-2 kafka-3
  access-api access-lb
  reporting-api
)
docker-compose "${compose_args[@]}"

log "2/9 等待服務健康"
access_health="$(wait_url "Access API" "$ACCESS_URL/healthz")"
printf 'Access API health: %s\n' "$access_health"
reporting_health="$(wait_url "Reporting API" "$REPORTING_URL/api/health/")"
printf 'Reporting API health: %s\n' "$reporting_health"

log "3/9 建立 Kafka topic"
docker-compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 3

log "4/9 清空舊 demo 資料"
./scripts/reset-reporting-db.sh --yes
DEMO_BASIC_EMPLOYEE_ID="$basic_employee" \
DEMO_RECOVERY_EMPLOYEE_ID="$recovery_employee" \
DEMO_LOAD_EMPLOYEE_PREFIX="$LOAD_EMPLOYEE_PREFIX" \
DEMO_LOAD_EMPLOYEES="$LOAD_EMPLOYEES" \
  ./scripts/seed-reporting-demo-data.sh

log "5/9 基本 Anti-Passback demo"
curl -fsS -X POST "$ACCESS_URL/api/access/reset/$basic_employee" >/dev/null

entry_1="$(swipe "$basic_employee" GATE_A IN)"
entry_2="$(swipe "$basic_employee" GATE_A IN)"
exit_1="$(swipe "$basic_employee" GATE_A OUT)"

printf 'First IN:  %s\n' "$entry_1"
printf 'Second IN: %s\n' "$entry_2"
printf 'OUT:       %s\n' "$exit_1"
printf 'Decisions: %s -> %s -> %s\n' \
  "$(json_field "$entry_1" decision)" \
  "$(json_field "$entry_2" decision)" \
  "$(json_field "$exit_1" decision)"
printf 'Local Redis buffered flags: %s, %s, %s\n' \
  "$(json_field "$entry_1" eventBuffered)" \
  "$(json_field "$entry_2" eventBuffered)" \
  "$(json_field "$exit_1" eventBuffered)"

sleep 3
printf 'Reporting summary after basic demo:\n'
curl -fsS "$REPORTING_URL/api/reports/access/summary"
printf '\n'

log "6/9 執行壓力測試"
if [[ "$FULL" == true ]]; then
  EMPLOYEES="$LOAD_EMPLOYEES" \
  EMPLOYEE_PREFIX="$LOAD_EMPLOYEE_PREFIX" \
  GATES="$LOAD_GATES" \
  DURATION="$LOAD_DURATION" \
  TIME_SCALE="$LOAD_TIME_SCALE" \
  WORKERS="$LOAD_WORKERS" \
  PROGRESS_EVERY="$LOAD_PROGRESS_EVERY" \
    ./scripts/run-access-load-test.sh --full
else
  EMPLOYEES="$LOAD_EMPLOYEES" \
  EMPLOYEE_PREFIX="$LOAD_EMPLOYEE_PREFIX" \
  GATES="$LOAD_GATES" \
  DURATION="$LOAD_DURATION" \
  TIME_SCALE="$LOAD_TIME_SCALE" \
  WORKERS="$LOAD_WORKERS" \
  PROGRESS_EVERY="$LOAD_PROGRESS_EVERY" \
    ./scripts/run-access-load-test.sh
fi

sleep 5
printf 'Reporting summary after load test:\n'
curl -fsS "$REPORTING_URL/api/reports/access/summary"
printf '\n'

log "7/9 模擬斷線：停 Reporting API 與 Kafka"
docker-compose stop reporting-api
docker-compose stop kafka-1 kafka-2 kafka-3

printf 'Reporting API and Kafka are stopped. Access API should still decide by local Redis.\n'
curl -fsS -X POST "$ACCESS_URL/api/access/reset/$recovery_employee" >/dev/null || true
recovery_swipe="$(swipe "$recovery_employee" GATE_RECOVERY IN)"
printf 'Recovery swipe during outage: %s\n' "$recovery_swipe"
printf 'Recovery decision=%s eventBuffered=%s kafkaQueued=%s\n' \
  "$(json_field "$recovery_swipe" decision)" \
  "$(json_field "$recovery_swipe" eventBuffered)" \
  "$(json_field "$recovery_swipe" kafkaQueued)"

log "8/9 Kafka 保持中斷，只啟動 Reporting API 驗證 Redis recovery"
docker-compose start reporting-api
wait_url "Reporting API" "$REPORTING_URL/api/health/"

printf 'Waiting for Redis recovery to write employeeId=%s into DB...\n' "$recovery_employee"
wait_for_event_in_reporting "$recovery_employee"

printf 'Recovered events:\n'
curl -fsS "$REPORTING_URL/api/reports/access/events?limit=20" | python3 -m json.tool

log "9/9 恢復 Kafka 並顯示最後狀態"
docker-compose start kafka-1 kafka-2 kafka-3
sleep 5

printf 'Access API health:\n'
curl -fsS "$ACCESS_URL/healthz"
printf '\n\nReporting API health:\n'
curl -fsS "$REPORTING_URL/api/health/"
printf '\n\nAccess metrics:\n'
curl -fsS "$ACCESS_URL/metrics"
printf '\n\nReporting summary:\n'
curl -fsS "$REPORTING_URL/api/reports/access/summary"
printf '\n'

cat <<EOF

Demo 完成。

可在 DBeaver 執行：
  SELECT * FROM access_events ORDER BY occurred_at DESC LIMIT 20;
  SELECT * FROM access_events WHERE employee_id = '$recovery_employee';

這次 recovery 測試重點：
  - Kafka 與 Reporting API 停止時，Access API 仍可用 local Redis 判斷開門。
  - response 的 eventBuffered=true 代表事件已先存到 local Redis Stream。
  - Kafka 尚未恢復時，只啟動 Reporting API 也能靠 redisRecovery 把資料補回 PostgreSQL。
EOF
