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
#     ./scripts/k6_remote.sh constant   # test 1: hold 500 req/s for 5m
#     ./scripts/k6_remote.sh rampup     # test 2: climb until saturation
#     ./scripts/k6_remote.sh chaos      # test 3: cut DB+Kafka, verify backfill
#
# Common env: VM_SSH_KEY (path to key), LOCAL_ACCESS_PORT (18080),
#   LOCAL_PROM_PORT (19090), RATE, DURATION, START_RATE/STEP/STEP_DURATION/MAX_RATE,
#   CHAOS_START_DELAY (40), CHAOS_OUTAGE (45), CHAOS_SETTLE (30), TEST_ID.
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

run_constant() {
  open_tunnels
  local prefix="K6CONST$(date +%s)"
  echo "==> Test 1: constant ${RATE:-500} req/s for ${DURATION:-5m} against access-api"
  TEST_ID="${TEST_ID:-access-constant-500}" \
  K6_EXECUTOR="constant-arrival-rate" \
  RATE="${RATE:-500}" DURATION="${DURATION:-5m}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --out experimental-prometheus-rw observability/k6/access-throughput.js
  echo "==> Done. Filter Grafana by testid=${TEST_ID:-access-constant-500} over the run window."
  cleanup_prefix "${prefix}"
}

run_rampup() {
  open_tunnels
  local prefix="K6RAMP$(date +%s)"
  echo "==> Test 2: ramping arrival rate ${START_RATE:-100} -> ${MAX_RATE:-3000} req/s (step ${STEP:-200}/${STEP_DURATION:-30s})"
  TEST_ID="${TEST_ID:-access-rampup}" \
  K6_EXECUTOR="ramping-arrival-rate" \
  START_RATE="${START_RATE:-100}" STEP="${STEP:-200}" \
  STEP_DURATION="${STEP_DURATION:-30s}" MAX_RATE="${MAX_RATE:-3000}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --out experimental-prometheus-rw observability/k6/access-throughput.js
  echo "==> Done. Max QPS = where Grafana 'k6 Requests/sec' plateaus and p95 / failed ratio climb."
  cleanup_prefix "${prefix}"
}

run_chaos() {
  open_tunnels
  local prefix="K6CHAOS$(date +%s)"
  local summary; summary="$(mktemp)"
  local start_delay="${CHAOS_START_DELAY:-40}"
  local outage="${CHAOS_OUTAGE:-45}"
  local settle="${CHAOS_SETTLE:-30}"
  CHAOS_PREFIX="${prefix}"

  echo "==> Test 3: chaos (cut DB + Kafka, Redis stays up). prefix=${prefix}"
  echo "    rate=${RATE:-50}/s duration=${DURATION:-3m} start_delay=${start_delay}s outage=${outage}s settle=${settle}s"

  TEST_ID="${TEST_ID:-chaos-db-kafka}" \
  RATE="${RATE:-50}" DURATION="${DURATION:-3m}" \
  EMPLOYEE_PREFIX="${prefix}" \
    k6 run --summary-export="${summary}" \
      --out experimental-prometheus-rw observability/k6/access-chaos.js &
  local k6_pid=$!

  sleep "${start_delay}"
  echo "==> [t+${start_delay}s] Cutting DB + all Kafka brokers on the VM..."
  CHAOS_ACTIVE=1
  vm_ssh "cd '${DEPLOY_PATH}' && ./scripts/chaos_db_kafka_ctl.sh down"

  echo "==> Outage in effect for ${outage}s (access-api should keep deciding via Redis)..."
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
