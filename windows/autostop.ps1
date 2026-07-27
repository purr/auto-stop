#Requires -Version 5.1
<#
    Auto-Stop Media - Windows service manager.

    Just run it:  .\autostop.ps1
    Shows an interactive menu (install, update, restart, stop, logs, uninstall).
    No arguments. It elevates itself once at launch (needed for the auto-start task).
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ============================================================================
# AUTO-ELEVATE (needed for the scheduled task). Argless self-relaunch as admin.
# ============================================================================
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    $psExe = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { "pwsh.exe" } else { "powershell.exe" }
    try {
        Start-Process -FilePath $psExe -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$PSCommandPath`"" -Verb RunAs | Out-Null
        exit 0
    } catch {
        Write-Host "Elevation cancelled - continuing without admin (install/uninstall may fail)." -ForegroundColor Yellow
        Start-Sleep -Seconds 1
    }
}

# ============================================================================
# CONFIG
# ============================================================================
$AppName       = "AutoStopMedia"
$TaskName      = "AutoStopMediaService"
$Port          = 42089
$MinPython     = [Version]"3.9.0"
$InstallDir    = Join-Path $env:APPDATA $AppName
$ServiceDir    = Join-Path $InstallDir "service"
$LogDir        = Join-Path $InstallDir "logs"
$VersionFile   = Join-Path $InstallDir "version.txt"
$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceService = Join-Path $ScriptDir "service"

# Real version, read from config.py (never goes stale).
$Version = "1.0.0"
$cfgPy = Join-Path $SourceService "config.py"
if (Test-Path $cfgPy) {
    $m = Select-String -Path $cfgPy -Pattern 'VERSION\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $Version = $m.Matches[0].Groups[1].Value }
}

# ============================================================================
# OUTPUT
# ============================================================================
function Write-Banner {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Magenta
    Write-Host "   Auto-Stop Media  -  Windows Service   v$Version" -ForegroundColor Magenta
    Write-Host "==================================================" -ForegroundColor Magenta
}
function Write-Step([string]$m) { Write-Host ""; Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [+] $m" -ForegroundColor Green }
function Write-Err([string]$m)  { Write-Host "  [x] $m" -ForegroundColor Red }
function Write-Warn([string]$m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Info([string]$m) { Write-Host "  -   $m" -ForegroundColor Gray }
function Wait-Key { Write-Host ""; Write-Host "Press Enter to continue..." -ForegroundColor Cyan; $null = Read-Host }

# ============================================================================
# HELPERS
# ============================================================================
function Find-Python {
    foreach ($cmd in @("python", "python3", "py -3")) {
        try {
            $parts = $cmd -split " "
            $out = if ($parts.Count -gt 1) { & $parts[0] $parts[1] --version 2>&1 } else { & $cmd --version 2>&1 }
            if ($out -match "Python (\d+\.\d+\.\d+)" -and [Version]$Matches[1] -ge $MinPython) {
                $isPy3 = ($cmd -eq "py -3")
                $exePath = if ($isPy3) { & py -3 -c "import sys;print(sys.executable)" 2>$null } else { & $cmd -c "import sys;print(sys.executable)" 2>$null }
                $exePath = ("$exePath").Trim()
                $wexe = $null
                if ($exePath) {
                    $cand = $exePath -replace 'python\.exe$', 'pythonw.exe'
                    $wexe = if (Test-Path $cand) { $cand } else { $exePath }
                }
                return @{ Version = $Matches[1]; Cmd = $cmd; IsPy3 = $isPy3; Exe = $wexe }
            }
        } catch { continue }
    }
    return $null
}

function Invoke-Py([hashtable]$Py, [string[]]$PyArgs) {
    if ($Py.IsPy3) { & py -3 @PyArgs } else { & $Py.Cmd @PyArgs }
}

function Test-PortListening { [bool](netstat -an 2>$null | Select-String ":$Port.*LISTENING") }

function Stop-ServiceProcesses {
    $count = 0
    Get-Process -Name "python*", "pythonw*" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            if ($cmdLine -and $cmdLine -like "*main.py*" -and $cmdLine -like "*AutoStopMedia*") {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                $count++
            }
        } catch {}
    }
    return $count
}

function Start-ServiceProcess([hashtable]$Py) {
    $mainPy = Join-Path $ServiceDir "main.py"
    if ($Py.Exe)      { Start-Process -FilePath $Py.Exe -ArgumentList "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir }
    elseif ($Py.IsPy3){ Start-Process -FilePath "py" -ArgumentList "-3", "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir }
    else              { Start-Process -FilePath "python" -ArgumentList "`"$mainPy`"" -WindowStyle Hidden -WorkingDirectory $ServiceDir }
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 200; if (Test-PortListening) { return $true } }
    return $false
}

