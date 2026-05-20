param(
    [switch]$Full,
    [switch]$Rebuild,
    [switch]$CleanOrphans,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://127.0.0.1:8080" }
$Topic = if ($env:KAFKA_TOPIC) { $env:KAFKA_TOPIC } else { "access-events" }

function Show-Usage {
    @"
Usage:
  .\scripts\demo-access-api.ps1 [-Full] [-Rebuild] [-CleanOrphans]

Options:
  -Full          Run the 90,000 employee, 50 gate, 30 minute peak simulation
  -Rebuild       Rebuild the Access API image before starting
  -CleanOrphans  Remove orphan containers from older docker-compose services
  -Help          Show this help

By default this runs a smaller load test suitable for a quick pre-demo check.
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

function Invoke-Curl {
    Assert-Command curl.exe
    $output = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed with exit code $LASTEXITCODE"
    }
    return $output
}

if ($Help) {
    Show-Usage
    exit 0
}

Assert-Command curl.exe
Assert-Command go

Push-Location $RootDir
try {
    Write-Section "1/7 Start Docker Compose access stack"
    if ($Rebuild) {
        $composeArgs = @("up", "-d", "--build", "--scale", "access-api=3", "access-lb")
    }
    else {
        $composeArgs = @("up", "-d", "--scale", "access-api=3", "access-lb")
    }
    if ($CleanOrphans) {
        $composeArgs += "--remove-orphans"
    }
    Invoke-Compose @composeArgs

    Write-Section "2/7 Wait for Access API health"
    $health = $null
    for ($i = 0; $i -lt 90; $i++) {
        try {
            $health = Invoke-Curl -fsS "$BaseUrl/healthz" 2>$null
            Write-Host $health
            break
        }
        catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $health) {
        throw "Access API did not become ready in time"
    }

    Write-Section "3/7 Create Kafka topic"
    Invoke-Compose exec -T kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic $Topic --partitions 3 --replication-factor 3

    Write-Section "4/7 Run full smoke test"
    & (Join-Path $PSScriptRoot "verify-access-stack.ps1")

    Write-Section "5/7 Run load test"
    if ($Full) {
        & (Join-Path $PSScriptRoot "run-access-load-test.ps1") -Full
    }
    else {
        & (Join-Path $PSScriptRoot "run-access-load-test.ps1")
    }

    Write-Section "6/7 Current container status"
    Invoke-Compose ps

    Write-Section "7/7 Useful check commands"
    @"
Access API:
  curl.exe $BaseUrl/healthz
  curl.exe $BaseUrl/metrics

Recent Redis mirror events:
  curl.exe '$BaseUrl/api/access/events?limit=10'

Kafka topic status:
  docker-compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic $Topic

Read Kafka events:
  docker-compose exec kafka-1 /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic $Topic --from-beginning --max-messages 10

If you see orphan container warnings, run next time with:
  .\scripts\demo-access-api.ps1 -CleanOrphans
"@

    Write-Section "Done"
}
finally {
    Pop-Location
}
