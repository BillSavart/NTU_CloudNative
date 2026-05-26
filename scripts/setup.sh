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

clear_reporting_data() {
  docker-compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE TABLE
  access_events,
  user_department_scopes,
  user_accounts,
  employees,
  departments
RESTART IDENTITY CASCADE;
SQL
}

echo "Building Docker Compose images..."
docker-compose build

echo "Starting the full Docker Compose stack..."
docker-compose up -d

echo "Waiting for reporting-api migrations and health check..."
wait_for_reporting_api() {
  for attempt in $(seq 1 60); do
  if curl -fsS "$REPORTING_URL" >/dev/null; then
      return 0
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "reporting-api did not become healthy in time." >&2
    docker-compose logs --tail=80 reporting-api >&2
    exit 1
  fi
  sleep 2
  done
}

wait_for_reporting_api

echo "Pausing reporting-api before database cleanup..."
docker-compose stop reporting-api

echo "Clearing existing reporting data before smoke test..."
clear_reporting_data

echo "Running rollback-only smoke test..."
docker-compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
INSERT INTO departments (department_id, name)
VALUES ('__setup_smoke_dept__', 'Setup Smoke Department')
ON CONFLICT (department_id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO employees (
  employee_id,
  display_name,
  department_id,
  last_known_state
)
VALUES (
  '__setup_smoke_emp__',
  'Setup Smoke Employee',
  '__setup_smoke_dept__',
  'UNKNOWN'
)
ON CONFLICT (employee_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  department_id = EXCLUDED.department_id;

INSERT INTO access_events (
  request_id,
  employee_id,
  gate_id,
  direction,
  decision,
  reason,
  previous_state,
  current_state,
  latency_ms,
  remark,
  occurred_at
)
VALUES (
  '__setup_smoke_event__',
  '__setup_smoke_emp__',
  'gate_1_A',
  'IN',
  'GRANTED',
  'ACCESS_ALLOWED',
  'UNKNOWN',
  'IN',
  1,
  'rollback smoke test',
  now()
);
ROLLBACK;

DELETE FROM access_events WHERE request_id = '__setup_smoke_event__';
DELETE FROM employees WHERE employee_id = '__setup_smoke_emp__';
DELETE FROM departments WHERE department_id = '__setup_smoke_dept__';

SELECT
  (SELECT count(*) FROM access_events WHERE request_id = '__setup_smoke_event__') AS smoke_events,
  (SELECT count(*) FROM employees WHERE employee_id = '__setup_smoke_emp__') AS smoke_employees,
  (SELECT count(*) FROM departments WHERE department_id = '__setup_smoke_dept__') AS smoke_departments;
SQL

echo "Clearing reporting data after smoke test..."
clear_reporting_data

docker-compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'departments' AS table_name, count(*) FROM departments
UNION ALL SELECT 'employees', count(*) FROM employees
UNION ALL SELECT 'user_accounts', count(*) FROM user_accounts
UNION ALL SELECT 'user_department_scopes', count(*) FROM user_department_scopes
UNION ALL SELECT 'access_events', count(*) FROM access_events;
SQL

echo "Restarting reporting-api after database cleanup..."
docker-compose up -d reporting-api
echo "Waiting for reporting-api after cleanup..."
wait_for_reporting_api

echo "Setup completed. Full stack is running and reporting database tables are empty."
