#Requires -Version 7.0
<#
.SYNOPSIS
    Installs the Auto-Stop Media Windows service.

.DESCRIPTION
    This script installs the Auto-Stop Media background service that enables
    the browser extension to control Windows desktop media (Spotify, etc.).

    It performs the following:
    - Checks prerequisites (Python 3.9+, pip)
    - Creates installation directory in %APPDATA%\AutoStopMedia
    - Copies service files
    - Installs Python dependencies
    - Creates a scheduled task to run at startup
    - Optionally starts the service immediately

.PARAMETER Force
    Force reinstall even if already installed.

.PARAMETER NoStart
    Don't start the service after installation.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Force

.NOTES
    Requires PowerShell 7.0 or higher, Windows 10/11, and Python 3.9 or higher.
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoStart,
    [switch]$NoElevate
)

# ============================================================================
# POWERSHELL 7 REQUIREMENT CHECK
# ============================================================================

# Check PowerShell version - must be 7.0 or higher
$psVersion = $PSVersionTable.PSVersion
if ($psVersion.Major -lt 7) {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "║          PowerShell 7.0 or higher is required!               ║" -ForegroundColor Red
    Write-Host "╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Red
    Write-Host ""
    Write-Host "Current PowerShell version: $($psVersion.Major).$($psVersion.Minor)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please install PowerShell 7 from:" -ForegroundColor Cyan
    Write-Host "  https://aka.ms/PSWindows" -ForegroundColor White
    Write-Host ""
    Write-Host "Or use winget:" -ForegroundColor Cyan
    Write-Host "  winget install --id Microsoft.PowerShell --source winget" -ForegroundColor White
    Write-Host ""
    Write-Host "After installing PowerShell 7, run this script again." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press Enter to exit..." -ForegroundColor Gray
    $null = Read-Host
    exit 1
}

# ============================================================================
# ERROR HANDLING
# ============================================================================

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speed up web requests

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

if (-not $isAdmin -and -not $NoElevate) {
    Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow

    # Try to use pwsh.exe (PowerShell 7) first, fall back to powershell.exe
    $psExe = "pwsh.exe"
    if (-not (Get-Command $psExe -ErrorAction SilentlyContinue)) {
        $psExe = "powershell.exe"
    }

    # Build argument list
    $argList = "-ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
    if ($Force) { $argList += " -Force" }
    if ($NoStart) { $argList += " -NoStart" }
    $argList += " -NoElevate"  # Prevent infinite loop

    try {
        # Start elevated process
        $proc = Start-Process -FilePath $psExe -ArgumentList $argList -Verb RunAs -PassThru
        # Don't wait - let the elevated window handle itself
        exit 0
    }
    catch {
        Write-Host "Failed to elevate. Running without admin (scheduled task may not be created)." -ForegroundColor Red
        Write-Host "Press Enter to continue anyway, or Ctrl+C to cancel..." -ForegroundColor Yellow
        $null = Read-Host
    }
}

# Configuration
$AppName = "AutoStopMedia"
$TaskName = "AutoStopMediaService"
$MinPythonVersion = [Version]"3.9.0"
$ServiceVersion = "1.0.0"
$InstallDir = Join-Path $env:APPDATA $AppName
$ServiceDir = Join-Path $InstallDir "service"
$LogDir = Join-Path $InstallDir "logs"
$VersionFile = Join-Path $InstallDir "version.txt"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

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
║   █████╗ ██╗   ██╗████████╗ ██████╗       ███████╗████████╗   ║
║  ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗      ██╔════╝╚══██╔══╝   ║
║  ███████║██║   ██║   ██║   ██║   ██║█████╗███████╗   ██║      ║
║  ██╔══██║██║   ██║   ██║   ██║   ██║╚════╝╚════██║   ██║      ║
║  ██║  ██║╚██████╔╝   ██║   ╚██████╔╝      ███████║   ██║      ║
║  ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝       ╚══════╝   ╚═╝      ║
║                                                               ║
║              Windows Media Service Installer                  ║
║                      Version $ServiceVersion                            ║
╚═══════════════════════════════════════════════════════════════╝
"@ -Color "Magenta"

Write-ColorOutput "`nThis will install the Auto-Stop Media background service." -Color "White"
Write-ColorOutput "The service enables browser extension to control desktop media.`n" -Color "Gray"

# ============================================================================
# PREREQUISITE CHECKS
# ============================================================================

Write-Step "Checking prerequisites..."

