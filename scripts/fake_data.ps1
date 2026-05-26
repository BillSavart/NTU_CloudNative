param(
    [int]$EmployeeCount = 0,
    [int]$OperatingDays = 0,
    [int]$AttendanceEmployees = 0,
    [int]$MovementPct = -1,
    [int]$MaxMovesPerDay = 0,
    [switch]$IncludeWeekends,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Show-Usage {
    @"
Usage:
  .\scripts\fake_data.ps1 [-EmployeeCount 90000] [-OperatingDays 365] [-AttendanceEmployees 90000] [-MovementPct 18] [-MaxMovesPerDay 3] [-IncludeWeekends]

Purpose:
  Write fake TSMC company structure, users, employees, and historical
  attendance events into PostgreSQL. Data is intentionally kept in the DB.

Defaults:
  EmployeeCount       90000
  OperatingDays       365
  AttendanceEmployees 90000
  MovementPct         18
  MaxMovesPerDay      3
  IncludeWeekends     false

The same values can also be supplied through FAKE_EMPLOYEE_COUNT,
FAKE_OPERATING_DAYS, FAKE_ATTENDANCE_EMPLOYEES, FAKE_MOVEMENT_PCT,
FAKE_MAX_MOVES_PER_DAY, and FAKE_INCLUDE_WEEKENDS.
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

function Get-PositiveIntSetting {
    param(
        [int]$Provided,
        [string]$EnvName,
        [int]$Default
    )

    if ($Provided -gt 0) {
        return $Provided
    }

    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        $parsed = 0
        if ([int]::TryParse($envValue, [ref]$parsed) -and $parsed -gt 0) {
            return $parsed
        }
    }

    return $Default
}

function Get-PercentSetting {
    param(
        [int]$Provided,
        [string]$EnvName,
        [int]$Default
    )

    if ($Provided -ge 0) {
        return [Math]::Max(0, [Math]::Min(100, $Provided))
    }

    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        $parsed = 0
        if ([int]::TryParse($envValue, [ref]$parsed)) {
            return [Math]::Max(0, [Math]::Min(100, $parsed))
        }
    }

    return $Default
}

function Get-BoolSetting {
    param(
        [bool]$Provided,
        [string]$EnvName,
        [bool]$Default
    )

    if ($Provided) {
        return "true"
    }

    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        if ($envValue.Trim().ToLowerInvariant() -in @("1", "true", "yes", "y")) {
            return "true"
        }
        return "false"
    }

    if ($Default) {
        return "true"
    }
    return "false"
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

    $reportingPort = Get-DotEnvValue -Name "REPORTING_HOST_PORT" -Default "8000"
    $reportingUrl = "http://127.0.0.1:$reportingPort/api/health/"
    $fakeEmployeeCount = Get-PositiveIntSetting -Provided $EmployeeCount -EnvName "FAKE_EMPLOYEE_COUNT" -Default 90000
    $fakeOperatingDays = Get-PositiveIntSetting -Provided $OperatingDays -EnvName "FAKE_OPERATING_DAYS" -Default 365
    $fakeAttendanceEmployees = Get-PositiveIntSetting -Provided $AttendanceEmployees -EnvName "FAKE_ATTENDANCE_EMPLOYEES" -Default 90000
    $fakeMovementPct = Get-PercentSetting -Provided $MovementPct -EnvName "FAKE_MOVEMENT_PCT" -Default 18
    $fakeMaxMovesPerDay = Get-PositiveIntSetting -Provided $MaxMovesPerDay -EnvName "FAKE_MAX_MOVES_PER_DAY" -Default 3
    $fakeIncludeWeekends = Get-BoolSetting -Provided $IncludeWeekends.IsPresent -EnvName "FAKE_INCLUDE_WEEKENDS" -Default $false

    Write-Host "Building reporting-api image..."
    Invoke-Compose build reporting-api

    Write-Host "Starting reporting-api and dependencies..."
    Invoke-Compose up -d reporting-api

    Write-Host "Waiting for reporting-api..."
    $healthy = $false
    foreach ($attempt in 1..60) {
        if (Test-ReportingHealth -Url $reportingUrl) {
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

    Write-Host "Writing fake company data into PostgreSQL..."
    Invoke-Compose exec -T `
        -e "FAKE_EMPLOYEE_COUNT=$fakeEmployeeCount" `
        -e "FAKE_OPERATING_DAYS=$fakeOperatingDays" `
        -e "FAKE_ATTENDANCE_EMPLOYEES=$fakeAttendanceEmployees" `
        -e "FAKE_INCLUDE_WEEKENDS=$fakeIncludeWeekends" `
        -e "FAKE_MOVEMENT_PCT=$fakeMovementPct" `
        -e "FAKE_MAX_MOVES_PER_DAY=$fakeMaxMovesPerDay" `
        reporting-api python -m app.fake_data

    Write-Host "Fake data completed."
}
finally {
    Pop-Location
}
