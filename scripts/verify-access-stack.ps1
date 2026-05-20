$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://127.0.0.1:8080" }
$EmployeeId = if ($env:EMPLOYEE_ID) { $env:EMPLOYEE_ID } else { "VERIFY001" }
$Topic = if ($env:KAFKA_TOPIC) { $env:KAFKA_TOPIC } else { "access-events" }

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Fail([string]$Message) {
    throw $Message
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "missing required command: $Name"
    }
}

function Invoke-Compose {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        & docker-compose @args
        if ($LASTEXITCODE -ne 0) {
            Fail "docker-compose failed with exit code $LASTEXITCODE"
        }
        return
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        & docker compose @args
        if ($LASTEXITCODE -ne 0) {
            Fail "docker compose failed with exit code $LASTEXITCODE"
        }
        return
    }
    Fail "missing required command: docker-compose or docker compose"
}

function Invoke-Curl {
    Assert-Command curl.exe
    $output = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed with exit code $LASTEXITCODE"
    }
    return $output
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

function Assert-JsonField([string]$Json, [string]$Field, [string]$Expected) {
    $actual = Get-JsonField $Json $Field
    if ($actual -ne $Expected) {
        Write-Error "Response was: $Json"
        Fail "expected .$Field=$Expected, got $actual"
    }
}

function Get-KafkaOffsetSum {
    $offsets = Invoke-Compose exec -T kafka-1 /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic $Topic
    $sum = 0
    foreach ($line in $offsets) {
        $parts = "$line".Split(":")
        if ($parts.Length -ge 3) {
            $sum += [int64]$parts[2]
        }
    }
    return $sum
}

Assert-Command curl.exe

Push-Location $RootDir
try {
    Write-Step "Starting local access stack"
    Invoke-Compose up -d --scale access-api=3 access-lb

    Write-Step "Container status"
    Invoke-Compose ps

    Write-Step "Waiting for load balancer health"
    $health = $null
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $health = Invoke-Curl -fsS "$BaseUrl/healthz" 2>$null
            break
        }
        catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $health) {
        Fail "Access API health check did not become ready"
    }
    Write-Host $health
    Assert-JsonField $health "status" "ok"
    Assert-JsonField $health "redis" "ok"

    Write-Step "Checking load balancer reaches multiple Access API instances"
    $instances = @()
    for ($i = 0; $i -lt 12; $i++) {
        $ping = Invoke-Curl -fsS "$BaseUrl/ping"
        $instance = Get-JsonField $ping "instanceId"
        if ($instance) {
            $instances += $instance
        }
    }
    $uniqueInstances = @($instances | Sort-Object -Unique).Count
    Write-Host "Instances seen through LB: $($instances -join ' ')"
    if ($uniqueInstances -lt 2) {
        Fail "load balancer only reached $uniqueInstances Access API instance(s)"
    }

    Write-Step "Checking Redis Sentinel master"
    $master = (Invoke-Compose exec -T redis-sentinel-1 redis-cli -p 26379 sentinel get-master-addr-by-name mymaster) -join " "
    $master = $master -replace "`r", " "
    Write-Host $master
    if ($master -notmatch "redis") {
        Fail "Redis Sentinel did not report redis as master"
    }

    Write-Step "Checking Redis roles"
    Invoke-Compose exec -T redis redis-cli role
    Invoke-Compose exec -T redis-replica-1 redis-cli role
    Invoke-Compose exec -T redis-replica-2 redis-cli role

    Write-Step "Creating Kafka topic if needed"
    Invoke-Compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic $Topic --partitions 3 --replication-factor 3

    Write-Step "Checking Kafka topic replication"
    $topicDesc = (Invoke-Compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic $Topic) -join "`n"
    Write-Host $topicDesc
    if ($topicDesc -notmatch "PartitionCount: 3") {
        Fail "Kafka topic does not have 3 partitions"
    }
    if ($topicDesc -notmatch "ReplicationFactor: 3") {
        Fail "Kafka topic does not have replication factor 3"
    }

    Write-Step "Recording Kafka offsets before fresh verification events"
    $offsetBefore = Get-KafkaOffsetSum
    Write-Host "Kafka offset sum before: $offsetBefore"

    Write-Step "Testing anti-passback flow"
    Invoke-Curl -fsS -X POST "$BaseUrl/api/access/reset/$EmployeeId" | Out-Null

    $entry1Body = @{ employeeId = $EmployeeId; gateId = "GATE_01"; direction = "IN" } | ConvertTo-Json -Compress
    $entry1 = Invoke-Curl -fsS -X POST "$BaseUrl/api/access/swipe" -H "Content-Type: application/json" -d $entry1Body
    Write-Host "First IN: $entry1"
    Assert-JsonField $entry1 "decision" "GRANTED"
    Assert-JsonField $entry1 "eventBuffered" "true"

    $entry2Body = @{ employeeId = $EmployeeId; gateId = "GATE_01"; direction = "IN" } | ConvertTo-Json -Compress
    $entry2 = Invoke-Curl -fsS -X POST "$BaseUrl/api/access/swipe" -H "Content-Type: application/json" -d $entry2Body
    Write-Host "Second IN: $entry2"
    Assert-JsonField $entry2 "decision" "DENIED"
    Assert-JsonField $entry2 "reason" "ANTI_PASSBACK_VIOLATION"

    $exitBody = @{ employeeId = $EmployeeId; gateId = "GATE_01"; direction = "OUT" } | ConvertTo-Json -Compress
    $exit1 = Invoke-Curl -fsS -X POST "$BaseUrl/api/access/swipe" -H "Content-Type: application/json" -d $exitBody
    Write-Host "OUT: $exit1"
    Assert-JsonField $exit1 "decision" "GRANTED"

    Write-Step "Checking Redis state and mirrored events"
    Invoke-Curl -fsS "$BaseUrl/api/access/state/$EmployeeId"
    Write-Host ""
    Invoke-Curl -fsS "$BaseUrl/api/access/events?limit=3"
    Write-Host ""

    Write-Step "Checking Kafka offsets advanced"
    Start-Sleep -Seconds 2
    $offsetAfter = Get-KafkaOffsetSum
    Write-Host "Kafka offset sum after: $offsetAfter"
    $offsetDelta = $offsetAfter - $offsetBefore
    if ($offsetDelta -lt 3) {
        Fail "Kafka offsets only advanced by $offsetDelta; expected at least 3"
    }

    Write-Step "Checking Access API metrics"
    $metrics = Invoke-Curl -fsS "$BaseUrl/metrics"
    Write-Host $metrics
    if ($metrics -notmatch "access_api_events_dropped_total 0") {
        Fail "Access API dropped events during smoke test"
    }

    Write-Step "Access stack verification passed"
}
finally {
    Pop-Location
}