# Check Windows version
$osInfo = Get-CimInstance Win32_OperatingSystem
$winVersion = [Version]$osInfo.Version

if ($winVersion.Major -lt 10) {
    Write-Error2 "Windows 10 or higher is required. You have: $($osInfo.Caption)"
    Wait-ForExit 1
}
Write-Success "Windows version: $($osInfo.Caption)"

# Check Python installation
Write-Info "Looking for Python..."

$pythonCmd = $null
$pythonVersion = $null

# Try different Python commands
foreach ($cmd in @("python", "python3", "py -3")) {
    try {
        $cmdParts = $cmd -split " "
        $result = if ($cmdParts.Count -gt 1) {
            & $cmdParts[0] $cmdParts[1] --version 2>&1
        } else {
            & $cmd --version 2>&1
        }

        if ($result -match "Python (\d+\.\d+\.\d+)") {
            $testVersion = [Version]$Matches[1]
            if ($testVersion -ge $MinPythonVersion) {
                $pythonCmd = $cmd
                $pythonVersion = $testVersion
                break
            }
        }
    }
    catch {
        continue
    }
}

if (-not $pythonCmd) {
    Write-Error2 "Python $MinPythonVersion or higher is required but not found."
    Write-ColorOutput @"

Please install Python from https://www.python.org/downloads/
Make sure to check "Add Python to PATH" during installation.

After installing Python, run this script again.
"@ -Color "Yellow"
    Wait-ForExit 1
}

Write-Success "Python $pythonVersion found ($pythonCmd)"

# Check pip
Write-Info "Checking pip..."

try {
    $pipResult = if ($pythonCmd -eq "py -3") {
        & py -3 -m pip --version 2>&1
    } else {
        & $pythonCmd -m pip --version 2>&1
    }

    if ($pipResult -match "pip (\d+\.\d+)") {
        Write-Success "pip $($Matches[1]) found"
    } else {
        throw "pip not found"
    }
}
catch {
    Write-Error2 "pip is not available. Please reinstall Python with pip enabled."
    Wait-ForExit 1
}

# ============================================================================
# CHECK EXISTING INSTALLATION
# ============================================================================

Write-Step "Checking for existing installation..."

$existingVersion = $null
if (Test-Path $VersionFile) {
    $existingVersion = Get-Content $VersionFile -Raw
    $existingVersion = $existingVersion.Trim()
}

if ($existingVersion) {
    Write-Info "Found existing installation: v$existingVersion"

    if ($existingVersion -eq $ServiceVersion -and -not $Force) {
        Write-Warning2 "Same version already installed. Use -Force to reinstall."

        # Check if service is running
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Write-Success "Scheduled task exists and is: $($task.State)"
        }

        Write-ColorOutput "`nNo changes made. Service should already be running." -Color "Green"
        exit 0
    }

    if ([Version]$existingVersion -gt [Version]$ServiceVersion) {
        Write-Warning2 "Installed version ($existingVersion) is newer than this installer ($ServiceVersion)"
        if (-not $Force) {
            Write-ColorOutput "Use -Force to downgrade." -Color "Yellow"
            Wait-ForExit 1
        }
    }

    Write-Info "Upgrading from v$existingVersion to v$ServiceVersion"

    # Stop existing service if running
    Write-Info "Stopping existing service..."
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
} else {
    Write-Success "No existing installation found"
}

# ============================================================================
# CREATE DIRECTORIES
# ============================================================================

Write-Step "Creating installation directories..."

try {
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Write-Success "Created: $InstallDir"
    } else {
        Write-Info "Directory exists: $InstallDir"
    }

    if (-not (Test-Path $ServiceDir)) {
        New-Item -ItemType Directory -Path $ServiceDir -Force | Out-Null
        Write-Success "Created: $ServiceDir"
    }

    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        Write-Success "Created: $LogDir"
    }
}
catch {
    Write-Error2 "Failed to create directories: $_"
    Wait-ForExit 1
}

# ============================================================================
# COPY SERVICE FILES
# ============================================================================

Write-Step "Copying service files..."

$sourceServiceDir = Join-Path $ScriptDir "service"

if (-not (Test-Path $sourceServiceDir)) {
    Write-Error2 "Service directory not found: $sourceServiceDir"
    Write-ColorOutput "Make sure you're running this script from the windows folder." -Color "Yellow"
    Wait-ForExit 1
}

