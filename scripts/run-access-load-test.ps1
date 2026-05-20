param(
    [switch]$Full
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://127.0.0.1:8080" }
$RunId = if ($env:RUN_ID) { $env:RUN_ID } else { Get-Date -Format "yyyyMMddHHmmss" }

function Get-EnvOrDefault([string]$Name, [string]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($value)) { return $Default }
    return $value
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
    Write-Host "Starting access stack..."
    Invoke-Compose up -d --scale access-api=3 access-lb

    Write-Host ""
    Write-Host "Running swipe simulator against $BaseUrl"
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

    Push-Location (Join-Path $RootDir "access-api")
    try {
        $GoCache = if ($env:GOCACHE) { $env:GOCACHE } else { Join-Path ([System.IO.Path]::GetTempPath()) "ntu-cloudnative-go-build" }
        $env:GOCACHE = $GoCache
        & go run ./cmd/swipe-simulator `
            --base-url $BaseUrl `
            --employees $Employees `
            --employee-prefix $EmployeePrefix `
            --gates $Gates `
            --duration $Duration `
            --time-scale $TimeScale `
            --workers $Workers `
            --entry-ratio $EntryRatio `
            --duplicate-pct $DuplicatePct `
            --progress-every $ProgressEvery
        if ($LASTEXITCODE -ne 0) {
            throw "go run swipe-simulator failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "Access API metrics after load test:"
    Write-Host "(Note: this is one load-balanced Access API instance, not cluster-wide aggregated metrics.)"
    Start-Sleep -Seconds 3
    Invoke-Curl -fsS "$BaseUrl/metrics"
    Write-Host ""
}
finally {
    Pop-Location
}
