# One-command local install/start for Windows testers - NOT the same
# job as deploy/setup-server.sh (that one bootstraps a fresh Ubuntu/
# Debian CLOUD server: installs Docker itself via apt, configures ufw,
# sets up Nginx + Let's Encrypt for a real public domain). None of that
# applies to a Windows machine running this for local testing: Docker
# Desktop is a GUI app you install yourself (Windows won't let a script
# silently install one), there's no public domain/HTTPS involved, and no
# firewall to configure. This script only handles what's actually
# different for a local Windows run: checking Docker Desktop is present
# and running, then the same .env bootstrap + `docker compose up` +
# owner-account creation deploy/setup-server.sh already does for a
# server.
#
# Usage (from PowerShell):
#   .\deploy\install-windows.ps1
#
# Written for Windows PowerShell 5.1 compatibility (no &&/||, no ternary,
# no null-coalescing) so it runs unmodified on whatever version a tester
# already has, without requiring PowerShell 7+.

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host ""
    Write-Host "!! $msg" -ForegroundColor Yellow
}

# --- Docker Desktop check (never auto-installed - see the header) ------
$dockerOk = $false
try {
    docker info *> $null
    if ($?) { $dockerOk = $true }
} catch {}

if (-not $dockerOk) {
    Write-Warn "Docker Desktop isn't installed or isn't running."
    Write-Host ""
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Install it with winget, then start it once from the Start menu"
        Write-Host "(first launch needs to finish its own setup, and may require a reboot"
        Write-Host "to enable WSL2, before the docker command works):"
        Write-Host ""
        Write-Host "    winget install Docker.DockerDesktop"
        Write-Host ""
    } else {
        Write-Host "Download and install it from:"
        Write-Host ""
        Write-Host "    https://www.docker.com/products/docker-desktop/"
        Write-Host ""
    }
    Write-Host "Then re-run this script."
    exit 1
}

# --- Find or clone the repo ---------------------------------------------
$RepoUrl = "https://github.com/GarfieldFan/AI-agent-mvp.git"
$TargetDir = $null

if ((Test-Path ".\docker-compose.yml") -and (Test-Path ".\deploy\install-windows.ps1")) {
    Write-Step "Running from inside an existing checkout - using $(Get-Location)"
    $TargetDir = (Get-Location).Path
} else {
    $defaultCheckout = Join-Path $HOME "ai-employee"
    if (Test-Path (Join-Path $defaultCheckout "docker-compose.yml")) {
        Write-Step "Existing checkout found at $defaultCheckout - using it"
        $TargetDir = $defaultCheckout
    } else {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) {
            Write-Host "git isn't installed - install Git for Windows (https://git-scm.com/download/win)" -ForegroundColor Red
            Write-Host "or download the code as a .zip from $RepoUrl and run this script from inside it instead." -ForegroundColor Red
            exit 1
        }
        Write-Step "Cloning into $defaultCheckout"
        git clone $RepoUrl $defaultCheckout
        $TargetDir = $defaultCheckout
    }
}
Set-Location $TargetDir

# --- .env bootstrap (never overwrites an existing file) -----------------
if (-not (Test-Path ".env")) {
    Write-Step "Creating .env from .env.example"
    Copy-Item ".env.example" ".env"
}

function Set-EnvValue($key, $value) {
    $content = Get-Content ".env"
    $pattern = "^$key="
    $found = $false
    $updated = $content | ForEach-Object {
        if ($_ -match $pattern) {
            $found = $true
            "$key=$value"
        } else {
            $_
        }
    }
    if (-not $found) {
        $updated += "$key=$value"
    }
    Set-Content ".env" -Value $updated -Encoding utf8
}

function Get-EnvValue($key) {
    $line = Get-Content ".env" | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if ($null -eq $line) { return $null }
    return $line.Substring($key.Length + 1)
}

$jwtLine = Get-EnvValue "JWT_SECRET"
if (($null -eq $jwtLine) -or ($jwtLine -eq "dev-only-insecure-secret-change-me")) {
    Write-Step "Generating a real JWT_SECRET"
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-EnvValue "JWT_SECRET" $hex
}

# .env.example's own COMFYUI_HOST_OUTPUT_DIR default is this project's
# own dev machine's literal path - won't exist on a fresh test machine.
# A harmless empty local directory keeps the bind mount valid; image
# generation just reports "not reachable" (existing graceful-degradation
# behavior), same fix deploy/setup-server.sh/install-mac.sh make.
$comfyDir = Get-EnvValue "COMFYUI_HOST_OUTPUT_DIR"
if (($null -eq $comfyDir) -or (-not (Test-Path $comfyDir))) {
    $localComfyDir = Join-Path $TargetDir "data\comfy_output"
    New-Item -ItemType Directory -Force -Path $localComfyDir | Out-Null
    Set-EnvValue "COMFYUI_HOST_OUTPUT_DIR" $localComfyDir
}

# --- Bring the app up -----------------------------------------------------
Write-Step "Pulling images and starting the stack (this can take a few minutes on first run)"
try { docker compose pull --quiet } catch {}  # best-effort - build-only images have nothing to pull
docker compose up -d --build

Write-Step "Waiting for the backend to become reachable"
$backendPort = Get-EnvValue "BACKEND_PORT"
if ($null -eq $backendPort) { $backendPort = "8000" }
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$backendPort/openapi.json" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
}
if (-not $ready) {
    Write-Warn "Backend didn't respond within 3 minutes - check 'docker compose logs backend' for what's wrong."
}

# --- First-owner bootstrap (production-safe - see backend/create_owner.py) ---
Write-Step "Ensuring a real owner account exists"
$ownerOutput = (docker compose exec -T backend python create_owner.py 2>&1 | Out-String)
($ownerOutput -split "`n") | Where-Object { $_ -notmatch '^OWNER_PASSWORD=' } | ForEach-Object { Write-Host $_ }

# --- Summary --------------------------------------------------------------
$frontendPort = Get-EnvValue "FRONTEND_PORT"
if ($null -eq $frontendPort) { $frontendPort = "3000" }
Write-Step "Done"
Write-Host "Site: http://localhost:$frontendPort"
if ($ownerOutput -match '^OWNER_PASSWORD=') {
    $ownerEmailLine = ($ownerOutput -split "`n") | Where-Object { $_ -match '^OWNER_EMAIL=' } | Select-Object -First 1
    $ownerPasswordLine = ($ownerOutput -split "`n") | Where-Object { $_ -match '^OWNER_PASSWORD=' } | Select-Object -First 1
    Write-Host ""
    Write-Host "############################################################"
    Write-Host "# A real owner account was just created - SAVE THIS NOW,"
    Write-Host "# it will never be shown again:"
    Write-Host "#   $ownerEmailLine"
    Write-Host "#   $ownerPasswordLine"
    Write-Host "############################################################"
}
Write-Host ""
Write-Host "To stop: docker compose down (from $TargetDir)"
Write-Host "To update later: git pull && docker compose up -d --build"
