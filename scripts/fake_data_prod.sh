#!/usr/bin/env bash
# Load fake company data into the RUNNING production stack (GCP VM).
#
# Unlike scripts/fake_data.sh (local: builds + starts a base-compose stack),
# this execs `python -m app.fake_data` inside the already-running reporting-api
# container of the prod stack — no rebuild, no config reconverge.
#
# Run once after the first deploy + `python -m app.seed`. Data persists in the
# pgdata volume across stop/start and redeploys.
#
# Tune the volume via env, e.g. a lighter set for a snappier demo:
#   FAKE_OPERATING_DAYS=90 FAKE_ATTENDANCE_EMPLOYEES=20000 ./scripts/fake_data_prod.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh

echo "Writing fake company data into PostgreSQL (this can take a while on a 4 vCPU box)..."
"${COMPOSE[@]}" exec -T \
  -e FAKE_EMPLOYEE_COUNT="${FAKE_EMPLOYEE_COUNT:-90000}" \
  -e FAKE_OPERATING_DAYS="${FAKE_OPERATING_DAYS:-365}" \
  -e FAKE_ATTENDANCE_EMPLOYEES="${FAKE_ATTENDANCE_EMPLOYEES:-90000}" \
  -e FAKE_INCLUDE_WEEKENDS="${FAKE_INCLUDE_WEEKENDS:-false}" \
  -e FAKE_MOVEMENT_PCT="${FAKE_MOVEMENT_PCT:-18}" \
  -e FAKE_MAX_MOVES_PER_DAY="${FAKE_MAX_MOVES_PER_DAY:-3}" \
  reporting-api python -m app.fake_data

echo "Fake data completed."
