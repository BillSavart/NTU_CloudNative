#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
TOPIC="${KAFKA_TOPIC:-access-events}"
FULL=false
REBUILD=false
CLEAN_ORPHANS=false

usage() {
  cat <<'USAGE'
用法：
  ./scripts/demo-access-api.sh [--full] [--rebuild] [--clean-orphans]

選項：
  --full           跑 90,000 人、50 扇門、30 分鐘尖峰模擬
  --rebuild        啟動前重新 build Access API image
  --clean-orphans  移除舊版 docker-compose service 留下的 orphan containers
  -h, --help       顯示說明

預設會跑小型壓測，適合 demo 前快速確認。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)
      FULL=true
      shift
      ;;
    --rebuild)
      REBUILD=true
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

need docker-compose
need curl
need go
need python3

cd "$ROOT_DIR"

log "1/7 啟動 Docker Compose access stack"
compose_args=(up -d --scale access-api=3 access-lb)
if [[ "$REBUILD" == true ]]; then
  compose_args=(up -d --build --scale access-api=3 access-lb)
fi
if [[ "$CLEAN_ORPHANS" == true ]]; then
  compose_args+=(--remove-orphans)
fi
docker-compose "${compose_args[@]}"

log "2/7 等待 Access API 健康"
for _ in {1..90}; do
  if health="$(curl -fsS "$BASE_URL/healthz" 2>/dev/null)"; then
    echo "$health"
    break
  fi
  sleep 2
done
if [[ -z "${health:-}" ]]; then
  echo "Access API 沒有在預期時間內啟動完成" >&2
  exit 1
fi

log "3/7 建立 Kafka topic"
docker-compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 3

log "4/7 執行完整 smoke test"
./scripts/verify-access-stack.sh

log "5/7 執行壓力測試"
if [[ "$FULL" == true ]]; then
  ./scripts/run-access-load-test.sh --full
else
  ./scripts/run-access-load-test.sh
fi

log "6/7 顯示目前容器狀態"
docker-compose ps

log "7/7 顯示常用檢查指令"
cat <<EOF
Access API：
  curl $BASE_URL/healthz
  curl $BASE_URL/metrics

最近 Redis mirror events：
  curl '$BASE_URL/api/access/events?limit=10'

Kafka topic 狀態：
  docker-compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic $TOPIC

讀 Kafka events：
  docker-compose exec kafka-1 /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic $TOPIC --from-beginning --max-messages 10

若看到 orphan container 警告，可下次加：
  ./scripts/demo-access-api.sh --clean-orphans
EOF

log "完成"
