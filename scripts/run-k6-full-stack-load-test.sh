#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

: "${K6_VUS:=20}"
: "${K6_RAMP_UP:=30s}"
: "${K6_STEADY:=2m}"
: "${K6_RAMP_DOWN:=30s}"
: "${K6_LOGIN_ID:=rd_1_manager}"
: "${K6_LOGIN_PASSWORD:=demo123}"
: "${K6_P95_THRESHOLD_MS:=15000}"
: "${K6_TEST_ID:=full-stack-demo}"
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
  if [ "${K6_CLEANUP}" = "true" ]; then
    ./scripts/cleanup-k6-load-test-data.sh "${K6_EMPLOYEE_PREFIX}"
  fi
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
      if [ "${pass}" != "${K6_CLEANUP_PASSES}" ]; then
        sleep 3
      fi
    done
  fi
  exit "${exit_code}"
}
trap cleanup_after_run EXIT

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d prometheus grafana frontend access-lb reporting-api
cleanup_k6_data
K6_HAS_RUN=true
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml --profile load-test run --rm k6
