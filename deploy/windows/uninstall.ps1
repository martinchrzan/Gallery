<#
.SYNOPSIS
  Removes the photo gallery service (NSSM) or scheduled task, whichever exists.

.DESCRIPTION
  Leaves DataDir alone - your index, thumbnails and logs survive. Delete that
  folder by hand if you want a clean slate.

  Run from an elevated PowerShell prompt.

.EXAMPLE
  .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = 'PhotoGallery',
    [string]$NssmPath = 'nssm'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run from an elevated (Administrator) PowerShell prompt.'
}

$removed = $false

if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    $nssm = Get-Command $NssmPath -ErrorAction SilentlyContinue
    if ($nssm) {
        & $nssm.Source stop $Name confirm | Out-Null
        & $nssm.Source remove $Name confirm | Out-Null
    } else {
        Write-Warning 'nssm.exe not found - falling back to sc.exe delete.'
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        & sc.exe delete $Name | Out-Null
    }
    Write-Host "Removed service '$Name'." -ForegroundColor Green
    $removed = $true
}

if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "Removed scheduled task '$Name'." -ForegroundColor Green
    $removed = $true
}

if (-not $removed) {
    Write-Host "Nothing to remove: no service or scheduled task named '$Name'." -ForegroundColor Yellow
}
