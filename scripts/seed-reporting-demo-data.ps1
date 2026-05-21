$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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

Push-Location $RootDir
try {
    $execArgs = @("exec", "-T")
    foreach ($envName in @(
        "DEMO_BASIC_EMPLOYEE_ID",
        "DEMO_RECOVERY_EMPLOYEE_ID",
        "DEMO_LOAD_EMPLOYEE_PREFIX",
        "DEMO_LOAD_EMPLOYEES"
    )) {
        $value = [Environment]::GetEnvironmentVariable($envName)
        if ($value) {
            $execArgs += @("-e", "$envName=$value")
        }
    }

    Invoke-Compose @execArgs reporting-api python -m app.seed

    @"
Demo users:
  admin / demo123
  executive / demo123
  manager / demo123
  manager_fab_b / demo123
  manager_security / demo123
  employee / demo123
"@
}
finally {
    Pop-Location
}
