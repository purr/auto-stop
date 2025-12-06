# Auto-Stop Media - Windows Service

This is the Windows background service component of Auto-Stop Media. It enables the browser extension to control and monitor desktop media applications like Spotify, VLC, Windows Media Player, etc.

## Requirements

- **Windows 10/11** (64-bit)
- **Python 3.9+** (must be in PATH)
- **pip** (comes with Python)

No Visual Studio or build tools required - all dependencies have prebuilt wheels.

## Installation

### Quick Install

1. Open PowerShell as your normal user (not Admin)
2. Navigate to this folder:
   ```powershell
   cd path\to\auto-stop\windows
   ```
3. Run the installer:
   ```powershell
   .\install.ps1
   ```

The installer will:
- Check Python version and prerequisites
- Create installation directory at `%APPDATA%\AutoStopMedia`
- Install Python dependencies (`websockets`, `winsdk`)
- Create a scheduled task to start the service at login
- Start the service immediately

### Installation Options

```powershell
# Force reinstall even if same version exists
.\install.ps1 -Force

# Install but don't start the service yet
.\install.ps1 -NoStart
```

## Uninstallation

```powershell
.\uninstall.ps1
```

Options:
```powershell
# Keep log files
.\uninstall.ps1 -KeepLogs

# Only remove scheduled task (keep all files)
.\uninstall.ps1 -KeepConfig
```

## How It Works

1. **Service** runs as a background Python process (no window)
2. **WebSocket Server** listens on `ws://127.0.0.1:42089`
3. **Browser Extension** connects to the WebSocket
4. **Windows Media API** detects and controls desktop media

When you play media in the browser:
- Desktop media (Spotify, etc.) automatically pauses
- Desktop media appears in the extension popup with a 🖥️ icon

When you play desktop media:
- Browser media automatically pauses
- You can control desktop media from the browser popup

## Files & Locations

After installation:
```
%APPDATA%\AutoStopMedia\
├── service\
│   ├── main.py              # Service entry point
│   ├── media_manager.py     # Windows media control
│   ├── websocket_server.py  # WebSocket server
│   └── config.py            # Configuration
├── logs\
│   └── service.log          # Service logs (rotated)
├── requirements.txt
└── version.txt              # Installed version
```

## Managing the Service

### Using PowerShell

```powershell
# Stop the service
Stop-ScheduledTask -TaskName "AutoStopMediaService"

# Start the service
Start-ScheduledTask -TaskName "AutoStopMediaService"

# Check service status
Get-ScheduledTask -TaskName "AutoStopMediaService" | Select-Object State
```

### Using Task Scheduler

1. Press `Win + R`, type `taskschd.msc`, press Enter
2. Find "AutoStopMediaService" in the task list
3. Right-click to Start, Stop, Disable, etc.

## Viewing Logs

```powershell
# View last 50 lines
Get-Content "$env:APPDATA\AutoStopMedia\logs\service.log" -Tail 50

# Follow log in real-time
Get-Content "$env:APPDATA\AutoStopMedia\logs\service.log" -Wait -Tail 20
```

Logs are automatically rotated:
- Max size: 5 MB per file
- Keeps 3 backup files (`service.log.1`, `.2`, `.3`)

## Troubleshooting

### Service won't start

1. Check Python is in PATH:
   ```powershell
   python --version
   ```

2. Check dependencies are installed:
   ```powershell
   python -m pip list | Select-String "websockets|winrt"
   ```

3. Check logs for errors:
   ```powershell
   Get-Content "$env:APPDATA\AutoStopMedia\logs\service.log" -Tail 100
   ```

### Extension shows "Desktop offline"

1. Make sure the service is running (check Task Scheduler)
2. Check if port 42089 is in use:
   ```powershell
   netstat -an | Select-String "42089"
   ```
3. Restart the service:
   ```powershell
   Stop-ScheduledTask -TaskName "AutoStopMediaService"
   Start-ScheduledTask -TaskName "AutoStopMediaService"
   ```

### Desktop media not detected

- Make sure the media app is actually playing
- Some apps don't expose media session info to Windows
- Try pausing and playing the media again

### Common Errors

| Error | Solution |
|-------|----------|
| `Port 42089 already in use` | Another instance is running. Stop it first or restart your PC. |
| `winrt packages not found` | Run `python -m pip install winrt-runtime winrt-Windows.Media.Control` |
| `Python not found` | Install Python 3.9+ and add to PATH |

## Manual Installation

If the installer doesn't work, you can install manually:

1. Create the folder:
   ```powershell
   mkdir "$env:APPDATA\AutoStopMedia\service" -Force
   mkdir "$env:APPDATA\AutoStopMedia\logs" -Force
   ```

2. Copy files:
   ```powershell
   Copy-Item "service\*" "$env:APPDATA\AutoStopMedia\service\" -Force
   Copy-Item "requirements.txt" "$env:APPDATA\AutoStopMedia\" -Force
   ```

3. Install dependencies:
   ```powershell
   python -m pip install -r "$env:APPDATA\AutoStopMedia\requirements.txt"
   ```

4. Create scheduled task (Task Scheduler GUI) or run manually:
   ```powershell
   python "$env:APPDATA\AutoStopMedia\service\main.py"
   ```

## Development

To run the service manually for debugging:

```powershell
cd "$env:APPDATA\AutoStopMedia\service"

# Run without auto-restart (Ctrl+C to stop)
python main.py --no-restart

# Run with auto-restart
python main.py
```

## Security Notes

- The service only listens on `127.0.0.1` (localhost) - not accessible from network
- No admin privileges required
- No data is sent outside your computer
- The extension can only connect from the same machine

