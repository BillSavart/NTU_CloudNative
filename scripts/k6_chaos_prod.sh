#!/usr/bin/env bash
# Run the k6 CHAOS test against the RUNNING production stack (GCP VM).
#
# Prod counterpart of run-k6-chaos-test.sh: runs the full-stack workload, then
# briefly stops reporting-api and bounces one Kafka broker to exercise recovery,
# restores them, and cleans up. Uses the prod compose file list via lib-compose.
#
# ⚠️ This DELIBERATELY disrupts live services for ~20-25s each. Only run it when
# you are demonstrating resilience, not during an unrelated live demo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh   # sets COMPOSE, exports K6_COMPOSE_FILES for cleanup

: "${K6_VUS:=10}"
: "${K6_RAMP_UP:=20s}"
: "${K6_STEADY:=3m}"
: "${K6_RAMP_DOWN:=20s}"
: "${K6_LOGIN_ID:=rd_1_manager}"
: "${K6_LOGIN_PASSWORD:=demo123}"
: "${K6_P95_THRESHOLD_MS:=30000}"
: "${K6_FAILED_RATE_THRESHOLD:=0.35}"
: "${K6_CHECK_RATE_THRESHOLD:=0.60}"
: "${K6_TEST_ID:=chaos-prod}"
: "${K6_EMPLOYEE_PREFIX:=K6CHAOS$(date +%s)}"
: "${K6_GATES:=8}"
: "${K6_SCRIPT:=/scripts/full-stack.js}"
: "${K6_CLEANUP:=true}"
: "${K6_CLEANUP_SETTLE_SECONDS:=20}"
: "${K6_CLEANUP_PASSES:=5}"
: "${CHAOS_START_DELAY_SECONDS:=45}"
: "${CHAOS_REPORTING_DOWN_SECONDS:=25}"
: "${CHAOS_KAFKA_BROKER:=kafka-1}"
: "${CHAOS_KAFKA_DOWN_SECONDS:=20}"

export K6_VUS K6_RAMP_UP K6_STEADY K6_RAMP_DOWN
export K6_LOGIN_ID K6_LOGIN_PASSWORD K6_P95_THRESHOLD_MS K6_TEST_ID
export K6_EMPLOYEE_PREFIX K6_GATES K6_SCRIPT
export K6_FAILED_RATE_THRESHOLD K6_CHECK_RATE_THRESHOLD
export K6_ACCESS_VUS="${K6_ACCESS_VUS:-}"
export K6_REPORTING_VUS="${K6_REPORTING_VUS:-}"
export K6_FRONTEND_VUS="${K6_FRONTEND_VUS:-}"

K6_EXIT_CODE=0
K6_STARTED=false

cleanup_k6_data() {
  [ "${K6_CLEANUP}" = "true" ] && ./scripts/cleanup-k6-load-test-data.sh "${K6_EMPLOYEE_PREFIX}"
}

wait_for_reporting_api() {
  local url="http://127.0.0.1:${REPORTING_HOST_PORT:-8000}/api/health/"
  for _ in $(seq 1 60); do
    curl -fsS "${url}" >/dev/null && return 0
    sleep 2
  done
  echo "reporting-api did not become healthy after chaos recovery." >&2
  return 1
}

restore_and_cleanup() {
  exit_code=$?
  echo "Restoring chaos services..."
  "${COMPOSE[@]}" up -d "${CHAOS_KAFKA_BROKER}" reporting-api >/dev/null || true
  wait_for_reporting_api || true

  if [ "${K6_CLEANUP}" = "true" ] && [ "${K6_STARTED}" = "true" ]; then
    echo "Waiting ${K6_CLEANUP_SETTLE_SECONDS}s for async writes before cleanup..."
    sleep "${K6_CLEANUP_SETTLE_SECONDS}"
    for pass in $(seq 1 "${K6_CLEANUP_PASSES}"); do
      echo "chaos cleanup pass ${pass}/${K6_CLEANUP_PASSES}..."
      cleanup_k6_data || true
      [ "${pass}" != "${K6_CLEANUP_PASSES}" ] && sleep 5
    done
  fi

  if [ "${K6_STARTED}" = "true" ] && [ "${K6_EXIT_CODE}" -ne 0 ]; then
    exit "${K6_EXIT_CODE}"
  fi
  exit "${exit_code}"
}
trap restore_and_cleanup EXIT

wait_for_reporting_api
cleanup_k6_data

echo "Starting k6 chaos workload with prefix ${K6_EMPLOYEE_PREFIX}..."
"${COMPOSE[@]}" --profile load-test run --rm k6 &
K6_PID=$!
K6_STARTED=true

sleep "${CHAOS_START_DELAY_SECONDS}"

echo "Chaos: stopping reporting-api for ${CHAOS_REPORTING_DOWN_SECONDS}s..."
"${COMPOSE[@]}" stop reporting-api
sleep "${CHAOS_REPORTING_DOWN_SECONDS}"
echo "Chaos: restarting reporting-api..."
"${COMPOSE[@]}" up -d reporting-api
wait_for_reporting_api

echo "Chaos: bouncing ${CHAOS_KAFKA_BROKER} for ${CHAOS_KAFKA_DOWN_SECONDS}s..."
"${COMPOSE[@]}" stop "${CHAOS_KAFKA_BROKER}"
sleep "${CHAOS_KAFKA_DOWN_SECONDS}"
"${COMPOSE[@]}" up -d "${CHAOS_KAFKA_BROKER}"

set +e
wait "${K6_PID}"
K6_EXIT_CODE=$?
set -e

if [ "${K6_EXIT_CODE}" -ne 0 ]; then
  echo "k6 chaos workload exited with code ${K6_EXIT_CODE}; cleanup will still run." >&2
fi
