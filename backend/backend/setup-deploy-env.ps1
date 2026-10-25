$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $envPath) {
    throw "A .env file already exists. Edit it directly if you intend to rotate credentials; this script will not overwrite it."
}

$username = (Read-Host "Choose the single analyst username").Trim()
if ($username -notmatch "^[A-Za-z0-9._@-]{3,64}$") {
    throw "Username must be 3-64 characters and use letters, numbers, dot, underscore, @, or hyphen."
}

$securePassword = Read-Host "Choose a unique password (at least 16 characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
if ($password.Length -lt 16) {
    throw "Password must contain at least 16 characters."
}

function New-Secret {
    param([int]$ByteCount = 48)
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function ConvertTo-ComposeSingleQuoted {
    param([string]$Value)
    return "'" + $Value.Replace("'", "\'") + "'"
}

$lines = @(
    "FIN_SENTINELS_USERNAME=$(ConvertTo-ComposeSingleQuoted $username)"
    "FIN_SENTINELS_PASSWORD=$(ConvertTo-ComposeSingleQuoted $password)"
    "FIN_SENTINELS_SESSION_SECRET=$(New-Secret)"
    "FIN_SENTINELS_BACKEND_API_KEY=$(New-Secret)"
    "FINSENTINELS_DATA_MODE=production"
    ""
    "WEB_BIND_ADDRESS=127.0.0.1"
    "WEB_PORT=3000"
    "PUBLIC_APP_URL=http://localhost:3000/"
    "FIN_SENTINELS_COOKIE_SECURE=false"
    ""
    "OBP_API_BASE_URL=https://apisandbox.openbankproject.com"
    "OBP_API_VERSION=v5.1.0"
    "OBP_ACCESS_TOKEN="
    "OBP_BANK_ID="
    "OBP_VIEW_ID="
    "OBP_ACCOUNT_IDS="
    "OBP_WEBHOOK_SECRET="
    "OBP_WEBHOOK_SIGNATURE_HEADER=x-sandbox-signature"
    "OBP_DEFAULT_CURRENCY="
    "FIN_SENTINELS_BASE_CURRENCY=INR"
    "OBP_SYNC_PAGE_SIZE=100"
    "OBP_SYNC_MAX_PAGES=10"
)

[System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Created the ignored .env file with generated session and backend secrets. No default password was installed."
Write-Host "Keep .env private and configure your OBP-issued credentials only when they are available."
