#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the Auto-Stop Media Windows service.

.EXAMPLE
    .\stop.ps1
#>

$ErrorActionPreference = "SilentlyContinue"

Write-Host ""
Write-Host "Stopping Auto-Stop Media service..." -ForegroundColor Cyan

$stopped = 0
Get-Process -Name "python*", "pythonw*" | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
        if ($cmdLine -and ($cmdLine -like "*main.py*") -and ($cmdLine -like "*AutoStopMedia*")) {
            Write-Host "  Stopping PID $($_.Id)..." -ForegroundColor Gray
            Stop-Process -Id $_.Id -Force
            $stopped++
        }
    } catch {}
}

if ($stopped -gt 0) {
    Write-Host ""
    Write-Host "Stopped $stopped process(es)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "No running instances found" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press Enter to close..." -ForegroundColor Cyan
$null = Read-Host

