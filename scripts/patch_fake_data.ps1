param(
    [int]$DeniedEvents = 0,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Show-Usage {
    @"
Usage:
  .\scripts\patch_fake_data.ps1 [-DeniedEvents 12000]

Purpose:
  Patch an existing fake-data database with missing supervisor attendance
  and realistic denied access events. The patch is idempotent and inserts
  events into existing historical dates instead of appending everything at
  the end.

Defaults:
  DeniedEvents 12000

The same value can also be supplied through PATCH_DENIED_EVENTS.
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
    $patchDeniedEvents = Get-PositiveIntSetting -Provided $DeniedEvents -EnvName "PATCH_DENIED_EVENTS" -Default 12000

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

    Write-Host "Patching fake data in PostgreSQL..."
    Invoke-Compose exec -T `
        -e "PATCH_DENIED_EVENTS=$patchDeniedEvents" `
        reporting-api python -m app.patch_fake_data

    Write-Host "Fake data patch completed."
}
finally {
    Pop-Location
}
