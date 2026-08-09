<#
.SYNOPSIS
  Installs the photo gallery as a Windows service using NSSM.

.DESCRIPTION
  NSSM supervises `node dist/index.js` as a real service: it starts before any
  user logs in, restarts the process if it exits, and on stop sends Ctrl+C so
  the server's SIGINT handler closes SQLite cleanly instead of being killed.

  Run from an elevated PowerShell prompt.

.EXAMPLE
  .\install-service.ps1 -PhotosRoot 'D:\Photos' -DataDir 'C:\GalleryData'

.EXAMPLE
  .\install-service.ps1 -PhotosRoot '\\nas\photos' -DataDir 'C:\GalleryData' -Port 8080
#>
[CmdletBinding()]
param(
    # Folder of photos to serve. Read-only; the gallery never writes here.
    [Parameter(Mandatory)]
    [string]$PhotosRoot,

    # Where the SQLite index and thumbnail cache live. Keep this on a local SSD.
    [string]$DataDir = 'C:\GalleryData',

    [int]$Port = 4000,

    # 0.0.0.0 exposes the gallery to the LAN; 127.0.0.1 keeps it local.
    [string]$BindHost = '0.0.0.0',

    [string]$ServiceName = 'PhotoGallery',

    # Path to nssm.exe. Defaults to whatever is on PATH.
    [string]$NssmPath = 'nssm',

    # Honour X-Forwarded-* headers. Turn on only behind a reverse proxy/tunnel.
    [switch]$TrustProxy
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an elevated (Administrator) PowerShell prompt.'
    }
}

Assert-Admin

# deploy\windows\install-service.ps1 -> repo root is two levels up.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# --- Preflight -------------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'node was not found on PATH. Install Node.js 20 or newer first.'
}
$nodeExe = $node.Source

# Parse `node -v` in PowerShell rather than passing a -e snippet: quoting inside
# a string handed to a native exe gets mangled on Windows.
$nodeVersion = (& $nodeExe -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required (found $nodeVersion). See `"engines`" in package.json."
}

$nssm = Get-Command $NssmPath -ErrorAction SilentlyContinue
if (-not $nssm) {
    throw @"
nssm.exe was not found. Download it from https://nssm.cc/download, unzip, and
either put nssm.exe on PATH or pass -NssmPath 'C:\path\to\nssm.exe'.

If you would rather not install NSSM, use install-task.ps1 instead: it uses the
built-in Task Scheduler and needs no download.
"@
}
$nssmExe = $nssm.Source

$serverEntry = Join-Path $RepoRoot 'server\dist\index.js'
if (-not (Test-Path $serverEntry)) {
    throw "$serverEntry not found. Run 'npm ci' and 'npm run build' in $RepoRoot first."
}

if (-not (Test-Path (Join-Path $RepoRoot 'web\dist\index.html'))) {
    Write-Warning 'web\dist\index.html not found - the API will run but no UI will be served. Run "npm run build".'
}

if (-not (Test-Path $PhotosRoot)) {
    throw "PhotosRoot does not exist: $PhotosRoot"
}
$PhotosRoot = (Resolve-Path $PhotosRoot).Path

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$DataDir = (Resolve-Path $DataDir).Path

$logDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Install ---------------------------------------------------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service '$ServiceName' already exists - stopping and reconfiguring it." -ForegroundColor Yellow
    & $nssmExe stop $ServiceName confirm | Out-Null
} else {
    & $nssmExe install $ServiceName $nodeExe 'dist\index.js'
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed with exit code $LASTEXITCODE." }
}

# AppDirectory must be server\, since the entry path above is relative to it and
# config.ts resolves dataDir against the repo root either way.
& $nssmExe set $ServiceName Application $nodeExe          | Out-Null
& $nssmExe set $ServiceName AppParameters 'dist\index.js' | Out-Null
& $nssmExe set $ServiceName AppDirectory (Join-Path $RepoRoot 'server') | Out-Null
& $nssmExe set $ServiceName DisplayName 'Photo Gallery'   | Out-Null
& $nssmExe set $ServiceName Description 'Self-hosted photo gallery (Fastify + SQLite).' | Out-Null
& $nssmExe set $ServiceName Start SERVICE_AUTO_START      | Out-Null

# Environment always wins over config.json, so the service is self-describing
# and does not depend on a config.json sitting in the repo.
$envLines = @(
    "PHOTOS_ROOT=$PhotosRoot",
    "DATA_DIR=$DataDir",
    "PORT=$Port",
    "HOST=$BindHost",
    "NODE_ENV=production",
    "TRUST_PROXY=$($TrustProxy.IsPresent.ToString().ToLower())"
)
& $nssmExe set $ServiceName AppEnvironmentExtra ($envLines -join "`r`n") | Out-Null

# Ctrl+C first (Node maps it to SIGINT, which index.ts handles), 15s to drain.
& $nssmExe set $ServiceName AppStopMethodConsole 15000 | Out-Null
& $nssmExe set $ServiceName AppStopMethodWindow 5000   | Out-Null
& $nssmExe set $ServiceName AppStopMethodThreads 5000  | Out-Null

# Restart on unexpected exit, but back off so a config error does not spin.
& $nssmExe set $ServiceName AppExit Default Restart | Out-Null
& $nssmExe set $ServiceName AppRestartDelay 5000    | Out-Null
& $nssmExe set $ServiceName AppThrottle 10000       | Out-Null

# Logs, rotated at 16 MB so they cannot fill the disk.
& $nssmExe set $ServiceName AppStdout (Join-Path $logDir 'gallery.out.log') | Out-Null
& $nssmExe set $ServiceName AppStderr (Join-Path $logDir 'gallery.err.log') | Out-Null
& $nssmExe set $ServiceName AppRotateFiles 1     | Out-Null
& $nssmExe set $ServiceName AppRotateOnline 1    | Out-Null
& $nssmExe set $ServiceName AppRotateBytes 16777216 | Out-Null

# A UNC photosRoot is unreachable as LocalSystem. Warn rather than guess at
# credentials - the operator has to pick an account that can read the share.
if ($PhotosRoot.StartsWith('\\')) {
    Write-Warning @'
PhotosRoot is a UNC path. The service runs as LocalSystem by default, which has
no access to network shares. Set it to run as a domain/local account that can
read the share:

  nssm set PhotoGallery ObjectName <DOMAIN\user> <password>

Performance note: indexing and thumbnailing over SMB is far slower than local
disk. Running the gallery on the machine that holds the photos is faster.
'@
}

& $nssmExe start $ServiceName
if ($LASTEXITCODE -ne 0) { throw "nssm start failed with exit code $LASTEXITCODE. Check $logDir." }

Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName

Write-Host ''
Write-Host "Service '$ServiceName' is $($svc.Status)." -ForegroundColor Green
Write-Host "  URL         http://localhost:$Port"
Write-Host "  Photos      $PhotosRoot"
Write-Host "  Data        $DataDir"
Write-Host "  Logs        $logDir"
Write-Host ''
Write-Host 'On the very first run the admin access code is printed to gallery.out.log.'
Write-Host "  Get-Content '$logDir\gallery.out.log' -Tail 40"
