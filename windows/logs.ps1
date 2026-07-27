#Requires -Version 5.1
<#
.SYNOPSIS
    View Auto-Stop Media service logs.

.PARAMETER Follow
    Follow log output in real-time (like tail -f).

.PARAMETER Lines
    Number of lines to show (default: 50).

.EXAMPLE
    .\logs.ps1

.EXAMPLE
    .\logs.ps1 -Follow

.EXAMPLE
    .\logs.ps1 -Lines 100
#>

[CmdletBinding()]
param(
    [switch]$Follow,
    [int]$Lines = 50
)

$LogDir = Join-Path $env:APPDATA "AutoStopMedia\logs"
$Today = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "service-$Today.log"

# If today's log doesn't exist, try to find the most recent log
if (-not (Test-Path $LogFile)) {
    $LogFiles = Get-ChildItem -Path $LogDir -Filter "service-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($LogFiles) {
        $LogFile = $LogFiles[0].FullName
        Write-Host "Today's log not found, showing most recent: $($LogFiles[0].Name)" -ForegroundColor Yellow
    } else {
        Write-Host "No log files found in: $LogDir" -ForegroundColor Red
        Write-Host "Is the service installed and running?" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Press Enter to close..." -ForegroundColor Cyan
        $null = Read-Host
        exit 1
    }
}

Write-Host ""
Write-Host "Auto-Stop Media Logs" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan
Write-Host "File: $LogFile" -ForegroundColor Gray
Write-Host ""

if ($Follow) {
    Write-Host "Following log output (Ctrl+C to stop)..." -ForegroundColor Yellow
    Write-Host ""
    Get-Content $LogFile -Tail $Lines -Wait
} else {
    Get-Content $LogFile -Tail $Lines
    Write-Host ""
    Write-Host "---" -ForegroundColor DarkGray
    Write-Host "Tip: Use -Follow to watch in real-time" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press Enter to close..." -ForegroundColor Cyan
    $null = Read-Host
}

