#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PREFIX="${1:-${K6_EMPLOYEE_PREFIX:-}}"
if [ -z "${PREFIX}" ]; then
  echo "Usage: $0 <employee-prefix>" >&2
  exit 2
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Update passwords before production use."
fi

set -a
. ./.env
set +a

echo "Cleaning k6 load-test rows for employee prefix '${PREFIX}'..."

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T db \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -v prefix="${PREFIX}" <<'SQL'
WITH deleted_events AS (
  DELETE FROM access_events
  WHERE employee_id LIKE :'prefix' || '%'
  RETURNING 1
),
deleted_employees AS (
  DELETE FROM employees e
  WHERE e.employee_id LIKE :'prefix' || '%'
    AND NOT EXISTS (
      SELECT 1
      FROM access_events ae
      WHERE ae.employee_id = e.employee_id
    )
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM deleted_events) AS deleted_access_events,
  (SELECT count(*) FROM deleted_employees) AS deleted_employees;
SQL

echo "Cleaning Redis state, dedupe, and recovery stream entries for '${PREFIX}'..."

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T redis \
  sh -c 'export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli --scan --pattern "access:state:'"${PREFIX}"'*" | xargs -r redis-cli DEL >/dev/null'

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T redis \
  sh -c 'export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli --scan --pattern "access:event-buffered:'"${PREFIX}"'*" | xargs -r redis-cli DEL >/dev/null'

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T redis \
  sh -c 'export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli EVAL "
local stream = KEYS[1]
local prefix = ARGV[1]
local start = \"-\"
local deleted = 0
while true do
  local rows = redis.call(\"XRANGE\", stream, start, \"+\", \"COUNT\", 1000)
  if #rows == 0 then
    break
  end
  for _, row in ipairs(rows) do
    local id = row[1]
    local fields = row[2]
    for i = 1, #fields, 2 do
      if fields[i] == \"employeeId\" and string.sub(fields[i + 1], 1, string.len(prefix)) == prefix then
        redis.call(\"XDEL\", stream, id)
        deleted = deleted + 1
        break
      end
    end
  end
  local last_id = rows[#rows][1]
  start = \"(\" .. last_id
end
return deleted
" 1 access:events "'"${PREFIX}"'"'

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T db \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -v prefix="${PREFIX}" <<'SQL'
SELECT
  (SELECT count(*) FROM access_events WHERE employee_id LIKE :'prefix' || '%') AS remaining_access_events,
  (SELECT count(*) FROM employees WHERE employee_id LIKE :'prefix' || '%') AS remaining_employees,
  (SELECT count(*)
   FROM employees e
   WHERE e.employee_id LIKE :'prefix' || '%'
     AND EXISTS (
       SELECT 1
       FROM access_events ae
       WHERE ae.employee_id = e.employee_id
     )) AS employees_waiting_for_late_events;
SQL
