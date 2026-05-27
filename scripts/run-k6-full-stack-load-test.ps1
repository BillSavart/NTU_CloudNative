param(
    [int]$Vus = 20,
    [string]$RampUp = "30s",
    [string]$Steady = "2m",
    [string]$RampDown = "30s",
    [string]$LoginId = "rd_1_manager",
    [string]$LoginPassword = "demo123",
    [int]$P95ThresholdMs = 15000,
    [string]$TestId = "full-stack-demo",
    [string]$EmployeePrefix = "",
    [int]$Gates = 8,
    [int]$AccessVus = 0,
    [int]$ReportingVus = 0,
    [int]$FrontendVus = 0,
    [bool]$Cleanup = $true,
    [int]$CleanupSettleSeconds = 10,
    [int]$CleanupPasses = 3
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

if ([string]::IsNullOrWhiteSpace($EmployeePrefix)) {
    $EmployeePrefix = "K6$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

$env:K6_VUS = "$Vus"
$env:K6_RAMP_UP = $RampUp
$env:K6_STEADY = $Steady
$env:K6_RAMP_DOWN = $RampDown
$env:K6_LOGIN_ID = $LoginId
$env:K6_LOGIN_PASSWORD = $LoginPassword
$env:K6_P95_THRESHOLD_MS = "$P95ThresholdMs"
$env:K6_TEST_ID = $TestId
$env:K6_EMPLOYEE_PREFIX = $EmployeePrefix
$env:K6_GATES = "$Gates"
$env:K6_SCRIPT = "/scripts/full-stack.js"
$env:K6_ACCESS_VUS = $(if ($AccessVus -gt 0) { "$AccessVus" } else { "" })
$env:K6_REPORTING_VUS = $(if ($ReportingVus -gt 0) { "$ReportingVus" } else { "" })
$env:K6_FRONTEND_VUS = $(if ($FrontendVus -gt 0) { "$FrontendVus" } else { "" })

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d prometheus grafana frontend access-lb reporting-api
if ($Cleanup) {
    & (Join-Path $scriptDir "cleanup-k6-load-test-data.ps1") -EmployeePrefix $EmployeePrefix
}
try {
    docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml --profile load-test run --rm k6
}
finally {
    if ($Cleanup) {
        Write-Host "Waiting ${CleanupSettleSeconds}s for async Kafka/reporting writes before cleanup..."
        Start-Sleep -Seconds $CleanupSettleSeconds
        for ($pass = 1; $pass -le $CleanupPasses; $pass++) {
            Write-Host "k6 cleanup pass $pass/$CleanupPasses..."
            & (Join-Path $scriptDir "cleanup-k6-load-test-data.ps1") -EmployeePrefix $EmployeePrefix
            if ($pass -lt $CleanupPasses) {
                Start-Sleep -Seconds 3
            }
        }
    }
}
