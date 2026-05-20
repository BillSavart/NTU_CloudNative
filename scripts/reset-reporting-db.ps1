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

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) {
        throw "Missing .env. Run: Copy-Item .env.example .env, then set passwords."
    }

    foreach ($line in Get-Content ".env") {
        if ($line -match "^\s*#") {
            continue
        }
        if ($line -match "^\s*$([regex]::Escape($Name))=(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }

    throw ".env is missing $Name."
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

    $redisPassword = Get-DotEnvValue "REDIS_PASSWORD"
    Invoke-Compose exec -T redis redis-cli -a $redisPassword DEL access:events | Out-Null

    $bufferedKeys = Invoke-Compose exec -T redis redis-cli -a $redisPassword --scan --pattern "access:event-buffered:*"
    foreach ($key in $bufferedKeys) {
        $trimmedKey = "$key".Trim()
        if ($trimmedKey) {
            Invoke-Compose exec -T redis redis-cli -a $redisPassword DEL $trimmedKey | Out-Null
        }
    }

    Write-Host "Reporting demo database reset complete."
}
finally {
    Pop-Location
}
