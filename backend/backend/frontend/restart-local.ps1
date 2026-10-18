param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$frontendRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$envFile = Join-Path $frontendRoot ".env.local"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Local sign-in is not configured. Run setup-local-login.ps1 from the frontend folder first."
}

$settings = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $settings[$Matches[1]] = $value
    }
}

$sessionSecret = [string]$settings["FIN_SENTINELS_SESSION_SECRET"]
if ([string]::IsNullOrWhiteSpace($settings["FIN_SENTINELS_USERNAME"]) -or
    [string]::IsNullOrEmpty($settings["FIN_SENTINELS_PASSWORD"]) -or
    $sessionSecret.Length -lt 32) {
    throw "Local sign-in settings are incomplete. Run setup-local-login.ps1 from the frontend folder."
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is not available in this terminal. Install the project dependencies, then run this script again."
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
$processIdsToStop = @()
$frontendPattern = [regex]::Escape($frontendRoot)

foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $owner -or $owner.Name -ne "node.exe" -or $owner.CommandLine -notmatch $frontendPattern) {
        throw "Port $Port is already in use by another application. Stop it or choose another port with -Port."
    }

    $processIdsToStop += [int]$owner.ProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and $parent.Name -eq "node.exe" -and $parent.CommandLine -match 'next\s+(dev|start)') {
        $processIdsToStop += [int]$parent.ProcessId
    }
}

foreach ($processId in ($processIdsToStop | Sort-Object -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

$managedEnvironmentNames = @(
    "FIN_SENTINELS_USERNAME",
    "FIN_SENTINELS_PASSWORD",
    "FIN_SENTINELS_SESSION_SECRET",
    "FIN_SENTINELS_BACKEND_API_KEY",
    "FIN_SENTINELS_COOKIE_SECURE",
    "FIN_API_INTERNAL_URL",
    "NODE_ENV"
)
$savedEnvironment = @{}
foreach ($name in $managedEnvironmentNames) {
    $variable = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    if ($null -ne $variable) {
        $savedEnvironment[$name] = $variable.Value
        Remove-Item -Path "Env:$name"
    }
}

Write-Host "Starting FinSentinels frontend on http://127.0.0.1:$Port with settings from .env.local. Press Ctrl+C to stop."
Push-Location $frontendRoot
try {
    & pnpm dev --port $Port
} finally {
    Pop-Location
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item -Path "Env:$name" -Value $savedEnvironment[$name]
    }
}
