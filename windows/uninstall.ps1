#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls the Auto-Stop Media Windows service.

.DESCRIPTION
    This script removes the Auto-Stop Media background service:
    - Stops the running service
    - Removes the scheduled task
    - Optionally removes all files and logs

.PARAMETER KeepLogs
    Keep log files after uninstallation.

.PARAMETER KeepConfig
    Keep all files (only remove scheduled task).

.EXAMPLE
    .\uninstall.ps1

.EXAMPLE
    .\uninstall.ps1 -KeepLogs
#>

[CmdletBinding()]
param(
    [switch]$KeepLogs,
    [switch]$KeepConfig
)

# ============================================================================
# ERROR HANDLING & POWERSHELL 5.1 COMPATIBILITY
# ============================================================================

$ErrorActionPreference = "Stop"

# Function to wait for user input before closing
function Wait-ForExit {
    param([int]$ExitCode = 0)
    Write-Host ""
    Write-Host "Press Enter to close this window..." -ForegroundColor Cyan
    $null = Read-Host
    exit $ExitCode
}

# Trap errors to prevent window from closing
trap {
    Write-Host ""
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    Wait-ForExit 1
}

# ============================================================================
# ADMIN ELEVATION
# ============================================================================

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Check if scheduled task exists and if we need admin to remove it
$TaskName = "AutoStopMediaService"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# If task exists and we're not admin, try to elevate
if ($task -and -not $isAdmin) {
    Write-Host "Requesting administrator privileges to remove scheduled task..." -ForegroundColor Yellow

    # Try to use pwsh.exe (PowerShell 7) first, fall back to powershell.exe
    $psExe = "pwsh.exe"
    if (-not (Get-Command $psExe -ErrorAction SilentlyContinue)) {
        $psExe = "powershell.exe"
    }

    # Build argument list
    $argList = "-ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
    if ($KeepLogs) { $argList += " -KeepLogs" }
    if ($KeepConfig) { $argList += " -KeepConfig" }

    try {
        # Start elevated process
        $proc = Start-Process -FilePath $psExe -ArgumentList $argList -Verb RunAs -PassThru
        # Don't wait - let the elevated window handle itself
        exit 0
    }
    catch {
        Write-Host "Failed to elevate. Will attempt to remove task without admin (may fail)." -ForegroundColor Yellow
        Write-Host "Press Enter to continue anyway, or Ctrl+C to cancel..." -ForegroundColor Yellow
        $null = Read-Host
    }
}

# Configuration
$AppName = "AutoStopMedia"
$InstallDir = Join-Path $env:APPDATA $AppName

# Colors for output
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White",
        [switch]$NoNewline
    )

    $params = @{
        Object = $Message
        ForegroundColor = $Color
    }
    if ($NoNewline) {
        $params.NoNewline = $true
    }
    Write-Host @params
}

function Write-Step {
    param([string]$Message)
    Write-ColorOutput "`n[$((Get-Date).ToString('HH:mm:ss'))] " -Color "DarkGray" -NoNewline
    Write-ColorOutput $Message -Color "Cyan"
}

function Write-Success {
    param([string]$Message)
    Write-ColorOutput "  ✓ $Message" -Color "Green"
}

function Write-Error2 {
    param([string]$Message)
    Write-ColorOutput "  ✗ $Message" -Color "Red"
}

function Write-Warning2 {
    param([string]$Message)
    Write-ColorOutput "  ⚠ $Message" -Color "Yellow"
}

function Write-Info {
    param([string]$Message)
    Write-ColorOutput "  → $Message" -Color "Gray"
}

# Banner
Write-ColorOutput @"

╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║          Auto-Stop Media Service Uninstaller                  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
"@ -Color "Magenta"

# ============================================================================
# STOP SERVICE
# ============================================================================

Write-Step "Stopping service..."

# Re-check task (in case it was removed or doesn't exist)
if (-not $task) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

if ($task) {
    if ($task.State -eq "Running") {
        try {
            Stop-ScheduledTask -TaskName $TaskName
            Write-Success "Service stopped"
            Start-Sleep -Seconds 2
        } catch {
            Write-Warning2 "Could not stop service gracefully: $_"
        }
    } else {
        Write-Info "Service was not running"
    }
} else {
    Write-Info "Scheduled task not found"
}

# Kill any remaining Python processes running our script
$mainPy = Join-Path $InstallDir "service\main.py"
Get-Process -Name "python*", "pythonw*" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
        if ($cmdLine -and $cmdLine -like "*$mainPy*") {
            Write-Info "Terminating orphan process: $($_.Id)"
            Stop-Process -Id $_.Id -Force
        }
    } catch {
        # Ignore errors
    }
}

# ============================================================================
# REMOVE SCHEDULED TASK
# ============================================================================

Write-Step "Removing scheduled task..."

if ($task) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Success "Scheduled task removed"
    } catch {
        Write-Error2 "Failed to remove scheduled task: $_"
    }
} else {
    Write-Info "No scheduled task to remove"
}

# ============================================================================
# REMOVE FILES
# ============================================================================

if (-not $KeepConfig) {
    Write-Step "Removing installation files..."

    if (Test-Path $InstallDir) {
        try {
            if ($KeepLogs) {
                # Remove everything except logs
                Get-ChildItem -Path $InstallDir -Exclude "logs" | Remove-Item -Recurse -Force
                Write-Success "Removed service files (kept logs)"
                Write-Info "Logs preserved at: $InstallDir\logs"
            } else {
                # Remove everything
                Remove-Item -Path $InstallDir -Recurse -Force
                Write-Success "Removed all files"
            }
        } catch {
            Write-Error2 "Failed to remove files: $_"
            Write-Info "You may need to manually delete: $InstallDir"
        }
    } else {
        Write-Info "Installation directory not found"
    }
} else {
    Write-Info "Keeping configuration files as requested"
    Write-Info "Files location: $InstallDir"
}

# ============================================================================
# DONE
# ============================================================================

Write-ColorOutput @"

╔═══════════════════════════════════════════════════════════════╗
║                   Uninstallation Complete!                    ║
╚═══════════════════════════════════════════════════════════════╝
"@ -Color "Green"

if ($KeepConfig -or $KeepLogs) {
    Write-ColorOutput @"

  Some files were preserved:
  $InstallDir

  To completely remove, delete this folder manually.
"@ -Color "Yellow"
}

Write-ColorOutput @"

  The Auto-Stop Media Windows service has been removed.
  The Firefox extension will still work for browser media.

  To reinstall, run: .\install.ps1

"@ -Color "White"

# Wait for user to close window
Wait-ForExit 0

