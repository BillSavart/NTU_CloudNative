#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
FULL=false
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"

if [[ "${1:-}" == "--full" ]]; then
  FULL=true
fi

if [[ "$FULL" == true ]]; then
  EMPLOYEES="${EMPLOYEES:-90000}"
  EMPLOYEE_PREFIX="${EMPLOYEE_PREFIX:-E${RUN_ID}}"
  GATES="${GATES:-50}"
  DURATION="${DURATION:-30m}"
  TIME_SCALE="${TIME_SCALE:-10}"
  WORKERS="${WORKERS:-200}"
  ENTRY_RATIO="${ENTRY_RATIO:-0.995}"
  DUPLICATE_PCT="${DUPLICATE_PCT:-0.005}"
else
  EMPLOYEES="${EMPLOYEES:-1000}"
  EMPLOYEE_PREFIX="${EMPLOYEE_PREFIX:-LOAD${RUN_ID}}"
  GATES="${GATES:-10}"
  DURATION="${DURATION:-2m}"
  TIME_SCALE="${TIME_SCALE:-120}"
  WORKERS="${WORKERS:-50}"
  ENTRY_RATIO="${ENTRY_RATIO:-0.995}"
  DUPLICATE_PCT="${DUPLICATE_PCT:-0.005}"
fi
PROGRESS_EVERY="${PROGRESS_EVERY:-3s}"

cd "$ROOT_DIR"

printf 'Starting access stack...\n'
docker-compose up -d --scale access-api=3 access-lb

printf '\nRunning swipe simulator against %s\n' "$BASE_URL"
printf 'employees=%s prefix=%s gates=%s duration=%s timeScale=%s workers=%s entryRatio=%s duplicatePct=%s\n' \
  "$EMPLOYEES" "$EMPLOYEE_PREFIX" "$GATES" "$DURATION" "$TIME_SCALE" "$WORKERS" "$ENTRY_RATIO" "$DUPLICATE_PCT"
python3 - "$DURATION" "$TIME_SCALE" <<'PY'
import re
import sys

duration = sys.argv[1]
scale = float(sys.argv[2])
match = re.fullmatch(r"(\d+(?:\.\d+)?)([smh])", duration)
if match:
    value = float(match.group(1))
    unit = match.group(2)
    seconds = value * {"s": 1, "m": 60, "h": 3600}[unit]
    real_seconds = seconds / scale
    print(f"預估實際執行時間：約 {real_seconds:.1f} 秒")
else:
    print("預估實際執行時間：無法解析 duration，請看 simulator 輸出")
PY
printf 'progressEvery=%s\n' "$PROGRESS_EVERY"

printf '\nSeeding reporting employees for this demo prefix...\n'
DEMO_LOAD_EMPLOYEE_PREFIX="$EMPLOYEE_PREFIX" \
DEMO_LOAD_EMPLOYEES="$EMPLOYEES" \
  ./scripts/seed-reporting-demo-data.sh >/dev/null

cd "$ROOT_DIR/access-api"
GOCACHE="${GOCACHE:-/private/tmp/ntu-cloudnative-go-build}" go run ./cmd/swipe-simulator \
  --base-url "$BASE_URL" \
  --employees "$EMPLOYEES" \
  --employee-prefix "$EMPLOYEE_PREFIX" \
  --gates "$GATES" \
  --duration "$DURATION" \
  --time-scale "$TIME_SCALE" \
  --workers "$WORKERS" \
  --entry-ratio "$ENTRY_RATIO" \
  --duplicate-pct "$DUPLICATE_PCT" \
  --progress-every "$PROGRESS_EVERY"

printf '\nAccess API metrics after load test:\n'
printf '(Note: this is one load-balanced Access API instance, not cluster-wide aggregated metrics.)\n'
sleep 3
curl -fsS "$BASE_URL/metrics"
printf '\n'