try {
    # Copy all Python files
    $filesToCopy = Get-ChildItem -Path $sourceServiceDir -Filter "*.py" -File
    foreach ($file in $filesToCopy) {
        Copy-Item -Path $file.FullName -Destination $ServiceDir -Force
        Write-Success "Copied: $($file.Name)"
    }

    # Copy requirements.txt
    $requirementsSource = Join-Path $ScriptDir "requirements.txt"
    if (Test-Path $requirementsSource) {
        Copy-Item -Path $requirementsSource -Destination $InstallDir -Force
        Write-Success "Copied: requirements.txt"
    }

    # Copy INFO.txt
    $infoSource = Join-Path $ScriptDir "INFO.txt"
    if (Test-Path $infoSource) {
        Copy-Item -Path $infoSource -Destination $InstallDir -Force
        Write-Success "Copied: INFO.txt"
    }
}
catch {
    Write-Error2 "Failed to copy files: $_"
    Wait-ForExit 1
}

# ============================================================================
# INSTALL PYTHON DEPENDENCIES
# ============================================================================

Write-Step "Installing Python dependencies..."

# Required packages
$requiredPackages = @(
    @{ Name = "websockets"; MinVersion = "12.0"; Description = "WebSocket server" },
    @{ Name = "winrt-runtime"; MinVersion = "3.0.0"; Description = "Windows Runtime" },
    @{ Name = "winrt-Windows.Foundation"; MinVersion = "3.0.0"; Description = "Windows Foundation" },
    @{ Name = "winrt-Windows.Foundation.Collections"; MinVersion = "3.0.0"; Description = "Collections API" },
    @{ Name = "winrt-Windows.Media.Control"; MinVersion = "3.0.0"; Description = "Media control API" },
    @{ Name = "winrt-Windows.Storage.Streams"; MinVersion = "3.0.0"; Description = "Stream utilities" },
    @{ Name = "pystray"; MinVersion = "0.19.0"; Description = "System tray icon" },
    @{ Name = "Pillow"; MinVersion = "10.0.0"; Description = "Image processing" },
    @{ Name = "pycaw"; MinVersion = "20230407"; Description = "Audio session detection" },
    @{ Name = "psutil"; MinVersion = "5.9.0"; Description = "Process utilities" }
)

# Function to check if a package is installed
function Get-InstalledPackageVersion {
    param([string]$PackageName)
    try {
        $result = if ($pythonCmd -eq "py -3") {
            & py -3 -m pip show $PackageName 2>$null
        } else {
            & $pythonCmd -m pip show $PackageName 2>$null
        }
        if ($result) {
            $versionLine = $result | Where-Object { $_ -match "^Version:" }
            if ($versionLine -match "Version:\s*(.+)") {
                return $Matches[1].Trim()
            }
        }
    }
    catch {
        # Ignore errors
    }
    return $null
}

# Function to install a single package with progress
function Install-PythonPackage {
    param(
        [string]$PackageName,
        [string]$MinVersion,
        [string]$Description
    )

    Write-ColorOutput "  ├─ " -Color "DarkGray" -NoNewline
    Write-ColorOutput "$Description " -Color "White" -NoNewline
    Write-ColorOutput "($PackageName)" -Color "DarkGray" -NoNewline

    # Check if already installed
    $installedVersion = Get-InstalledPackageVersion -PackageName $PackageName

    if ($installedVersion) {
        try {
            # Check if versions are date-based (YYYYMMDD format, like pycaw)
            $isDateVersion = ($installedVersion -match '^\d{8}$') -and ($MinVersion -match '^\d{8}$')

            if ($isDateVersion) {
                # Compare as integers for date-based versions
                $installedInt = [int]$installedVersion
                $minInt = [int]$MinVersion
                if ($installedInt -ge $minInt) {
                    Write-ColorOutput " → " -Color "DarkGray" -NoNewline
                    Write-ColorOutput "already installed (v$installedVersion)" -Color "DarkGreen"
                    return $true
                }
            } else {
                # Standard version comparison (X.Y.Z format)
                if ([Version]$installedVersion -ge [Version]$MinVersion) {
                    Write-ColorOutput " → " -Color "DarkGray" -NoNewline
                    Write-ColorOutput "already installed (v$installedVersion)" -Color "DarkGreen"
                    return $true
                }
            }
        }
        catch {
            # Version comparison failed, reinstall
        }
    }

    Write-ColorOutput " → " -Color "DarkGray" -NoNewline
    Write-ColorOutput "installing..." -Color "Yellow" -NoNewline

    # Install the package
    try {
        $pipArgs = @("-m", "pip", "install", "$PackageName>=$MinVersion", "--quiet", "--disable-pip-version-check")

        if ($pythonCmd -eq "py -3") {
            $process = Start-Process -FilePath "py" -ArgumentList (@("-3") + $pipArgs) -NoNewWindow -Wait -PassThru -RedirectStandardError "NUL"
        } else {
            $process = Start-Process -FilePath $pythonCmd -ArgumentList $pipArgs -NoNewWindow -Wait -PassThru -RedirectStandardError "NUL"
        }

        if ($process.ExitCode -eq 0) {
            # Get installed version after installation
            $installedVersion = Get-InstalledPackageVersion -PackageName $PackageName

            # Clear the "installing..." and show success
            Write-ColorOutput "`r  ├─ " -Color "DarkGray" -NoNewline
            Write-ColorOutput "$Description " -Color "White" -NoNewline
            Write-ColorOutput "($PackageName)" -Color "DarkGray" -NoNewline
            Write-ColorOutput " → " -Color "DarkGray" -NoNewline
            if ($installedVersion) {
                Write-ColorOutput "installed (v$installedVersion)" -Color "Green"
            } else {
                Write-ColorOutput "installed ✓" -Color "Green"
            }
            return $true
        } else {
            Write-ColorOutput " FAILED" -Color "Red"
            return $false
        }
    }
    catch {
        Write-ColorOutput " ERROR: $_" -Color "Red"
        return $false
    }
}

