# Auto-Stop Media - Technical Documentation

This document contains technical details, architecture information, and development guides for Auto-Stop Media.

> 💡 **For user-friendly installation and usage instructions, see [README.md](README.md).**

## 📋 Table of Contents

- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Browser Extension](#browser-extension)
- [Windows Service](#windows-service)
- [Adding Site Adapters](#adding-site-adapters)
- [Building & Signing](#building--signing)
- [Known Limitations](#known-limitations)
- [Development](#development)

## 🏗️ Architecture

### Browser Extension

The extension uses a content script + background script architecture:

1. **Content Scripts** (`extension/content/`): Injected into every page
   - Detect media elements using site-specific adapters
   - Intercept play/pause events
   - Send state updates to background script

2. **Background Script** (`extension/background/`): Runs in extension context
   - Manages global media state (active media, paused stack)
   - Handles resume delays and volume fade-in
   - Connects to Windows service via WebSocket
   - Coordinates pausing/resuming across tabs

3. **Popup** (`extension/popup/`): User interface
   - Displays current state
   - Provides controls (play, pause, skip, prev)
   - Settings management

### Windows Service

The Windows service runs as a background Python process:

1. **WebSocket Server** (`websocket_server.py`): Listens on `ws://127.0.0.1:42089`
   - Accepts connections from browser extension
   - Broadcasts desktop media state changes

2. **Media Manager** (`media_manager.py`): Controls Windows media
   - Uses Windows Runtime (winrt) to access Media Session API
   - Detects and controls apps like Spotify, VLC, etc.
   - Falls back to pycaw for apps not using Media Session API (e.g., Spicetify)

3. **Tray Icon** (`tray_icon.py`): System tray integration
   - Shows service status
   - Provides quick access to quit

## 📁 Project Structure

```
auto-stop/
├── extension/                    # Firefox extension source code
│   ├── manifest.json             # Extension manifest (v2)
│   ├── shared/
│   │   └── constants.js          # Shared constants, message types & Logger
│   ├── background/
│   │   ├── index.js              # Background entry point
│   │   ├── media-manager.js      # Media state management (browser + desktop)
│   │   ├── desktop-connector.js  # WebSocket client for Windows service
│   │   └── storage.js            # Settings storage
│   ├── content/
│   │   ├── index.js              # Content script entry point
│   │   ├── media-detector.js     # Main detector coordinator
│   │   └── adapters/
│   │       ├── index.js          # Adapter registry
│   │       ├── base-adapter.js   # Base adapter class (with fallback methods)
│   │       ├── generic-adapter.js    # Standard HTML5 media
│   │       └── soundcloud-adapter.js # SoundCloud-specific
│   ├── popup/
│   │   ├── popup.html            # Popup UI structure
│   │   ├── popup.css             # Rosé Pine themed styles
│   │   └── popup.js               # Popup logic & state rendering
│   └── icons/
│       ├── icon-active.svg       # Pause icon (‖) - shown when media is playing
│       └── icon-idle.svg         # Play icon (▶) - shown when no media playing
│
├── windows/                      # Windows background service
│   ├── install.ps1               # PowerShell installer (checks prereqs, creates task)
│   ├── uninstall.ps1             # PowerShell uninstaller
│   ├── restart.ps1               # Restart service script
│   ├── stop.ps1                  # Stop service script
│   ├── logs.ps1                  # View logs script
│   ├── requirements.txt          # Python dependencies
│   ├── README.md                 # Windows-specific documentation
│   └── service/
│       ├── main.py               # Service entry point (with watchdog)
│       ├── media_manager.py      # Windows media session control
│       ├── websocket_server.py   # WebSocket server
│       ├── audio_detector.py     # Audio session detection (pycaw fallback)
│       ├── tray_icon.py          # System tray icon
│       └── config.py             # Configuration
│
├── README.md                     # User-friendly documentation
└── TECHNICAL.md                  # This file
```

## 🌐 Browser Extension

### Adapter System

The extension uses an adapter system to handle different player implementations:

- **Generic Adapter**: Hooks into `HTMLMediaElement.prototype.play()` to catch all standard HTML5 media
- **SoundCloud Adapter**: Interacts with SoundCloud's custom player controls directly
- **Base Adapter**: Provides fallback methods for sites that recreate media elements

### How It Works

1. **Media Detection**: Content scripts scan for media elements on page load and when DOM changes
2. **Play Interception**: When `play()` is called, the adapter intercepts and notifies the background script
3. **State Management**: Background script maintains:
   - `activeMedia`: Currently playing media
   - `pausedStack`: Queue of paused media (FIFO)
   - `allMedia`: All registered media across all tabs
4. **Auto-Pause**: When new media starts, current active media is paused and added to paused stack
5. **Auto-Resume**: When active media stops, after a delay, the next item in paused stack resumes

### Message Types

Communication between content scripts, background, and popup uses these message types:

```javascript
// Content -> Background
MEDIA_REGISTERED      // New media element detected
MEDIA_UNREGISTERED    // Media element removed
MEDIA_PLAY            // Media started playing
MEDIA_PAUSE           // Media paused
MEDIA_ENDED           // Media finished
TIME_UPDATE           // Playback progress update

// Background -> Content
CONTROL               // Control command (play, pause, skip, prev)

// Popup <-> Background
GET_STATE             // Request current state
GET_SETTINGS          // Request settings
UPDATE_SETTINGS       // Update settings
CONTROL_MEDIA         // Control specific media
STATE_UPDATE          // Broadcast state change
```

### Settings

Default settings (defined in `shared/constants.js`):

```javascript
{
  Blacklist: [],                    // Domains to never pause
  resumeDelay: 1500,                // ms to wait before resuming
  fadeInDuration: 2000,             // ms for volume fade-in
  fadeInStartVolume: 0.2,           // Start volume (0-1) when fading in
  autoExpireSeconds: 0,             // Don't resume if new media played longer (0 = disabled)
  resumeOnManualPause: true         // Resume previous when manually pausing current
}
```

## 🖥️ Windows Service

### Requirements

- Windows 10 or 11 (64-bit)
- Python 3.9 or higher
- pip (comes with Python)

### Dependencies

All dependencies have prebuilt wheels (no Visual Studio required):

- `websockets>=12.0` - WebSocket server
- `winrt-runtime>=3.0.0` - Windows Runtime
- `winrt-Windows.Media.Control>=3.0.0` - Media control API
- `pystray>=0.19.0` - System tray icon
- `Pillow>=10.0.0` - Image processing
- `pycaw>=20230407` - Audio session detection (fallback)
- `psutil>=5.9.0` - Process utilities

### Installation

The service installs to `%APPDATA%\AutoStopMedia\`:

```
%APPDATA%\AutoStopMedia\
├── service\          # Python service files
├── logs\             # Service logs (rotated)
├── requirements.txt
└── version.txt
```

### How It Works

1. **Media Detection**: Uses Windows Media Session API to detect apps with active media
2. **WebSocket Server**: Listens on `ws://127.0.0.1:42089` for extension connections
3. **State Sync**: Broadcasts desktop media state changes to connected extensions
4. **Control**: Receives control commands from extension and forwards to Windows Media API

### Desktop Timing

When desktop media stops, the extension waits before triggering auto-resume. This prevents false triggers during track changes or app transitions.

**Configuration** (in `extension/background/desktop-connector.js`):

```javascript
const DESKTOP_CONFIG = {
  PAUSE_DEBOUNCE_DELAY: 1000,  // Wait 1s before confirming desktop stopped
  // ... other settings
};
```

This means when you pause/stop desktop media, the extension waits 1 second to confirm the media actually stopped (not just changing tracks) before resuming previous media.

### Supported Desktop Apps

Any app that uses Windows Media Session API:
- Spotify (regular and Spicetify via fallback)
- VLC Media Player
- Windows Media Player
- Groove Music
- And many more...

Apps that don't use Media Session API may not be detected or controllable.

### Service Management

**Using PowerShell scripts:**
```powershell
.\install.ps1      # Install service
.\uninstall.ps1    # Remove service
.\restart.ps1      # Restart service
.\stop.ps1         # Stop service
.\logs.ps1          # View logs
```

**Using Task Scheduler:**
- Task name: `AutoStopMediaService`
- Runs at user logon
- Can be started/stopped via Task Scheduler GUI

**Manual:**
```powershell
python "%APPDATA%\AutoStopMedia\service\main.py"
```

## 🔌 Adding Site Adapters

To add support for a new site with a custom player:

1. Create a new file in `extension/content/adapters/` (e.g., `spotify-adapter.js`)

2. Extend `BaseAdapter` class:

```javascript
class SpotifyAdapter extends BaseAdapter {
  constructor() {
    super();
    this.name = 'spotify';
  }

  get priority() {
    return 10; // Higher = checked first (generic is 0)
  }

  matches() {
    return window.location.hostname.includes('spotify.com');
  }

  // Override control methods as needed
  play(mediaId) {
    // Custom play logic
  }

  pause(mediaId) {
    // Custom pause logic
  }
}
```

3. Register in `extension/content/adapters/index.js`:

```javascript
window.adapterRegistry.register(SpotifyAdapter);
```

4. Add to `manifest.json` content scripts (if needed for additional files)

See `soundcloud-adapter.js` for a complete example.

## 🔨 Building & Signing

### GitHub Actions (Recommended)

The repository includes a GitHub workflow that builds and signs the extension automatically.

**One-time setup:**

1. Get Mozilla API keys from https://addons.mozilla.org/developers/addon/api/key/
2. Add secrets to GitHub:
   - `AMO_JWT_ISSUER` - Your JWT issuer
   - `AMO_JWT_SECRET` - Your JWT secret

**Build:**
- Automatic: Bump version in `manifest.json` and push
- Manual: Actions tab → "Build and Sign Firefox Extension" → Run workflow

### Manual Build

```bash
# Install web-ext
npm install -g web-ext

# Sign with Mozilla
web-ext sign --source-dir=extension --channel=unlisted
```

Set environment variables:
- `WEB_EXT_API_KEY` - Your JWT issuer
- `WEB_EXT_API_SECRET` - Your JWT secret

## ⚠️ Known Limitations

### Browser

- Some sites with custom players may not be detected
- Embedded iframes with cross-origin restrictions may not be controllable
- Cover art detection is best-effort and may not work on all sites
- Sites that heavily recreate media elements may occasionally need a page refresh
- Live streams may not report accurate duration

### Desktop

- Not all apps expose media session info to Windows
- Some apps (like games) may not be controllable
- Windows 10/11 only
- Requires Python 3.9+

## 🛠️ Development

### Running the Extension

1. Load as temporary add-on in Firefox:
   - Open `about:debugging`
   - Click "This Firefox" → "Load Temporary Add-on..."
   - Select `extension/manifest.json`

2. Make changes and reload:
   - Background scripts: Reload extension in `about:debugging`
   - Content scripts: Reload the page
   - Popup: Close and reopen popup

### Running the Windows Service

```powershell
cd "%APPDATA%\AutoStopMedia\service"

# Run without auto-restart (Ctrl+C to stop)
python main.py --no-restart

# Run with auto-restart
python main.py
```

### Debugging

**Extension:**
- Background: Check `about:debugging` → "Inspect" → Console
- Content: Check page console (F12)
- Popup: Right-click popup → Inspect

**Windows Service:**
- Logs: `%APPDATA%\AutoStopMedia\logs\service.log`
- View logs: `.\logs.ps1` or `Get-Content "$env:APPDATA\AutoStopMedia\logs\service.log" -Tail 50 -Wait`

### Testing

Test with multiple media sources:
- YouTube (video)
- SoundCloud (audio)
- Spotify Web (audio)
- Desktop apps (Spotify, VLC, etc.)

Verify:
- Auto-pause/resume behavior
- Settings persistence
- Desktop connection
- Popup UI rendering

---

For user-friendly documentation, see [README.md](README.md).

