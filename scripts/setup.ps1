param(
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Show-Usage {
    @"
Usage:
  .\scripts\setup.ps1

Purpose:
  Build and start the full Docker Compose stack, wait for reporting-api
  migrations/health, clear existing reporting data, run a rollback-only
  smoke test, then clear reporting data again.
"@
}

function Invoke-Compose {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        & docker-compose @args
        if ($LASTEXITCODE -ne 0) {
            throw "docker-compose failed with exit code $LASTEXITCODE"
        }
        return
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        & docker compose @args
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose failed with exit code $LASTEXITCODE"
        }
        return
    }
    throw "Missing required command: docker-compose or docker compose"
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$Default = ""
    )

    $envValue = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        return $envValue
    }

    if (Test-Path ".env") {
        foreach ($line in Get-Content ".env") {
            if ($line -match "^\s*#" -or $line -match "^\s*$") {
                continue
            }
            if ($line -match "^\s*$([regex]::Escape($Name))=(.*)$") {
                return $Matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }

    return $Default
}

function Test-ReportingHealth {
    param([string]$Url)

    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Wait-ReportingApi {
    param([string]$Url)

    $healthy = $false
    foreach ($attempt in 1..60) {
        if (Test-ReportingHealth -Url $Url) {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) {
        Write-Error "reporting-api did not become healthy in time."
        Invoke-Compose logs --tail=80 reporting-api
        exit 1
    }
}

function Clear-ReportingData {
    param(
        [string]$PostgresUser,
        [string]$PostgresDb
    )

    $clearSql = @'
TRUNCATE TABLE
  access_events,
  user_department_scopes,
  user_accounts,
  employees,
  departments
RESTART IDENTITY CASCADE;
'@

    Invoke-Compose exec -T db psql -U $PostgresUser -d $PostgresDb -v "ON_ERROR_STOP=1" -c $clearSql
}

if ($Help) {
    Show-Usage
    exit 0
}

Push-Location $RootDir
try {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
        Write-Host "Created .env from .env.example. Update passwords before production use."
    }

    $postgresUser = Get-DotEnvValue -Name "POSTGRES_USER" -Default "root"
    $postgresDb = Get-DotEnvValue -Name "POSTGRES_DB" -Default "access_control"
    $reportingPort = Get-DotEnvValue -Name "REPORTING_HOST_PORT" -Default "8000"
    $reportingUrl = "http://127.0.0.1:$reportingPort/api/health/"

    Write-Host "Building Docker Compose images..."
    Invoke-Compose build

    Write-Host "Starting the full Docker Compose stack..."
    Invoke-Compose up -d

    Write-Host "Waiting for reporting-api migrations and health check..."
    Wait-ReportingApi -Url $reportingUrl

    Write-Host "Pausing reporting-api before database cleanup..."
    Invoke-Compose stop reporting-api

    Write-Host "Clearing existing reporting data before smoke test..."
    Clear-ReportingData -PostgresUser $postgresUser -PostgresDb $postgresDb

    Write-Host "Running rollback-only smoke test..."
    $smokeSql = @'
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
'@

    Invoke-Compose exec -T db psql -U $postgresUser -d $postgresDb -v "ON_ERROR_STOP=1" -c $smokeSql

    Write-Host "Clearing reporting data after smoke test..."
    Clear-ReportingData -PostgresUser $postgresUser -PostgresDb $postgresDb

    $countSql = @'
SELECT 'departments' AS table_name, count(*) FROM departments
UNION ALL SELECT 'employees', count(*) FROM employees
UNION ALL SELECT 'user_accounts', count(*) FROM user_accounts
UNION ALL SELECT 'user_department_scopes', count(*) FROM user_department_scopes
UNION ALL SELECT 'access_events', count(*) FROM access_events;
'@
    Invoke-Compose exec -T db psql -U $postgresUser -d $postgresDb -v "ON_ERROR_STOP=1" -c $countSql

    Write-Host "Restarting reporting-api after database cleanup..."
    Invoke-Compose up -d reporting-api
    Write-Host "Waiting for reporting-api after cleanup..."
    Wait-ReportingApi -Url $reportingUrl

    Write-Host "Setup completed. Full stack is running and reporting database tables are empty."
}
finally {
    Pop-Location
}