# Install each package
$totalPackages = $requiredPackages.Count
$installedCount = 0
$failedPackages = @()

Write-Info "Checking $totalPackages required packages..."
Write-Host ""

foreach ($pkg in $requiredPackages) {
    $success = Install-PythonPackage -PackageName $pkg.Name -MinVersion $pkg.MinVersion -Description $pkg.Description
    if ($success) {
        $installedCount++
    } else {
        $failedPackages += $pkg.Name
    }
}

Write-Host ""

if ($failedPackages.Count -gt 0) {
    Write-Error2 "Failed to install: $($failedPackages -join ', ')"
    Write-ColorOutput @"

Try running manually:
  $pythonCmd -m pip install $($failedPackages -join ' ')
"@ -Color "Yellow"
    Wait-ForExit 1
}

Write-Success "All $totalPackages dependencies ready"

# ============================================================================
# CREATE SCHEDULED TASK
# ============================================================================

Write-Step "Setting up Windows Task Scheduler..."

# Remove existing task if present
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Info "Removing existing scheduled task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Success "Removed old task"
}

try {
    # Build the Python command - use pythonw to run without console window
    $mainPy = Join-Path $ServiceDir "main.py"

    if ($pythonCmd -eq "py -3") {
        $pythonExe = "py"
        $pythonArgs = "-3 `"$mainPy`""
    } else {
        # Try to find pythonw.exe (no console window) or fall back to python.exe
        $pythonDir = Split-Path -Parent (Get-Command python -ErrorAction SilentlyContinue).Source
        $pythonwExe = Join-Path $pythonDir "pythonw.exe"

        if (Test-Path $pythonwExe) {
            $pythonExe = $pythonwExe
        } else {
            $pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
        }
        $pythonArgs = "`"$mainPy`""
    }

    Write-Info "Python executable: $pythonExe"
    Write-Info "Arguments: $pythonArgs"

    # Create the scheduled task action
    $action = New-ScheduledTaskAction -Execute $pythonExe -Argument $pythonArgs -WorkingDirectory $ServiceDir

    # Trigger: at user logon (for current user)
    $trigger = New-ScheduledTaskTrigger -AtLogOn

    # Settings
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 365)

    # Register the task (runs as current user by default)
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Auto-Stop Media background service - enables browser extension to control Windows media playback." `
        | Out-Null

    Write-Success "Scheduled task created: $TaskName"
    Write-Info "Task will run at user logon"

}
catch {
    Write-Error2 "Failed to create scheduled task: $_"
    Write-ColorOutput @"

You may need to create the task manually:
1. Open Task Scheduler (taskschd.msc)
2. Create a new task named "$TaskName"
3. Set trigger: "At log on"
4. Set action: Start program
   - Program: $pythonExe
   - Arguments: $pythonArgs
   - Start in: $ServiceDir
"@ -Color "Yellow"
    Wait-ForExit 1
}

# ============================================================================
# SAVE VERSION INFO
# ============================================================================

Write-Step "Saving version information..."

try {
    $ServiceVersion | Out-File -FilePath $VersionFile -Encoding UTF8 -NoNewline
    Write-Success "Version file saved"
}
catch {
    Write-Warning2 "Could not save version file: $_"
}

