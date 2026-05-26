#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Update passwords before production use."
fi

set -a
. ./.env
set +a

REPORTING_URL="http://127.0.0.1:${REPORTING_HOST_PORT:-8000}/api/health/"

echo "Building reporting-api image..."
docker-compose build reporting-api

echo "Starting reporting-api and dependencies..."
docker-compose up -d reporting-api

echo "Waiting for reporting-api..."
for attempt in $(seq 1 60); do
  if curl -fsS "$REPORTING_URL" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "reporting-api did not become healthy in time." >&2
    docker-compose logs --tail=80 reporting-api >&2
    exit 1
  fi
  sleep 2
done

echo "Writing fake company data into PostgreSQL..."
docker-compose exec -T \
  -e FAKE_EMPLOYEE_COUNT="${FAKE_EMPLOYEE_COUNT:-90000}" \
  -e FAKE_OPERATING_DAYS="${FAKE_OPERATING_DAYS:-365}" \
  -e FAKE_ATTENDANCE_EMPLOYEES="${FAKE_ATTENDANCE_EMPLOYEES:-90000}" \
  -e FAKE_INCLUDE_WEEKENDS="${FAKE_INCLUDE_WEEKENDS:-false}" \
  -e FAKE_MOVEMENT_PCT="${FAKE_MOVEMENT_PCT:-18}" \
  -e FAKE_MAX_MOVES_PER_DAY="${FAKE_MAX_MOVES_PER_DAY:-3}" \
  reporting-api python -m app.fake_data

echo "Fake data completed."
