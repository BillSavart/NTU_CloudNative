param(
    [int]$Vus = 20,
    [string]$RampUp = "30s",
    [string]$Steady = "2m",
    [string]$RampDown = "30s",
    [string]$LoginId = "rd_1_manager",
    [string]$LoginPassword = "demo123",
    [int]$P95ThresholdMs = 15000,
    [string]$TestId = "reporting-api-demo"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

$env:K6_VUS = "$Vus"
$env:K6_RAMP_UP = $RampUp
$env:K6_STEADY = $Steady
$env:K6_RAMP_DOWN = $RampDown
$env:K6_LOGIN_ID = $LoginId
$env:K6_LOGIN_PASSWORD = $LoginPassword
$env:K6_P95_THRESHOLD_MS = "$P95ThresholdMs"
$env:K6_TEST_ID = $TestId

docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d prometheus grafana reporting-api
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml --profile load-test run --rm k6
