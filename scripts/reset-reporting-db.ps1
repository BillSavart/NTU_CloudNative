param(
    [switch]$Yes,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Show-Usage {
    @"
Usage:
  .\scripts\reset-reporting-db.ps1 [-Yes]

Purpose:
  Clear Reporting API demo data so the next demo only shows newly generated access events.

Clears:
  - access_events
  - user_department_scopes
  - user_accounts
  - employees
  - departments
  - Redis Stream access:events
  - Redis event dedupe keys

Options:
  -Yes   Skip confirmation and clear data immediately
  -Help  Show this help
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

if ($Help) {
    Show-Usage
    exit 0
}

Push-Location $RootDir
try {
    if (-not $Yes) {
        Write-Host "This will clear PostgreSQL demo data and the Redis recovery buffer."
        $answer = Read-Host "Type yes to continue"
        if ($answer -ne "yes") {
            Write-Host "Cancelled."
            exit 0
        }
    }

    Invoke-Compose exec -T db psql -U root -d access_control -c "TRUNCATE TABLE access_events, user_department_scopes, user_accounts, employees, departments RESTART IDENTITY CASCADE;"

    $redisScript = @'
redis-cli -a "$REDIS_PASSWORD" DEL access:events >/dev/null
redis-cli -a "$REDIS_PASSWORD" --scan --pattern "access:event-buffered:*" |
while IFS= read -r key; do
  [ -n "$key" ] && redis-cli -a "$REDIS_PASSWORD" DEL "$key" >/dev/null
done
'@
    Invoke-Compose exec -T redis sh -c $redisScript

    Write-Host "Reporting demo database reset complete."
}
finally {
    Pop-Location
}
