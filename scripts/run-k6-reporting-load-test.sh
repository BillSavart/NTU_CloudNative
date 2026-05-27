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
: "${K6_TEST_ID:=reporting-api-demo}"

export K6_VUS K6_RAMP_UP K6_STEADY K6_RAMP_DOWN K6_LOGIN_ID K6_LOGIN_PASSWORD K6_P95_THRESHOLD_MS K6_TEST_ID

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d prometheus grafana reporting-api
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml --profile load-test run --rm k6