# ============================================================================
# START SERVICE
# ============================================================================

if (-not $NoStart) {
    Write-Step "Starting service..."

    try
    {
        # Kill any existing instances first
        Get-Process -Name "python*", "pythonw*" -ErrorAction SilentlyContinue | ForEach-Object {
            try
            {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                if ($cmdLine -and $cmdLine -like "*main.py*" -and $cmdLine -like "*AutoStopMedia*") {
                    Write-Info "Stopping existing instance (PID: $($_.Id))..."
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                }
            }
            catch
            {
                # Ignore errors
            }
        }
        Start-Sleep -Milliseconds 500

        # Start the service directly in the background
        $mainPy = Join-Path $ServiceDir "main.py"

        if ($pythonCmd -eq "py -3") {
            Start-Process -FilePath "py" -ArgumentList "-3", "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir
        } else {
            # Use pythonw.exe if available (no console window)
            $pythonDir = Split-Path -Parent (Get-Command python -ErrorAction SilentlyContinue).Source
            $pythonwExe = Join-Path $pythonDir "pythonw.exe"

            if (Test-Path $pythonwExe) {
                Start-Process -FilePath $pythonwExe -ArgumentList "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir
            } else {
                Start-Process -FilePath "python" -ArgumentList "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir
            }
        }

        Start-Sleep -Seconds 2

        # Verify it's running by checking if the port is listening
        $portCheck = netstat -an | Select-String ":42089.*LISTENING"
        if ($portCheck) {
            Write-Success "Service is now running (port 42089 listening)"
        } else {
            Write-Warning2 "Service may not have started correctly"
            Write-Info "Check logs at: $LogDir"
        }

        # Try to pin the tray icon (make it always visible)
        try
        {
            Write-Info "Attempting to pin tray icon..."
            Start-Sleep -Seconds 2  # Wait for icon to appear

            # The tray icon settings are stored in the registry
            # We need to find the icon by executable path and set IsPromoted = 1
            $notifyPath = "HKCU:\Control Panel\NotifyIconSettings"

            if (Test-Path $notifyPath) {
                $pythonwPath = if ($pythonCmd -eq "py -3") {
                    "py.exe"
                } else {
                    $pythonwExe
                }

                # Search for the tray icon entry
                Get-ChildItem $notifyPath -ErrorAction SilentlyContinue | ForEach-Object {
                    $execPath = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath
                    if ($execPath -and ($execPath -like "*pythonw*" -or $execPath -like "*python*")) {
                        # Found it! Set IsPromoted to 1 (always show)
                        Set-ItemProperty -Path $_.PSPath -Name "IsPromoted" -Value 1 -ErrorAction SilentlyContinue
                        Write-Success "Tray icon pinned to taskbar"
                    }
                }
            }
        }
        catch
        {
            Write-Info "Could not auto-pin tray icon. Right-click taskbar → Taskbar settings → Other system tray icons → Enable 'Python'"
        }
    }
    catch
    {
        Write-Warning2 "Could not start service: $_"
        Write-Info "Try starting manually: python `"$mainPy`""
    }
}

# ============================================================================
# DONE
# ============================================================================

Write-ColorOutput @"

╔═══════════════════════════════════════════════════════════════╗
║                   Installation Complete!                      ║
╚═══════════════════════════════════════════════════════════════╝
"@ -Color "Green"

$taskExists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-ColorOutput @"
  Installation directory: $InstallDir
  Log files:              $LogDir
  WebSocket port:         42089

"@ -Color "White"

if ($taskExists) {
    Write-ColorOutput "  Auto-start:           Enabled (runs at login)" -Color "Green"
} else {
    Write-ColorOutput "  Auto-start:           Not configured (needs admin)" -Color "Yellow"
    Write-ColorOutput @"

  To enable auto-start, run this script as Administrator, or:
  1. Press Win+R, type: shell:startup
  2. Create a shortcut to: pythonw.exe "$ServiceDir\main.py"
"@ -Color "DarkGray"
}

Write-ColorOutput @"

  To use with the Firefox extension:
  1. Install the Auto-Stop Media Firefox extension
  2. The extension will automatically detect the Windows service
  3. Desktop media (Spotify, etc.) will appear in the popup

  Commands:
  • View logs:      Get-Content "$LogDir\service.log" -Tail 50
  • Uninstall:      .\uninstall.ps1

"@ -Color "White"

# Wait for user to close window
Wait-ForExit 0

