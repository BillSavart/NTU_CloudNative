#!/usr/bin/env bash
# Run k6 against the prod VM FROM AN EXTERNAL MACHINE (your laptop), safely.
#
# Why: running k6 on the VM steals CPU from the services under test and skews
# the numbers. This drives load from outside instead. Nothing is exposed to the
# public internet: access-lb (8080) and Prometheus (9090) stay bound to
# 127.0.0.1 on the VM, and we reach them through encrypted SSH local-forward
# tunnels. k6 still remote-writes its metrics into the VM's Prometheus (through
# the second tunnel) so the existing Grafana k6 panels light up.
#
# Requires a native k6 binary on this machine (brew install k6) and SSH access
# to the VM.
#
# Usage:
#   VM_HOST=1.2.3.4 VM_USER=ubuntu DEPLOY_PATH=/opt/ntu_cloudnative \
#     ./scripts/k6_remote.sh constant   # test 1: hold 500 req/s for 10m
#     ./scripts/k6_remote.sh rampup     # test 2: climb to max, then ramp down to settle
#     ./scripts/k6_remote.sh chaos      # test 3: cut DB+Kafka, ramp to find max-under-
#                                       #         outage, ease down, verify backfill
#
# Common env: VM_SSH_KEY (path to key), LOCAL_ACCESS_PORT (18080),
#   LOCAL_PROM_PORT (19090), RATE, DURATION, TEST_ID.
# Ramp profile (rampup + chaos) is a STAIRCASE: each level is a quick ramp then
# a flat HOLD, so every step is a mini constant-rate run you can read for
# stability. All numeric SECONDS unless noted:
#   START_RATE, STEP, MAX_RATE                  -> the climb levels
#   RAMP_SECONDS                                -> quick transition onto each level
#   STEP_DURATION                               -> flat hold at each level
#   PEAK_HOLD                                   -> hold at the peak
#   DOWN_TO, DOWN_STEP, DOWN_STEP_DURATION      -> the stepped ramp-down
#   FLOOR_HOLD                                  -> hold at the floor to confirm it settles
# Chaos timing: CHAOS_START_DELAY (15), CHAOS_OUTAGE (auto: spans the ramp),
#   CHAOS_SETTLE (60).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VM_HOST="${VM_HOST:?set VM_HOST to the VM ssh host/IP}"
VM_USER="${VM_USER:?set VM_USER (ssh user on the VM)}"
DEPLOY_PATH="${DEPLOY_PATH:?set DEPLOY_PATH (repo path on the VM)}"
VM_SSH_KEY="${VM_SSH_KEY:-}"
LOCAL_ACCESS_PORT="${LOCAL_ACCESS_PORT:-18080}"
LOCAL_PROM_PORT="${LOCAL_PROM_PORT:-19090}"

MODE="${1:-}"
if [ -z "${MODE}" ]; then
  echo "Usage: $0 {constant|rampup|chaos}" >&2
  exit 2
fi