function Copy-ServiceFiles {
    if (-not (Test-Path $SourceService)) { Write-Err "Source 'service' folder not found next to this script."; return $false }
    New-Item -ItemType Directory -Path $ServiceDir -Force | Out-Null
    Get-ChildItem -Path $SourceService -Filter "*.py" -File | ForEach-Object { Copy-Item $_.FullName -Destination $ServiceDir -Force }
    foreach ($extra in @("requirements.txt", "INFO.txt")) {
        $src = Join-Path $ScriptDir $extra
        if (Test-Path $src) { Copy-Item $src -Destination $InstallDir -Force }
    }
    return $true
}

# Verify deps import; install them if not. Returns $true on success.
function Install-Deps([hashtable]$Py) {
    $probe = 'import websockets, winrt.windows.media.control, winrt.windows.storage.streams, pystray, PIL, pycaw, psutil'
    $probeOk = $false
    try { Invoke-Py $Py @('-c', $probe) 2>$null; $probeOk = ($LASTEXITCODE -eq 0) } catch { $probeOk = $false }
    if ($probeOk) { Write-Ok "All dependencies already installed"; return $true }
    Write-Info "Installing dependencies (first run may take a minute)..."
    $req = Join-Path $InstallDir "requirements.txt"
    if (Test-Path $req) { Invoke-Py $Py @('-m', 'pip', 'install', '-r', $req, '--quiet', '--disable-pip-version-check') }
    else { Invoke-Py $Py @('-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
                'websockets>=12.0', 'winrt-runtime>=3.0.0', 'winrt-Windows.Foundation>=3.0.0',
                'winrt-Windows.Foundation.Collections>=3.0.0', 'winrt-Windows.Media.Control>=3.0.0',
                'winrt-Windows.Storage.Streams>=3.0.0', 'pystray>=0.19.0', 'Pillow>=10.0.0',
                'pycaw>=20230407', 'psutil>=5.9.0') }
    if ($LASTEXITCODE -ne 0) { Write-Err "Dependency install failed."; return $false }
    Write-Ok "Dependencies installed"; return $true
}

