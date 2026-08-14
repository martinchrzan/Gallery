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

    # Days of daily log files to keep. 0 keeps them forever.
    [int]$LogRetentionDays = 30,

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

# Stop any existing instance up front: on a reinstall it still holds the port,
# and the check below would blame the copy we are about to replace.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
    Write-Host "Service '$ServiceName' is running - stopping it before reinstalling." -ForegroundColor Yellow
    & $nssmExe stop $ServiceName confirm | Out-Null
}

# EADDRINUSE is thrown at listen(), after the smoke test below would have
# passed, and NSSM reports it as the same opaque start failure. Catch it here.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $pid_ = @($busy)[0].OwningProcess
    $owner = (Get-Process -Id $pid_ -ErrorAction SilentlyContinue).ProcessName
    throw "Port $Port is already in use by PID $pid_ ($owner). Stop it, or pass -Port <other>."
}

# --- Smoke test ------------------------------------------------------------
# Everything that kills the server on startup - unbuilt native modules, a
# photosRoot the account cannot see, a bad env - happens before the port opens,
# where NSSM can only report it as "unexpected status SERVICE_START_PENDING".
# So load the same modules with the same environment here first, in the
# foreground, where a failure prints its own message.
#
# The probe has to sit inside the repo: node resolves `better-sqlite3` by
# walking up from the file's own directory, and $DataDir is outside the tree.

$serverDir = Join-Path $RepoRoot 'server'
$probe = Join-Path $serverDir '.install-preflight.mjs'
$probeOut = Join-Path $logDir 'preflight.out.log'
$probeErr = Join-Path $logDir 'preflight.err.log'

# Single-quoted: the template literals below must reach node, not PowerShell.
Set-Content -Path $probe -Encoding ascii -Value @'
// Written by deploy\windows\install-service.ps1 and deleted again straight
// away. Loads what index.ts loads before it listens, minus the listening.
import { loadConfig } from './dist/config.js';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const cfg = loadConfig();
console.log(`photosRoot ${cfg.photosRoot}`);
console.log(`dataDir    ${cfg.dataDir}`);
const v = new Database(':memory:').prepare('select sqlite_version() as v').get().v;
console.log(`sqlite ${v}, libvips ${sharp.versions.vips}`);
'@

$saved = @{}
$probeEnv = @{
    PHOTOS_ROOT = $PhotosRoot
    DATA_DIR    = $DataDir
    PORT        = "$Port"
    HOST        = $BindHost
    NODE_ENV    = 'production'
}
foreach ($key in $probeEnv.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
    Set-Item -Path "env:$key" -Value $probeEnv[$key]
}

