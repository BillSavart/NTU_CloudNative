#!/usr/bin/env bash
# Run a k6 load test against the RUNNING production stack (GCP VM).
#
# Prod counterpart of run-k6-full-stack-load-test.sh / run-k6-reporting-load-test.sh.
# The stack is already up (deploy.sh started it incl. the observability layer),
# so this does NOT bring services up — it just runs the profile-gated k6 service
# against them and cleans up its test rows.
#
# Pick the workload via K6_SCRIPT (default = full-stack):
#   ./scripts/k6_prod.sh                                  # full-stack
#   K6_SCRIPT=/scripts/reporting-api.js ./scripts/k6_prod.sh   # reporting-only
# Tune scale with the usual K6_* env (K6_VUS, K6_STEADY, K6_TEST_ID, ...).
#
# NOTE: load-testing the same box that serves the demo competes for CPU/RAM and
# will skew latencies — expected on a single 4 vCPU VM.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh   # sets COMPOSE, exports K6_COMPOSE_FILES for cleanup

: "${K6_VUS:=20}"
: "${K6_RAMP_UP:=30s}"
: "${K6_STEADY:=2m}"
: "${K6_RAMP_DOWN:=30s}"
: "${K6_LOGIN_ID:=rd_1_manager}"
: "${K6_LOGIN_PASSWORD:=demo123}"
: "${K6_P95_THRESHOLD_MS:=15000}"
: "${K6_TEST_ID:=full-stack-prod}"
: "${K6_EMPLOYEE_PREFIX:=K6$(date +%s)}"
: "${K6_GATES:=8}"
: "${K6_SCRIPT:=/scripts/full-stack.js}"
: "${K6_CLEANUP:=true}"
: "${K6_CLEANUP_SETTLE_SECONDS:=10}"
: "${K6_CLEANUP_PASSES:=3}"

export K6_VUS K6_RAMP_UP K6_STEADY K6_RAMP_DOWN
export K6_LOGIN_ID K6_LOGIN_PASSWORD K6_P95_THRESHOLD_MS K6_TEST_ID
export K6_EMPLOYEE_PREFIX K6_GATES K6_SCRIPT
export K6_ACCESS_VUS="${K6_ACCESS_VUS:-}"
export K6_REPORTING_VUS="${K6_REPORTING_VUS:-}"
export K6_FRONTEND_VUS="${K6_FRONTEND_VUS:-}"

cleanup_k6_data() {
  [ "${K6_CLEANUP}" = "true" ] && ./scripts/cleanup-k6-load-test-data.sh "${K6_EMPLOYEE_PREFIX}"
}

K6_HAS_RUN=false
cleanup_after_run() {
  exit_code=$?
  if [ "${K6_CLEANUP}" = "true" ] && [ "${K6_HAS_RUN}" = "true" ]; then
    echo "Waiting ${K6_CLEANUP_SETTLE_SECONDS}s for async Kafka/reporting writes before cleanup..."
    sleep "${K6_CLEANUP_SETTLE_SECONDS}"
    for pass in $(seq 1 "${K6_CLEANUP_PASSES}"); do
      echo "k6 cleanup pass ${pass}/${K6_CLEANUP_PASSES}..."
      cleanup_k6_data || true
      [ "${pass}" != "${K6_CLEANUP_PASSES}" ] && sleep 3
    done
  fi
  exit "${exit_code}"
}
trap cleanup_after_run EXIT

cleanup_k6_data
K6_HAS_RUN=true
"${COMPOSE[@]}" --profile load-test run --rm k6