function Register-AutoStartTask([hashtable]$Py) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    $mainPy = Join-Path $ServiceDir "main.py"
    # Prefer the windowless pythonw (no console at logon); fall back to the launcher.
    if ($Py.Exe)       { $exe = $Py.Exe; $taskArgs = "`"$mainPy`"" }
    elseif ($Py.IsPy3) { $exe = "pyw";   $taskArgs = "-3 `"$mainPy`"" }
    else               { $exe = "pythonw"; $taskArgs = "`"$mainPy`"" }
    $action   = New-ScheduledTaskAction -Execute $exe -Argument $taskArgs -WorkingDirectory $ServiceDir
    $trigger  = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "Auto-Stop Media background service." | Out-Null
}

function Remove-AutoStartTask {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
}

# ============================================================================
# ACTIONS
# ============================================================================
function Invoke-Install {
    Write-Step "Checking prerequisites..."
    if ([Version](Get-CimInstance Win32_OperatingSystem).Version -lt [Version]"10.0") { Write-Err "Windows 10 or higher required."; return }
    $py = Find-Python
    if (-not $py) { Write-Err "Python $MinPython+ not found. Install from python.org and add it to PATH."; return }
    Write-Ok "Python $($py.Version) ($($py.Cmd))"

    Write-Step "Copying service files..."
    if (-not (Copy-ServiceFiles)) { return }
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    Write-Ok "Files installed to $ServiceDir"

    Write-Step "Checking Python dependencies..."
    if (-not (Install-Deps $py)) { return }

    Write-Step "Setting up auto-start (Task Scheduler)..."
    try { Register-AutoStartTask $py; Write-Ok "Auto-start enabled (runs at logon, restarts on crash)" }
    catch { Write-Warn "Could not create the scheduled task: $_" }

    $Version | Out-File -FilePath $VersionFile -Encoding UTF8 -NoNewline

    Write-Step "Starting service..."
    [void](Stop-ServiceProcesses); Start-Sleep -Milliseconds 400
    if (Start-ServiceProcess $py) { Write-Ok "Service running (port $Port)" } else { Write-Warn "Service may not have started - check the logs." }

    Write-Host ""
    Write-Ok "Install complete (v$Version)."
}

function Invoke-Update {
    Write-Step "Updating service files..."
    if (-not (Test-Path $ServiceDir)) { Write-Err "Not installed yet. Choose Install first."; return }
    $py = Find-Python
    if (-not $py) { Write-Err "Python not found."; return }
    if (-not (Copy-ServiceFiles)) { return }   # copies .py + requirements.txt
    Write-Ok "Files updated to v$Version"
    if (-not (Install-Deps $py)) { return }     # pick up any new dependency
    $Version | Out-File -FilePath $VersionFile -Encoding UTF8 -NoNewline
    Invoke-Restart
}

function Invoke-Restart {
    Write-Step "Restarting service..."
    if (-not (Test-Path $ServiceDir)) { Write-Err "Not installed. Choose Install first."; return }
    $n = Stop-ServiceProcesses
    if ($n -gt 0) { Write-Info "Stopped $n process(es)"; Start-Sleep -Milliseconds 500 }
    $py = Find-Python
    if (-not $py) { Write-Err "Python not found."; return }
    if (Start-ServiceProcess $py) { Write-Ok "Service running (port $Port)" } else { Write-Warn "Service may not have started - check the logs." }
}

function Invoke-Stop {
    Write-Step "Stopping service..."
    $n = Stop-ServiceProcesses
    if ($n -gt 0) { Write-Ok "Stopped $n process(es)" } else { Write-Info "No running instances found" }
}

function Invoke-Uninstall {
    Write-Step "Uninstalling..."
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
    $n = Stop-ServiceProcesses
    Write-Info "Stopped $n process(es)"
    Remove-AutoStartTask
    Write-Ok "Auto-start removed"
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "Removed files"
    }
    Write-Host ""
    Write-Ok "Uninstalled. (The browser extension still works for browser media.)"
}

function Invoke-Logs([bool]$Follow) {
    $logFile = Join-Path $LogDir ("service-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
    if (-not (Test-Path $logFile)) {
        $recent = Get-ChildItem -Path $LogDir -Filter "service-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($recent) { $logFile = $recent.FullName } else { Write-Err "No logs found. Is the service installed/running?"; return }
    }
    Write-Host ""; Write-Host "Log: $logFile" -ForegroundColor Gray; Write-Host ""
    if ($Follow) { Write-Host "Following live (Ctrl+C to stop)..." -ForegroundColor Yellow; Get-Content $logFile -Tail 40 -Wait }
    else { Get-Content $logFile -Tail 50 }
}

# Is the installed copy up to date? Verifies by hashing each installed service file against
# the source (so it's true even if the version number wasn't bumped) — not just version.txt.
function Get-UpdateStatus {
    if (-not (Test-Path $ServiceDir))    { return @{ State = 'NotInstalled' } }
    if (-not (Test-Path $SourceService)) { return @{ State = 'NoSource' } }
    $installedVer = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { '?' }
    $differ = @()
    foreach ($src in Get-ChildItem -Path $SourceService -Filter '*.py' -File) {
        $dst = Join-Path $ServiceDir $src.Name
        if (-not (Test-Path $dst)) { $differ += $src.Name; continue }
        if ((Get-FileHash $src.FullName).Hash -ne (Get-FileHash $dst).Hash) { $differ += $src.Name }
    }
    if ($differ.Count -gt 0) { return @{ State = 'UpdateAvailable'; Installed = $installedVer; Source = $Version; Changed = ($differ -join ', ') } }
    return @{ State = 'UpToDate'; Installed = $installedVer; Source = $Version }
}

function Show-Status {
    $installed = Test-Path $ServiceDir
    $task      = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $running   = Test-PortListening
    $instVer   = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { "none" }
    $upd       = Get-UpdateStatus
    Write-Host ""
    Write-Host "  Installed  : $(if ($installed) { "yes (v$instVer)" } else { 'no' })"          -ForegroundColor $(if ($installed) { 'Green' } else { 'Yellow' })
    Write-Host "  Auto-start : $(if ($task) { $task.State } else { 'not configured' })"          -ForegroundColor Gray
    Write-Host "  Running    : $(if ($running) { "yes (port $Port)" } else { 'no' })"            -ForegroundColor $(if ($running) { 'Green' } else { 'Yellow' })
    Write-Host "  Source ver : v$Version"                                                        -ForegroundColor Gray
    switch ($upd.State) {
        'UpToDate'        { Write-Host "  Update     : up to date (files match source)"          -ForegroundColor Green }
        'UpdateAvailable' { Write-Host "  Update     : UPDATE AVAILABLE  v$($upd.Installed) -> v$($upd.Source)" -ForegroundColor Cyan
                            Write-Host "               (changed: $($upd.Changed))  -  use option 2" -ForegroundColor DarkCyan }
        'NotInstalled'    { Write-Host "  Update     : not installed yet"                        -ForegroundColor Yellow }
        'NoSource'        { Write-Host "  Update     : source 'service' folder not found"        -ForegroundColor Yellow }
    }
}

# ============================================================================
# MENU
# ============================================================================
function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Banner
        Show-Status
        $installed = Test-Path $ServiceDir
        Write-Host ""
        Write-Host "  +------------------- MENU -------------------+" -ForegroundColor DarkCyan
        Write-Host "   1) $(if ($installed) { 'Reinstall / update' } else { 'Install' })" -ForegroundColor Green
        Write-Host "   2) Update files + restart (fast)"
        Write-Host "   3) Restart service"
        Write-Host "   4) Stop service"
        Write-Host "   5) View logs (last 50)"
        Write-Host "   6) Follow logs (live)"
        Write-Host "   7) Uninstall" -ForegroundColor Red
        Write-Host "   0) Exit" -ForegroundColor Gray
        Write-Host "  +--------------------------------------------+" -ForegroundColor DarkCyan
        $choice = (Read-Host "  Select").Trim()
        try {
            switch ($choice) {
                "1" { Invoke-Install;     Wait-Key }
                "2" { Invoke-Update;      Wait-Key }
                "3" { Invoke-Restart;     Wait-Key }
                "4" { Invoke-Stop;        Wait-Key }
                "5" { Invoke-Logs $false; Wait-Key }
                "6" { Invoke-Logs $true }
                "7" { Invoke-Uninstall;   Wait-Key }
                "0" { return }
                default { Write-Warn "Invalid choice."; Wait-Key }
            }
        } catch { Write-Err $_.Exception.Message; Wait-Key }
    }
}

Show-Menu
