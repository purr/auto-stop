#Requires -Version 5.1
<#
.SYNOPSIS
    Restarts the Auto-Stop Media Windows service.

.DESCRIPTION
    Stops any running instances and starts a fresh one.
    Also updates service files from the source directory if available.

.PARAMETER UpdateFiles
    Update service files from source before restarting.

.EXAMPLE
    .\restart.ps1

.EXAMPLE
    .\restart.ps1 -UpdateFiles
#>

[CmdletBinding()]
param(
    [switch]$UpdateFiles
)

$ErrorActionPreference = "Stop"

# Configuration
$AppName = "AutoStopMedia"
$InstallDir = Join-Path $env:APPDATA $AppName
$ServiceDir = Join-Path $InstallDir "service"
$LogDir = Join-Path $InstallDir "logs"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Colors
function Write-Status {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] " -ForegroundColor DarkGray -NoNewline
    Write-Host $Message -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Err {
    param([string]$Message)
    Write-Host "  [ERROR] $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "  -> $Message" -ForegroundColor Gray
}

# Banner
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Auto-Stop Media - Service Restart" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Check if installed
if (-not (Test-Path $ServiceDir)) {
    Write-Err "Service not installed. Run install.ps1 first."
    Write-Host ""
    Write-Host "Press Enter to close..." -ForegroundColor Yellow
    $null = Read-Host
    exit 1
}

# Stop existing processes
Write-Step "Stopping existing service..."

$stopped = 0
Get-Process -Name "python*", "pythonw*" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdLine -and ($cmdLine -like "*main.py*") -and ($cmdLine -like "*AutoStopMedia*")) {
            Write-Info "Stopping PID $($_.Id)..."
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            $stopped++
        }
    } catch {}
}

if ($stopped -gt 0) {
    Write-OK "Stopped $stopped process(es)"
    Start-Sleep -Seconds 2
} else {
    Write-Info "No running instances found"
}

# Update files if requested
if ($UpdateFiles) {
    Write-Step "Updating service files..."

    $sourceDir = Join-Path $ScriptDir "service"
    if (Test-Path $sourceDir) {
        try {
            Get-ChildItem -Path $sourceDir -Filter "*.py" | ForEach-Object {
                Copy-Item $_.FullName -Destination $ServiceDir -Force
                Write-Info "Updated: $($_.Name)"
            }
            Write-OK "Files updated"
        } catch {
            Write-Err "Failed to update files: $_"
        }
    } else {
        Write-Info "Source directory not found, skipping update"
    }
}

# Clear old logs (optional - keep last log)
Write-Step "Starting service..."

# Find Python
$pythonExe = $null
$pythonPaths = @(
    (Get-Command pythonw -ErrorAction SilentlyContinue),
    (Get-Command python -ErrorAction SilentlyContinue)
)

foreach ($p in $pythonPaths) {
    if ($p) {
        $dir = Split-Path -Parent $p.Source
        $pythonw = Join-Path $dir "pythonw.exe"
        if (Test-Path $pythonw) {
            $pythonExe = $pythonw
            break
        }
        $pythonExe = $p.Source
        break
    }
}

if (-not $pythonExe) {
    Write-Err "Python not found. Please install Python 3.9+."
    Write-Host ""
    Write-Host "Press Enter to close..." -ForegroundColor Yellow
    $null = Read-Host
    exit 1
}

$mainPy = Join-Path $ServiceDir "main.py"

try {
    Start-Process -FilePath $pythonExe -ArgumentList "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir
    Start-Sleep -Seconds 3

    # Verify
    $listening = netstat -an 2>$null | Select-String ":42089.*LISTENING"
    if ($listening) {
        Write-OK "Service started (port 42089 listening)"
    } else {
        Write-Err "Service may not have started correctly"
        Write-Info "Check logs: $LogDir\service.log"
    }
} catch {
    Write-Err "Failed to start service: $_"
}

# Done
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Restart complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Log file: $LogDir\service.log" -ForegroundColor Gray
Write-Host "  Watch logs: Get-Content `"$LogDir\service.log`" -Tail 20 -Wait" -ForegroundColor Gray
Write-Host ""

Write-Host "Press Enter to close..." -ForegroundColor Cyan
$null = Read-Host