command -v k6 >/dev/null 2>&1 || { echo "ERROR: native k6 not found. Install it (e.g. brew install k6)." >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "ERROR: ssh required." >&2; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
[ -n "${VM_SSH_KEY}" ] && SSH_OPTS+=(-i "${VM_SSH_KEY}")
CTL_SOCK="$(mktemp -u "${TMPDIR:-/tmp}/k6tunnel.XXXXXX")"

CHAOS_ACTIVE=0
CHAOS_PREFIX=""

vm_ssh() { ssh "${SSH_OPTS[@]}" -S "${CTL_SOCK}" "${VM_USER}@${VM_HOST}" "$@"; }

# Prometheus is not always published on the VM host: in HTTPS mode
# (docker-compose.https.yml) it is reachable only behind Caddy, so 127.0.0.1:9090
# does not exist on the host. Its container is always reachable from the VM host
# via the docker bridge, though, so forward the tunnel straight to the container
# IP — this works in both plain-HTTP and HTTPS prod modes.
discover_prom_target() {
  ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" '
    cid=$(docker ps -q -f "label=com.docker.compose.service=prometheus" | head -1)
    [ -n "$cid" ] && docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$cid"
  ' 2>/dev/null | tr -d "[:space:]"
}

open_tunnels() {
  local prom_ip
  prom_ip="$(discover_prom_target)"
  if [ -z "${prom_ip}" ]; then
    echo "ERROR: could not locate the prometheus container on the VM (is the stack up?)." >&2
    return 1
  fi
  echo "==> Opening SSH tunnels to ${VM_HOST} (access:${LOCAL_ACCESS_PORT} -> 127.0.0.1:8080, prom:${LOCAL_PROM_PORT} -> ${prom_ip}:9090)"
  ssh "${SSH_OPTS[@]}" -fN -M -S "${CTL_SOCK}" \
    -L "${LOCAL_ACCESS_PORT}:127.0.0.1:8080" \
    -L "${LOCAL_PROM_PORT}:${prom_ip}:9090" \
    "${VM_USER}@${VM_HOST}"
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:${LOCAL_ACCESS_PORT}/ping" >/dev/null 2>&1 \
       && curl -fsS "http://localhost:${LOCAL_PROM_PORT}/-/healthy" >/dev/null 2>&1; then
      echo "    tunnels ready"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: tunnels did not become ready (check SSH access / that the stack is up)." >&2
  return 1
}

cleanup() {
  local code=$?
  # Always try to restore the VM if we were mid-chaos when something failed.
  if [ "${CHAOS_ACTIVE}" = "1" ]; then
    echo "==> Restoring DB + Kafka on the VM after interruption..." >&2
    vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh up" || true
  fi
  ssh "${SSH_OPTS[@]}" -S "${CTL_SOCK}" -O exit "${VM_USER}@${VM_HOST}" >/dev/null 2>&1 || true
  exit "${code}"
}
trap cleanup EXIT

# Shared k6 env: hit access-lb through the tunnel, remote-write to the VM's
# Prometheus through the other tunnel (native histograms, same as the in-VM k6).
export ACCESS_BASE_URL="http://localhost:${LOCAL_ACCESS_PORT}"
export K6_PROMETHEUS_RW_SERVER_URL="http://localhost:${LOCAL_PROM_PORT}/api/v1/write"
export K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM="true"

# Remove the access events / employees / Redis keys a throughput run wrote into
# the prod stack, so it does not pollute the live demo dashboards. Skip with
# K6_CLEANUP=false (e.g. when iterating on max-QPS and you want to keep the rows).
cleanup_prefix() {
  local prefix="$1"
  if [ "${K6_CLEANUP:-true}" != "true" ]; then
    echo "==> K6_CLEANUP=false — leaving test data (prefix ${prefix}) in place."
    return 0
  fi
  echo "==> Cleaning up test data (prefix ${prefix})..."
  vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh cleanup '${prefix}'" || true
}

# Build an "up -> peak hold -> stepped ramp-down -> floor hold" staircase for
# k6 ramping-arrival-rate, expressed as the STAGES env the k6 scripts consume
# ("rate:dur,rate:dur,..."). Sets two globals:
#   STAGES_STR             the comma-joined stage list
#   STAGES_TOTAL_SECONDS   total wall-clock duration of the whole profile
# All knobs are numeric SECONDS (no trailing s) and overridable via env.
build_stages() {
  local start="${START_RATE:-200}" step="${STEP:-200}" max="${MAX_RATE:-3000}"
  local ramp="${RAMP_SECONDS:-3}" hold="${STEP_DURATION:-20}" peak_hold="${PEAK_HOLD:-30}"
  local floor="${DOWN_TO:-800}" down_step="${DOWN_STEP:-400}" down_hold="${DOWN_STEP_DURATION:-20}"
  local floor_hold="${FLOOR_HOLD:-180}"
  local parts=() total=0 r h lvl
  # A real staircase: a quick `ramp` transition UP TO each level, then a FLAT
  # `hold` at that level. Each held step is effectively a mini constant-rate run,
  # so you can read whether the system sustains that exact QPS (failed ratio ~0,
  # p95 flat) — unlike a single-stage ramp that never holds any rate and so looks
  # "unstable" even well below the real ceiling.
  local levels=()
  for ((r = start; r < max; r += step)); do levels+=("$r"); done
  levels+=("$max")
  for lvl in "${levels[@]}"; do
    h=$hold; [ "$lvl" -eq "$max" ] && h=$peak_hold
    parts+=("${lvl}:${ramp}s" "${lvl}:${h}s"); total=$((total + ramp + h))
  done
  # Stepped ramp-DOWN, also holding each level so it can re-settle.
  for ((r = max - down_step; r > floor; r -= down_step)); do
    parts+=("${r}:${ramp}s" "${r}:${down_hold}s"); total=$((total + ramp + down_hold))
  done
  parts+=("${floor}:${ramp}s" "${floor}:${floor_hold}s"); total=$((total + ramp + floor_hold))
  STAGES_STR="$(IFS=,; echo "${parts[*]}")"
  STAGES_TOTAL_SECONDS="${total}"
}

run_constant() {
  open_tunnels
  local prefix="K6CONST$(date +%s)"
  echo "==> Test 1: constant ${RATE:-500} req/s for ${DURATION:-10m} against access-api"
  TEST_ID="${TEST_ID:-access-constant-500}" \
  K6_EXECUTOR="constant-arrival-rate" \
  RATE="${RATE:-500}" DURATION="${DURATION:-10m}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --out experimental-prometheus-rw observability/k6/access-throughput.js
  echo "==> Done. Filter Grafana by testid=${TEST_ID:-access-constant-500} over the run window."
  cleanup_prefix "${prefix}"
}

run_rampup() {
  open_tunnels
  local prefix="K6RAMP$(date +%s)"
  build_stages
  echo "==> Test 2: ramp ${START_RATE:-200} -> ${MAX_RATE:-3000} -> settle at ${DOWN_TO:-800} req/s (~$((STAGES_TOTAL_SECONDS / 60))m)"
  echo "    stages=${STAGES_STR}"
  TEST_ID="${TEST_ID:-access-rampup}" \
  K6_EXECUTOR="ramping-arrival-rate" \
  START_RATE="${START_RATE:-200}" STAGES="${STAGES_STR}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --out experimental-prometheus-rw observability/k6/access-throughput.js
  echo "==> Done. Max QPS = where 'k6 Requests/sec' plateaus and p95 / failed ratio climb on the way up;"
  echo "    the sustainable rate = the lowest ramp-down step where failed ratio returns to ~0 and p95 settles."
  cleanup_prefix "${prefix}"
}

run_chaos() {
  open_tunnels
  local prefix="K6CHAOS$(date +%s)"
  local summary; summary="$(mktemp)"
  # Chaos-tuned ramp defaults kept deliberately SMALL. Unlike the throughput
  # tests, chaos events (K6CHAOS prefix) ARE persisted to Postgres so the
  # backfill check stays verifiable — so a chaos run's total volume is bounded
  # to a few tens of thousands of events (drains in ~1-2 min) instead of
  # clogging the real reporting pipeline. Push these up only when you explicitly
  # want to probe the disconnected ceiling and can tolerate the backfill load.
  : "${MAX_RATE:=300}" "${START_RATE:=100}" "${STEP:=100}" "${STEP_DURATION:=10}" \
    "${PEAK_HOLD:=15}" "${DOWN_TO:=100}" "${DOWN_STEP:=100}" \
    "${DOWN_STEP_DURATION:=10}" "${FLOOR_HOLD:=20}"
  build_stages
  local start_delay="${CHAOS_START_DELAY:-15}"
  # Keep DB+Kafka down for the WHOLE ramp so the max QPS we read is genuinely the
  # disconnected ceiling; reconnect right as the k6 ramp ends, then backfill.
  local outage="${CHAOS_OUTAGE:-$((STAGES_TOTAL_SECONDS - start_delay))}"
  local settle="${CHAOS_SETTLE:-60}"
  CHAOS_PREFIX="${prefix}"

  echo "==> Test 3: chaos ramp (cut DB + Kafka, Redis stays up). prefix=${prefix}"
  echo "    ramp ${START_RATE:-200} -> ${MAX_RATE} -> settle at ${DOWN_TO}/s over ~$((STAGES_TOTAL_SECONDS / 60))m"
  echo "    start_delay=${start_delay}s outage=${outage}s settle=${settle}s"
  echo "    stages=${STAGES_STR}"

  TEST_ID="${TEST_ID:-chaos-db-kafka}" \
  K6_EXECUTOR="ramping-arrival-rate" \
  START_RATE="${START_RATE:-200}" STAGES="${STAGES_STR}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --summary-export="${summary}" \
      --out experimental-prometheus-rw observability/k6/access-chaos.js &
  local k6_pid=$!

  sleep "${start_delay}"
  echo "==> [t+${start_delay}s] Cutting DB + all Kafka brokers on the VM..."
  CHAOS_ACTIVE=1
  vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh down"

  echo "==> Outage in effect for ${outage}s — access-api keeps deciding via Redis"
  echo "    while k6 ramps up to find the max sustainable QPS, then eases back down."
  sleep "${outage}"

  echo "==> Restoring DB + Kafka on the VM..."
  vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh up"
  CHAOS_ACTIVE=0

  echo "==> Waiting for k6 workload to finish..."
  wait "${k6_pid}" || echo "    (k6 exited non-zero — expected if checks dipped during the outage)"

  echo "==> Waiting ${settle}s for the recovery consumer to drain Redis -> Postgres..."
  sleep "${settle}"

  local persisted buffered
  persisted="$(vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh count '${prefix}'" | tr -dc '0-9')"
  buffered="$(k6_summary_metric "${summary}" buffered_during_test)"

  echo ""
  echo "================= CHAOS RESULT ================="
  echo "  buffered during test (eventBuffered=true): ${buffered:-?}"
  echo "  persisted in Postgres (access_events):     ${persisted:-0}"
  if [ -n "${buffered:-}" ] && [ "${buffered}" != "?" ] && [ "${persisted:-0}" -ge "${buffered}" ] 2>/dev/null; then
    echo "  ✅ PASS: every buffered event was backfilled (persisted >= buffered)."
  else
    echo "  ⚠️  REVIEW: persisted (${persisted:-0}) < buffered (${buffered:-?})."
    echo "      Re-run with a larger CHAOS_SETTLE, or inspect the recovery consumer."
  fi
  echo "================================================"

  echo "==> Cleaning up test data (prefix ${prefix})..."
  vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh cleanup '${prefix}'" || true
  rm -f "${summary}"
}

# Pull a Counter's total out of a k6 --summary-export JSON file.
k6_summary_metric() {
  local file="$1" name="$2"
  python3 - "$file" "$name" <<'PY' 2>/dev/null || echo "?"
import json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
metric = data.get("metrics", {}).get(sys.argv[2], {})
print(int(metric.get("count", metric.get("value", 0))))
PY
}

case "${MODE}" in
  constant) run_constant ;;
  rampup)   run_rampup ;;
  chaos)    run_chaos ;;
  *) echo "Usage: $0 {constant|rampup|chaos}" >&2; exit 2 ;;
esac
