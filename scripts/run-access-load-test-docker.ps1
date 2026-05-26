param(
    [switch]$Full,
    [switch]$BaseOnly,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunId = if ($env:RUN_ID) { $env:RUN_ID } else { Get-Date -Format "yyyyMMddHHmmss" }
$ContainerBaseUrl = if ($env:SIMULATOR_BASE_URL) { $env:SIMULATOR_BASE_URL } else { "http://access-lb:8080" }
$HostBaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://127.0.0.1:8080" }
$ProjectNetwork = if ($env:COMPOSE_PROJECT_NAME) { "$($env:COMPOSE_PROJECT_NAME)_default" } else { "ntu_cloudnative_default" }
$GoImage = if ($env:GO_DOCKER_IMAGE) { $env:GO_DOCKER_IMAGE } else { "golang:1.26-alpine" }

function Get-EnvOrDefault([string]$Name, [string]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($value)) { return $Default }
    return $value
}

function Invoke-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Missing required command: docker"
    }
    & docker @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Compose {
    if ($BaseOnly) {
        Invoke-Docker compose -f docker-compose.yml @args
        return
    }
    Invoke-Docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml @args
}

function Invoke-Curl {
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        throw "Missing required command: curl.exe"
    }
    $output = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed with exit code $LASTEXITCODE"
    }
    return $output
}

if ($Full) {
    $Employees = Get-EnvOrDefault "EMPLOYEES" "90000"
    $EmployeePrefix = Get-EnvOrDefault "EMPLOYEE_PREFIX" "E$RunId"
    $Gates = Get-EnvOrDefault "GATES" "50"
    $Duration = Get-EnvOrDefault "DURATION" "30m"
    $TimeScale = Get-EnvOrDefault "TIME_SCALE" "10"
    $Workers = Get-EnvOrDefault "WORKERS" "200"
    $EntryRatio = Get-EnvOrDefault "ENTRY_RATIO" "0.995"
    $DuplicatePct = Get-EnvOrDefault "DUPLICATE_PCT" "0.005"
}
else {
    $Employees = Get-EnvOrDefault "EMPLOYEES" "1000"
    $EmployeePrefix = Get-EnvOrDefault "EMPLOYEE_PREFIX" "LOAD$RunId"
    $Gates = Get-EnvOrDefault "GATES" "10"
    $Duration = Get-EnvOrDefault "DURATION" "2m"
    $TimeScale = Get-EnvOrDefault "TIME_SCALE" "120"
    $Workers = Get-EnvOrDefault "WORKERS" "50"
    $EntryRatio = Get-EnvOrDefault "ENTRY_RATIO" "0.995"
    $DuplicatePct = Get-EnvOrDefault "DUPLICATE_PCT" "0.005"
}
$ProgressEvery = Get-EnvOrDefault "PROGRESS_EVERY" "3s"

Push-Location $RootDir
try {
    if (-not $NoStart) {
        if ($BaseOnly) {
            Write-Host "Starting access stack with base compose..."
            Invoke-Compose up -d --scale access-api=3 access-lb
        }
        else {
            Write-Host "Starting stack with observability compose override..."
            Invoke-Compose up -d --build --scale access-api=3
        }
    }

    Write-Host ""
    Write-Host "Running Dockerized swipe simulator against $ContainerBaseUrl"
    Write-Host "network=$ProjectNetwork image=$GoImage"
    Write-Host "employees=$Employees prefix=$EmployeePrefix gates=$Gates duration=$Duration timeScale=$TimeScale workers=$Workers entryRatio=$EntryRatio duplicatePct=$DuplicatePct"

    if ($Duration -match '^(\d+(?:\.\d+)?)([smh])$') {
        $value = [double]$Matches[1]
        $unit = $Matches[2]
        $seconds = switch ($unit) {
            "s" { $value }
            "m" { $value * 60 }
            "h" { $value * 3600 }
        }
        $realSeconds = $seconds / [double]$TimeScale
        Write-Host ("Estimated actual run time: about {0:N1} seconds" -f $realSeconds)
    }
    else {
        Write-Host "Estimated actual run time: unable to parse duration; check simulator output."
    }
    Write-Host "progressEvery=$ProgressEvery"

    Write-Host ""
    Write-Host "Seeding reporting employees for this demo prefix..."
    $previousPrefix = [Environment]::GetEnvironmentVariable("DEMO_LOAD_EMPLOYEE_PREFIX")
    $previousEmployees = [Environment]::GetEnvironmentVariable("DEMO_LOAD_EMPLOYEES")
    try {
        [Environment]::SetEnvironmentVariable("DEMO_LOAD_EMPLOYEE_PREFIX", $EmployeePrefix, "Process")
        [Environment]::SetEnvironmentVariable("DEMO_LOAD_EMPLOYEES", $Employees, "Process")
        & (Join-Path $PSScriptRoot "seed-reporting-demo-data.ps1") | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "seed-reporting-demo-data.ps1 failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable("DEMO_LOAD_EMPLOYEE_PREFIX", $previousPrefix, "Process")
        [Environment]::SetEnvironmentVariable("DEMO_LOAD_EMPLOYEES", $previousEmployees, "Process")
    }

    Invoke-Docker run --rm `
        --network $ProjectNetwork `
        -v "${RootDir}\access-api:/src" `
        -v "ntu_cloudnative_go_mod_cache:/go/pkg/mod" `
        -v "ntu_cloudnative_go_build_cache:/root/.cache/go-build" `
        -w /src `
        $GoImage `
        go run ./cmd/swipe-simulator `
            --base-url $ContainerBaseUrl `
            --employees $Employees `
            --employee-prefix $EmployeePrefix `
            --gates $Gates `
            --duration $Duration `
            --time-scale $TimeScale `
            --workers $Workers `
            --entry-ratio $EntryRatio `
            --duplicate-pct $DuplicatePct `
            --progress-every $ProgressEvery

    Write-Host ""
    Write-Host "Access API metrics after load test:"
    Write-Host "(Note: this is one load-balanced Access API instance, not cluster-wide aggregated metrics.)"
    Start-Sleep -Seconds 3
    Invoke-Curl -fsS "$HostBaseUrl/metrics"
    Write-Host ""
}
finally {
    Pop-Location
}
