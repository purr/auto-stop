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

# Configuration
$AppName = "AutoStopMedia"
$TaskName = "AutoStopMediaService"
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

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

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
Get-Process python*, py* -ErrorAction SilentlyContinue | ForEach-Object {
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

