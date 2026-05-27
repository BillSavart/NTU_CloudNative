param(
    [Parameter(Mandatory = $true)]
    [string]$EmployeePrefix
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example. Update passwords before production use."
}

$envValues = @{}
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        $envValues[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
    }
}

$postgresUser = $envValues["POSTGRES_USER"]
$postgresDb = $envValues["POSTGRES_DB"]
if ([string]::IsNullOrWhiteSpace($postgresUser) -or [string]::IsNullOrWhiteSpace($postgresDb)) {
    throw "POSTGRES_USER and POSTGRES_DB must be set in .env"
}

Write-Host "Cleaning k6 load-test rows for employee prefix '$EmployeePrefix'..."

$sql = @"
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
"@
$sql | docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T db psql -U $postgresUser -d $postgresDb -v ON_ERROR_STOP=1 -v "prefix=$EmployeePrefix"

Write-Host "Cleaning Redis state, dedupe, and recovery stream entries for '$EmployeePrefix'..."

$lua = 'local stream = KEYS[1] local prefix = ARGV[1] local start = "-" local deleted = 0 while true do local rows = redis.call("XRANGE", stream, start, "+", "COUNT", 1000) if #rows == 0 then break end for _, row in ipairs(rows) do local id = row[1] local fields = row[2] for i = 1, #fields, 2 do if fields[i] == "employeeId" and string.sub(fields[i + 1], 1, string.len(prefix)) == prefix then redis.call("XDEL", stream, id) deleted = deleted + 1 break end end end local last_id = rows[#rows][1] start = "(" .. last_id end return deleted'
$redisScript = @"
export REDISCLI_AUTH="`$REDIS_PASSWORD"
redis-cli --scan --pattern "access:state:$EmployeePrefix*" | xargs -r redis-cli DEL >/dev/null
redis-cli --scan --pattern "access:event-buffered:$EmployeePrefix*" | xargs -r redis-cli DEL >/dev/null
redis-cli EVAL '$lua' 1 access:events '$EmployeePrefix'
"@
$redisScript | docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T redis sh

$verifySql = @"
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
"@
$verifySql | docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml exec -T db psql -U $postgresUser -d $postgresDb -v ON_ERROR_STOP=1 -v "prefix=$EmployeePrefix"