try {
    # Start-Process rather than `& node ... 2>&1`: in Windows PowerShell the
    # latter turns every stderr line into an ErrorRecord, which $ErrorAction-
    # Preference = 'Stop' then throws on before we can read it.
    $probeRun = Start-Process -FilePath $nodeExe -ArgumentList '.install-preflight.mjs' `
        -WorkingDirectory $serverDir -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr
} finally {
    foreach ($key in $probeEnv.Keys) {
        if ($null -eq $saved[$key]) { Remove-Item -Path "env:$key" -ErrorAction SilentlyContinue }
        else { Set-Item -Path "env:$key" -Value $saved[$key] }
    }
    Remove-Item -Path $probe -Force -ErrorAction SilentlyContinue
}

if ($probeRun.ExitCode -ne 0) {
    $detail = ((Get-Content $probeErr -ErrorAction SilentlyContinue) +
               (Get-Content $probeOut -ErrorAction SilentlyContinue)) -join [Environment]::NewLine
    throw @"
The server failed to start with this configuration, so the service was not
installed. Node exited with code $($probeRun.ExitCode):

$detail

ERR_MODULE_NOT_FOUND or a missing .node binding means dependencies are not
installed for this copy of the tree - run 'npm ci' then 'npm run build' in
$RepoRoot.
"@
}

Write-Host 'Preflight passed:' -ForegroundColor Green
Get-Content $probeOut | ForEach-Object { Write-Host "  $_" }

# --- Install ---------------------------------------------------------------

if ($existing) {
    Write-Host "Service '$ServiceName' already exists - reconfiguring it." -ForegroundColor Yellow
} else {
    & $nssmExe install $ServiceName $nodeExe 'dist\index.js'
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed with exit code $LASTEXITCODE." }
}

# AppDirectory must be server\, since the entry path above is relative to it and
# config.ts resolves dataDir against the repo root either way.
& $nssmExe set $ServiceName Application $nodeExe          | Out-Null
& $nssmExe set $ServiceName AppParameters 'dist\index.js' | Out-Null
& $nssmExe set $ServiceName AppDirectory $serverDir | Out-Null
& $nssmExe set $ServiceName DisplayName 'Photo Gallery'   | Out-Null
& $nssmExe set $ServiceName Description 'Self-hosted photo gallery (Fastify + SQLite).' | Out-Null
& $nssmExe set $ServiceName Start SERVICE_AUTO_START      | Out-Null

# Environment always wins over config.json, so the service is self-describing
# and does not depend on a config.json sitting in the repo.
#
# LOG_CONSOLE=false because the server writes its own dated files under
# logs\ and keeps them pruned; NSSM's capture below would otherwise hold a
# second, undated copy of every line.
$envLines = @(
    "PHOTOS_ROOT=$PhotosRoot",
    "DATA_DIR=$DataDir",
    "PORT=$Port",
    "HOST=$BindHost",
    "NODE_ENV=production",
    "TRUST_PROXY=$($TrustProxy.IsPresent.ToString().ToLower())",
    "LOG_CONSOLE=false",
    "LOG_CLEANUP=$(if ($LogRetentionDays -gt 0) { 'true' } else { 'false' })",
    "LOG_RETENTION_DAYS=$(if ($LogRetentionDays -gt 0) { $LogRetentionDays } else { 30 })"
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

# What the app logs goes to logs\gallery-<date>.log, written by the app itself.
# These two only catch what happens outside that - a config error thrown before
# the logger exists, a native crash - so they stay small. Rotated at 16 MB even
# so, since nothing prunes them.
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

# Do not trust that exit code on its own. NSSM returns non-zero whenever the
# service has not reached RUNNING by the time it stops waiting, which looks
# identical whether the app is crash-looping or merely slow to come up. Ask the
# server itself instead: /api/health answers as soon as the port is open.
$healthy = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    try {
        $probeUrl = "http://localhost:$Port/api/health"
        if ((Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
        # Not listening yet, or already dead - the loop decides which.
    }
    Start-Sleep -Milliseconds 500
}

$svc = Get-Service -Name $ServiceName

if (-not $healthy) {
    Write-Host ''
    Write-Warning "'$ServiceName' did not answer on http://localhost:$Port within 45s (service status: $($svc.Status))."

    # The dated file is where the server logs; the other two hold what died
    # before it could, which on a failed start is usually the whole story.
    $today = Get-ChildItem (Join-Path $logDir 'gallery-*.log') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    $candidates = @('gallery.err.log', 'gallery.out.log') |
        ForEach-Object { Join-Path $logDir $_ }
    if ($today) { $candidates += $today.FullName }

    foreach ($file in $candidates) {
        Write-Host ''
        Write-Host "--- $file (last 40 lines) ---" -ForegroundColor Yellow
        if (Test-Path $file) {
            Get-Content $file -Tail 40
        } else {
            Write-Host '(not created - NSSM never got as far as launching node)'
        }
    }

    # When the failure is in NSSM rather than in the app - a bad Application
    # path, a service account that cannot log on - nothing reaches those logs.
    Write-Host ''
    Write-Host '--- Application event log, source nssm ---' -ForegroundColor Yellow
    try {
        Get-EventLog -LogName Application -Source nssm -Newest 10 -ErrorAction Stop |
            Format-Table TimeGenerated, EntryType, Message -AutoSize -Wrap
    } catch {
        Write-Host '(no nssm entries)'
    }

    throw @"
The service is installed but not serving. The output above is the reason;
after fixing it, re-run this script - it reconfigures the existing service.
To remove it entirely: .\uninstall.ps1
"@
}

Write-Host ''
Write-Host "Service '$ServiceName' is $($svc.Status) and answering on /api/health." -ForegroundColor Green
Write-Host "  URL         http://localhost:$Port"
Write-Host "  Photos      $PhotosRoot"
Write-Host "  Data        $DataDir"
$retention = if ($LogRetentionDays -gt 0) { "kept $LogRetentionDays days" } else { 'kept forever' }
Write-Host "  Logs        $logDir\gallery-<date>.log (one per day, $retention)"
Write-Host ''
Write-Host "On the very first run the admin access code is printed to today's log."
Write-Host "  Get-Content '$logDir\gallery-$(Get-Date -Format 'yyyy-MM-dd').log' -Tail 40"
