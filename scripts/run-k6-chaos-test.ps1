param(
    [int]$Vus = 10,
    [string]$RampUp = "20s",
    [string]$Steady = "3m",
    [string]$RampDown = "20s",
    [string]$LoginId = "rd_1_manager",
    [string]$LoginPassword = "demo123",
    [int]$P95ThresholdMs = 30000,
    [double]$FailedRateThreshold = 0.35,
    [double]$CheckRateThreshold = 0.60,
    [string]$TestId = "chaos-demo",
    [string]$EmployeePrefix = "",
    [int]$Gates = 8,
    [int]$AccessVus = 0,
    [int]$ReportingVus = 0,
    [int]$FrontendVus = 0,
    [bool]$Cleanup = $true,
    [int]$CleanupSettleSeconds = 20,
    [int]$CleanupPasses = 5,
    [int]$ChaosStartDelaySeconds = 45,
    [int]$ReportingDownSeconds = 25,
    [string]$KafkaBroker = "kafka-1",
    [int]$KafkaDownSeconds = 20
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

if ([string]::IsNullOrWhiteSpace($EmployeePrefix)) {
    $EmployeePrefix = "K6CHAOS$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example. Update passwords before production use."
}

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml @Args
}

function Wait-ReportingApi {
    $reportingPort = "8000"
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^\s*REPORTING_HOST_PORT=(.*)$') {
            $script:reportingPort = $matches[1].Trim().Trim('"')
        }
    }
    $url = "http://127.0.0.1:$reportingPort/api/health/"
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
            return
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    throw "reporting-api did not become healthy after chaos recovery."
}

$env:K6_VUS = "$Vus"
$env:K6_RAMP_UP = $RampUp
$env:K6_STEADY = $Steady
$env:K6_RAMP_DOWN = $RampDown
$env:K6_LOGIN_ID = $LoginId
$env:K6_LOGIN_PASSWORD = $LoginPassword
$env:K6_P95_THRESHOLD_MS = "$P95ThresholdMs"
$env:K6_FAILED_RATE_THRESHOLD = "$FailedRateThreshold"
$env:K6_CHECK_RATE_THRESHOLD = "$CheckRateThreshold"
$env:K6_TEST_ID = $TestId
$env:K6_EMPLOYEE_PREFIX = $EmployeePrefix
$env:K6_GATES = "$Gates"
$env:K6_SCRIPT = "/scripts/full-stack.js"
$env:K6_ACCESS_VUS = $(if ($AccessVus -gt 0) { "$AccessVus" } else { "" })
$env:K6_REPORTING_VUS = $(if ($ReportingVus -gt 0) { "$ReportingVus" } else { "" })
$env:K6_FRONTEND_VUS = $(if ($FrontendVus -gt 0) { "$FrontendVus" } else { "" })

$k6ExitCode = 0
$k6Job = $null

try {
    Write-Host "Starting observability stack for chaos test..."
    Invoke-Compose up -d prometheus grafana frontend access-lb reporting-api $KafkaBroker
    Wait-ReportingApi
    if ($Cleanup) {
        & (Join-Path $scriptDir "cleanup-k6-load-test-data.ps1") -EmployeePrefix $EmployeePrefix
    }

    Write-Host "Starting k6 chaos workload with prefix $EmployeePrefix..."
    $k6Job = Start-Job -ScriptBlock {
        param($RootDir)
        Set-Location $RootDir
        docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml --profile load-test run --rm k6
    } -ArgumentList $rootDir

    Start-Sleep -Seconds $ChaosStartDelaySeconds

    Write-Host "Chaos: stopping reporting-api for ${ReportingDownSeconds}s..."
    Invoke-Compose stop reporting-api
    Start-Sleep -Seconds $ReportingDownSeconds
    Write-Host "Chaos: restarting reporting-api..."
    Invoke-Compose up -d reporting-api
    Wait-ReportingApi

    Write-Host "Chaos: restarting $KafkaBroker with ${KafkaDownSeconds}s outage..."
    Invoke-Compose stop $KafkaBroker
    Start-Sleep -Seconds $KafkaDownSeconds
    Invoke-Compose up -d $KafkaBroker

    Receive-Job -Job $k6Job -Wait
    if ($k6Job.State -ne "Completed") {
        $k6ExitCode = 1
    }
}
finally {
    Write-Host "Restoring chaos services..."
    try {
        Invoke-Compose up -d $KafkaBroker reporting-api | Out-Null
        Wait-ReportingApi
    } catch {
        Write-Warning $_
    }

    if ($Cleanup) {
        Write-Host "Waiting ${CleanupSettleSeconds}s for async Kafka/reporting writes before cleanup..."
        Start-Sleep -Seconds $CleanupSettleSeconds
        for ($pass = 1; $pass -le $CleanupPasses; $pass++) {
            Write-Host "chaos cleanup pass $pass/$CleanupPasses..."
            try {
                & (Join-Path $scriptDir "cleanup-k6-load-test-data.ps1") -EmployeePrefix $EmployeePrefix
            } catch {
                Write-Warning $_
            }
            if ($pass -lt $CleanupPasses) {
                Start-Sleep -Seconds 5
            }
        }
    }

    if ($null -ne $k6Job) {
        Remove-Job -Job $k6Job -Force -ErrorAction SilentlyContinue
    }
}

if ($k6ExitCode -ne 0) {
    exit $k6ExitCode
}
