param(
    [switch]$Full,
    [switch]$NoBuild,
    [switch]$CleanOrphans,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AccessUrl = if ($env:ACCESS_URL) { $env:ACCESS_URL } else { "http://127.0.0.1:8080" }
$ReportingUrl = if ($env:REPORTING_URL) { $env:REPORTING_URL } else { "http://127.0.0.1:8000" }
$Topic = if ($env:KAFKA_TOPIC) { $env:KAFKA_TOPIC } else { "access-events" }
$RunId = if ($env:RUN_ID) { $env:RUN_ID } else { Get-Date -Format "yyyyMMddHHmmss" }

function Show-Usage {
    @"
Usage:
  .\scripts\demo-full-system.ps1 [-Full] [-NoBuild] [-CleanOrphans]

Flow:
  1. Start the full Docker Compose stack
  2. Clear PostgreSQL report data and Redis recovery buffer
  3. Run the basic Anti-Passback swipe demo
  4. Run the load test
  5. Stop Reporting API and Kafka to simulate report path/network outage
  6. Swipe during the outage and confirm Access API still uses local Redis
  7. Keep Kafka down, start Reporting API, and verify Redis recovery writes back to PostgreSQL
  8. Restore Kafka and print useful inspection commands

Options:
  -Full          Use the 90,000 employee full peak simulation
  -NoBuild       Do not rebuild images
  -CleanOrphans  Remove orphan containers from older docker-compose services
  -Help          Show this help
"@
}

function Write-Section([string]$Message) {
    Write-Host ""
    Write-Host "========== $Message =========="
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
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

function Get-HttpErrorBody($ErrorRecord) {
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }
    $responseProperty = $ErrorRecord.Exception.PSObject.Properties["Response"]
    if (-not $responseProperty) {
        return ""
    }
    $response = $responseProperty.Value
    if (-not $response) {
        return ""
    }
    try {
        $stream = $response.GetResponseStream()
        if (-not $stream) {
            return ""
        }
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    }
    catch {
        return ""
    }
}

function Invoke-Http([string]$Method, [string]$Url, [AllowNull()][object]$Body = $null, [string]$ContentType = $null) {
    $params = @{
        Method          = $Method
        Uri             = $Url
        UseBasicParsing = $true
        Proxy           = $null
    }
    if ($null -ne $Body -and "$Body" -ne "") {
        $params.Body = $Body
    }
    if ($ContentType) {
        $params.ContentType = $ContentType
    }

    try {
        $response = Invoke-WebRequest @params
        return $response.Content
    }
    catch {
        $bodyText = Get-HttpErrorBody $_
        if ($bodyText) {
            throw "HTTP $Method $Url failed. Response body: $bodyText"
        }
        throw "HTTP $Method $Url failed. $($_.Exception.Message)"
    }
}

function Get-JsonField([string]$Json, [string]$Field) {
    $object = $Json | ConvertFrom-Json
    $property = $object.PSObject.Properties[$Field]
    if (-not $property) {
        return ""
    }
    $value = $property.Value
    if ($value -is [bool]) {
        return $value.ToString().ToLowerInvariant()
    }
    return [string]$value
}

function Wait-Url([string]$Name, [string]$Url, [int]$Attempts = 90) {
    $lastError = ""
    for ($i = 0; $i -lt $Attempts; $i++) {
        try {
            return Invoke-Http "GET" $Url
        }
        catch {
            $lastError = $_.Exception.Message
            if (($i % 5) -eq 0) {
                Write-Host "Waiting for $Name at $Url ($($i + 1)/$Attempts): $lastError"
            }
            Start-Sleep -Seconds 2
        }
    }
    Write-Host ""
    Write-Host "Container status while waiting for ${Name}:"
    try {
        Invoke-Compose ps
    }
    catch {
        Write-Host "Could not read docker compose status: $($_.Exception.Message)"
    }
    throw "$Name did not become ready: $Url. Last error: $lastError"
}

function Wait-ForEventInReporting([string]$EmployeeId, [int]$Attempts = 60) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        try {
            $events = Invoke-Http "GET" "$ReportingUrl/api/reports/access/events?limit=200"
            if ($events -match [regex]::Escape($EmployeeId)) {
                return
            }
        }
        catch {
        }
        Start-Sleep -Seconds 2
    }
    throw "Reporting API did not show recovered employeeId=$EmployeeId"
}

