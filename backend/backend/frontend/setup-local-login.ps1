$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot ".env.local"
$backendEnvPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\backend.local.env"))
$username = (Read-Host "Choose a local analyst username").Trim()
if ($username -notmatch "^[A-Za-z0-9._@-]{3,64}$") {
    throw "Username must be 3–64 characters and use letters, numbers, dot, underscore, @, or hyphen."
}

$securePassword = Read-Host "Choose a password (at least 12 characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
if ($password.Length -lt 12) {
    throw "Password must contain at least 12 characters."
}

if (Test-Path -LiteralPath $envPath) {
    $lines = @(Get-Content -LiteralPath $envPath)
} else {
    $lines = @()
}
$lines = @($lines | Where-Object { $_ -notmatch '^\s*(FIN_SENTINELS_USERNAME|FIN_SENTINELS_PASSWORD|FIN_SENTINELS_SESSION_SECRET|FIN_SENTINELS_BACKEND_API_KEY)\s*=' })
$escapedUsername = $username.Replace('\', '\\').Replace('"', '\"')
$escapedPassword = $password.Replace('\', '\\').Replace('"', '\"')
$sessionRandom = New-Object byte[] 48
$backendRandom = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($sessionRandom)
$rng.GetBytes($backendRandom)
$rng.Dispose()
$sessionSecret = [Convert]::ToBase64String($sessionRandom).TrimEnd('=').Replace('+','-').Replace('/','_')
$backendKey = [Convert]::ToBase64String($backendRandom).TrimEnd('=').Replace('+','-').Replace('/','_')
$lines += "FIN_SENTINELS_USERNAME=`"$escapedUsername`""
$lines += "FIN_SENTINELS_PASSWORD=`"$escapedPassword`""
$lines += "FIN_SENTINELS_SESSION_SECRET=`"$sessionSecret`""
$lines += "FIN_SENTINELS_BACKEND_API_KEY=`"$backendKey`""
Set-Content -LiteralPath $envPath -Value $lines -Encoding utf8

if (Test-Path -LiteralPath $backendEnvPath) {
    $backendLines = @(Get-Content -LiteralPath $backendEnvPath)
} else {
    $backendLines = @()
}
$backendLines = @($backendLines | Where-Object { $_ -notmatch '^\s*FIN_SENTINELS_BACKEND_API_KEY\s*=' })
$backendLines += "FIN_SENTINELS_BACKEND_API_KEY=`"$backendKey`""
if (-not ($backendLines | Where-Object { $_ -match '^\s*FIN_SENTINELS_FRONTEND_URL\s*=' })) {
    $backendLines += 'FIN_SENTINELS_FRONTEND_URL="http://127.0.0.1:3000/"'
}
Set-Content -LiteralPath $backendEnvPath -Value $backendLines -Encoding utf8

Write-Host "Local analyst login and the private Next.js-to-FastAPI key are configured. Restart FastAPI and Next.js to activate the changes."
