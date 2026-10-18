$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$frontendRoot = Join-Path $projectRoot "frontend"
$pythonPath = Join-Path $projectRoot ".venv\Scripts\python.exe"
$frontendEnvPath = Join-Path $frontendRoot ".env.local"
$backendEnvPath = Join-Path $projectRoot "backend.local.env"
$frontendRestartPath = Join-Path $frontendRoot "restart-local.ps1"
$apiPort = 8000
$webPort = 3000
$apiUrl = "http://127.0.0.1:$apiPort"
$loginUrl = "http://127.0.0.1:$webPort/login"

function Read-LocalSettings([string]$Path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $value = $Matches[2].Trim()
            if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$Matches[1]] = $value
        }
    }
    return $values
}

function Test-ApiHealthy([string]$BackendKey) {
    try {
        $health = Invoke-RestMethod -Uri "$apiUrl/api/health" -Headers @{ "x-fin-sentinels-backend-key" = $BackendKey } -TimeoutSec 3
        return $health.status -eq "healthy"
    } catch {
        return $false
    }
}

function Wait-ForApi([string]$BackendKey, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ApiHealthy $BackendKey) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

try {
    if (-not (Test-Path -LiteralPath $pythonPath)) {
        throw "The backend Python environment is missing. Set up the project environment before using run.bat."
    }
    if (-not (Test-Path -LiteralPath $frontendEnvPath)) {
        throw "Local sign-in has not been set up. Run frontend\setup-local-login.ps1 once, then run run.bat again."
    }
    if (-not (Test-Path -LiteralPath $backendEnvPath)) {
        throw "backend.local.env is missing. Run frontend\setup-local-login.ps1 once, then run run.bat again."
    }
    if (-not (Test-Path -LiteralPath $frontendRestartPath)) {
        throw "The frontend launcher is missing: frontend\restart-local.ps1."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot "node_modules\next\package.json"))) {
        throw "Frontend packages are not installed. Open a terminal in frontend and run pnpm install once."
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        throw "pnpm is not available in this terminal. Install pnpm, then run run.bat again."
    }

    $frontendSettings = Read-LocalSettings $frontendEnvPath
    $backendSettings = Read-LocalSettings $backendEnvPath
    $frontendKey = [string]$frontendSettings["FIN_SENTINELS_BACKEND_API_KEY"]
    $backendKey = [string]$backendSettings["FIN_SENTINELS_BACKEND_API_KEY"]
    if ([string]::IsNullOrWhiteSpace($frontendSettings["FIN_SENTINELS_USERNAME"]) -or
        [string]::IsNullOrEmpty($frontendSettings["FIN_SENTINELS_PASSWORD"]) -or
        ([string]$frontendSettings["FIN_SENTINELS_SESSION_SECRET"]).Length -lt 32) {
        throw "Local sign-in settings are incomplete. Run frontend\setup-local-login.ps1 only if you intend to create or replace the local credentials."
    }
    if ($frontendKey.Length -lt 32 -or $backendKey.Length -lt 32 -or
        -not [string]::Equals($frontendKey, $backendKey, [System.StringComparison]::Ordinal)) {
        throw "The frontend and backend API keys are missing or out of sync. Re-run frontend\setup-local-login.ps1 only if you intend to replace the local credentials."
    }

    $apiListeners = @(Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue)
    if ($apiListeners.Count -gt 0) {
        if (-not (Test-ApiHealthy $backendKey)) {
            throw "Port $apiPort is already in use, but it is not answering as this FinSentinels API. Close the old API window or the other app using that port, then run run.bat again."
        }
        Write-Host "FinSentinels API is already running and ready."
    } else {
        Write-Host "Starting the FinSentinels API..."
        $managedEnvironmentNames = @("FIN_SENTINELS_BACKEND_API_KEY", "FIN_SENTINELS_FRONTEND_URL")
        $savedEnvironment = @{}
        foreach ($name in $managedEnvironmentNames) {
            $variable = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
            if ($null -ne $variable) {
                $savedEnvironment[$name] = $variable.Value
                Remove-Item -Path "Env:$name"
            }
        }
        try {
            Start-Process -FilePath $pythonPath `
                -ArgumentList @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "$apiPort", "--reload") `
                -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
        } finally {
            foreach ($name in $managedEnvironmentNames) {
                Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
                if ($savedEnvironment.ContainsKey($name)) {
                    Set-Item -Path "Env:$name" -Value $savedEnvironment[$name]
                }
            }
        }
        if (-not (Wait-ForApi $backendKey 90)) {
            throw "The API did not become healthy within 90 seconds. Check the FinSentinels API window for its startup error."
        }
        Write-Host "FinSentinels API is ready."
    }

    $webListeners = @(Get-NetTCPConnection -State Listen -LocalPort $webPort -ErrorAction SilentlyContinue)
    $frontendPattern = [regex]::Escape($frontendRoot)
    foreach ($listener in $webListeners) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $owner -or $owner.Name -ne "node.exe" -or $owner.CommandLine -notmatch $frontendPattern) {
            throw "Port $webPort is already used by another application. Close it, then run run.bat again."
        }
    }

    Write-Host "Starting the FinSentinels analyst workspace..."
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $frontendArguments = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$frontendRestartPath`" -Port $webPort"
    Start-Process -FilePath $powershellPath -ArgumentList $frontendArguments -WorkingDirectory $frontendRoot -WindowStyle Normal | Out-Null

    $deadline = (Get-Date).AddSeconds(90)
    $webReady = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $page = Invoke-WebRequest -Uri $loginUrl -UseBasicParsing -TimeoutSec 3
            if ($page.StatusCode -lt 500 -and $page.Content -match "Fin Sentinels|FinSentinels") {
                $webReady = $true
                break
            }
        } catch {
            # Next.js can take a little time to compile the login page on startup.
        }
        Start-Sleep -Seconds 2
    }
    if (-not $webReady) {
        throw "The frontend did not become ready within 90 seconds. Check the FinSentinels frontend window for its startup error."
    }

    Start-Process -FilePath $loginUrl
    Write-Host "FinSentinels is open at $loginUrl. Keep the API and frontend windows open while using it."
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