function Assert-EnvFile {
    if (-not (Test-Path ".env")) {
        throw "Missing .env. Run: Copy-Item .env.example .env, then set passwords."
    }
    $envFile = Get-Content ".env"
    if (-not ($envFile | Where-Object { $_ -match '^REDIS_PASSWORD=.' })) {
        throw ".env is missing REDIS_PASSWORD. Please set a Redis password first."
    }
}

function Invoke-Swipe([string]$EmployeeId, [string]$GateId, [string]$Direction) {
    $body = @{ employeeId = $EmployeeId; gateId = $GateId; direction = $Direction } | ConvertTo-Json -Compress
    Invoke-Http "POST" "$AccessUrl/api/access/swipe" $body "application/json"
}

if ($Help) {
    Show-Usage
    exit 0
}

Assert-Command go

Push-Location $RootDir
try {
    Assert-EnvFile

    Write-Section "1/9 Start full stack"
    $composeArgs = @("up", "-d", "--scale", "access-api=3")
    if (-not $NoBuild) {
        $composeArgs += @("--build", "--force-recreate")
    }
    if ($CleanOrphans) {
        $composeArgs += "--remove-orphans"
    }
    $composeArgs += @(
        "db",
        "redis", "redis-replica-1", "redis-replica-2",
        "redis-sentinel-1", "redis-sentinel-2", "redis-sentinel-3",
        "kafka-1", "kafka-2", "kafka-3",
        "access-api", "access-lb",
        "reporting-api"
    )
    Invoke-Compose @composeArgs

    Write-Section "2/9 Wait for services"
    $accessHealth = Wait-Url "Access API" "$AccessUrl/healthz"
    Write-Host "Access API health: $accessHealth"
    $reportingHealth = Wait-Url "Reporting API" "$ReportingUrl/api/health/"
    Write-Host "Reporting API health: $reportingHealth"

    Write-Section "3/9 Create Kafka topic"
    Invoke-Compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic $Topic --partitions 3 --replication-factor 3

    Write-Section "4/9 Clear old demo data"
    & (Join-Path $PSScriptRoot "reset-reporting-db.ps1") -Yes
    & (Join-Path $PSScriptRoot "seed-reporting-demo-data.ps1")

    Write-Section "5/9 Basic Anti-Passback demo"
    $basicEmployee = "DEMO$RunId"
    try {
        Invoke-Http "POST" "$AccessUrl/api/access/reset/$basicEmployee" | Out-Null
    }
    catch {
        Write-Host "Warning: reset failed for $basicEmployee; continuing because this demo id is unique for this run."
    }

    $entry1 = Invoke-Swipe $basicEmployee "GATE_A" "IN"
    $entry2 = Invoke-Swipe $basicEmployee "GATE_A" "IN"
    $exit1 = Invoke-Swipe $basicEmployee "GATE_A" "OUT"

    Write-Host "First IN:  $entry1"
    Write-Host "Second IN: $entry2"
    Write-Host "OUT:       $exit1"
    Write-Host ("Decisions: {0} -> {1} -> {2}" -f (Get-JsonField $entry1 "decision"), (Get-JsonField $entry2 "decision"), (Get-JsonField $exit1 "decision"))
    Write-Host ("Local Redis buffered flags: {0}, {1}, {2}" -f (Get-JsonField $entry1 "eventBuffered"), (Get-JsonField $entry2 "eventBuffered"), (Get-JsonField $exit1 "eventBuffered"))

    Start-Sleep -Seconds 3
    Write-Host "Reporting summary after basic demo:"
    Invoke-Http "GET" "$ReportingUrl/api/reports/access/summary"
    Write-Host ""

    Write-Section "6/9 Run load test"
    if ($Full) {
        & (Join-Path $PSScriptRoot "run-access-load-test.ps1") -Full
    }
    else {
        if (-not $env:EMPLOYEES) { $env:EMPLOYEES = "1000" }
        if (-not $env:EMPLOYEE_PREFIX) { $env:EMPLOYEE_PREFIX = "LOAD$RunId" }
        if (-not $env:GATES) { $env:GATES = "10" }
        if (-not $env:DURATION) { $env:DURATION = "2m" }
        if (-not $env:TIME_SCALE) { $env:TIME_SCALE = "120" }
        if (-not $env:WORKERS) { $env:WORKERS = "50" }
        if (-not $env:PROGRESS_EVERY) { $env:PROGRESS_EVERY = "3s" }
        & (Join-Path $PSScriptRoot "run-access-load-test.ps1")
    }

    Start-Sleep -Seconds 5
    Write-Host "Reporting summary after load test:"
    Invoke-Http "GET" "$ReportingUrl/api/reports/access/summary"
    Write-Host ""

    Write-Section "7/9 Simulate outage: stop Reporting API and Kafka"
    $recoveryEmployee = "REC$RunId"
    Invoke-Compose stop reporting-api
    Invoke-Compose stop kafka-1 kafka-2 kafka-3

    Write-Host "Reporting API and Kafka are stopped. Access API should still decide by local Redis."
    try {
        Invoke-Http "POST" "$AccessUrl/api/access/reset/$recoveryEmployee" | Out-Null
    }
    catch {
    }
    $recoverySwipe = Invoke-Swipe $recoveryEmployee "GATE_RECOVERY" "IN"
    Write-Host "Recovery swipe during outage: $recoverySwipe"
    Write-Host ("Recovery decision={0} eventBuffered={1} kafkaQueued={2}" -f (Get-JsonField $recoverySwipe "decision"), (Get-JsonField $recoverySwipe "eventBuffered"), (Get-JsonField $recoverySwipe "kafkaQueued"))

    Write-Section "8/9 Keep Kafka down, start Reporting API, verify Redis recovery"
    Invoke-Compose start reporting-api
    Wait-Url "Reporting API" "$ReportingUrl/api/health/" | Out-Null

    Write-Host "Waiting for Redis recovery to write employeeId=$recoveryEmployee into DB..."
    Wait-ForEventInReporting $recoveryEmployee

    Write-Host "Recovered events:"
    $recoveredEvents = Invoke-Http "GET" "$ReportingUrl/api/reports/access/events?limit=20"
    $recoveredEvents | ConvertFrom-Json | ConvertTo-Json -Depth 20

    Write-Section "9/9 Restore Kafka and show final status"
    Invoke-Compose start kafka-1 kafka-2 kafka-3
    Start-Sleep -Seconds 5

    Write-Host "Access API health:"
    Invoke-Http "GET" "$AccessUrl/healthz"
    Write-Host ""
    Write-Host "Reporting API health:"
    Invoke-Http "GET" "$ReportingUrl/api/health/"
    Write-Host ""
    Write-Host "Access metrics:"
    Invoke-Http "GET" "$AccessUrl/metrics"
    Write-Host ""
    Write-Host "Reporting summary:"
    Invoke-Http "GET" "$ReportingUrl/api/reports/access/summary"
    Write-Host ""

    @"

Demo complete.

You can run in DBeaver:
  SELECT * FROM access_events ORDER BY occurred_at DESC LIMIT 20;
  SELECT * FROM access_events WHERE employee_id = '$recoveryEmployee';

Recovery test highlights:
  - When Kafka and Reporting API are stopped, Access API still decides access by local Redis.
  - eventBuffered=true means the event was stored in the local Redis Stream first.
  - Before Kafka recovers, starting only Reporting API can still use redisRecovery to write data back to PostgreSQL.
"@
}
finally {
    Pop-Location
}
