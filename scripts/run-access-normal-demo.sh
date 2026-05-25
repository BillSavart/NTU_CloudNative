#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"

EMPLOYEES="${EMPLOYEES:-90000}"
EMPLOYEE_PREFIX="${EMPLOYEE_PREFIX:-E${RUN_ID}}"
GATES="${GATES:-50}"
DURATION="${DURATION:-5m}"
TIME_SCALE="${TIME_SCALE:-1}"
WORKERS="${WORKERS:-200}"
INITIAL_INSIDE_RATIO="${INITIAL_INSIDE_RATIO:-0.35}"
DUPLICATE_PCT="${DUPLICATE_PCT:-0.005}"
PROGRESS_EVERY="${PROGRESS_EVERY:-5s}"

cd "$ROOT_DIR"

printf 'Starting access stack...\n'
docker-compose up -d --scale access-api=3 access-lb

printf '\nRunning normal access demo against %s\n' "$BASE_URL"
printf 'employees=%s prefix=%s gates=%s duration=%s timeScale=%s workers=%s initialInsideRatio=%s duplicatePct=%s\n' \
  "$EMPLOYEES" "$EMPLOYEE_PREFIX" "$GATES" "$DURATION" "$TIME_SCALE" "$WORKERS" "$INITIAL_INSIDE_RATIO" "$DUPLICATE_PCT"
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
    print(f"正常出入 demo 計時段：約 {real_seconds:.1f} 秒")
else:
    print("正常出入 demo 計時段：無法解析 duration，請看 simulator 輸出")
PY
printf 'initialInsideSetup=%s employees before timed demo\n' "$(python3 - "$EMPLOYEES" "$INITIAL_INSIDE_RATIO" <<'PY'
import sys
print(round(int(sys.argv[1]) * float(sys.argv[2])))
PY
)"
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
  --profile normal \
  --initial-inside-ratio "$INITIAL_INSIDE_RATIO" \
  --duplicate-pct "$DUPLICATE_PCT" \
  --progress-every "$PROGRESS_EVERY"

printf '\nAccess API metrics after normal demo:\n'
printf '(Note: this is one load-balanced Access API instance, not cluster-wide aggregated metrics.)\n'
sleep 3
curl -fsS "$BASE_URL/metrics"
printf '\n'
