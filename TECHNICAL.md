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

1. **Content Scripts** (`extension/content/`): Injected into every page, all frames
   - Detect every `<audio>`/`<video>` element via capture-phase document listeners
   - Track the single *audible* element that owns the audio in each document
   - Run volume fade-in locally and send state changes to the background

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
│   │   ├── index.js              # Content script entry point (bootstraps the controller)
│   │   └── media-controller.js   # Universal detector + controls + local volume fade
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

### Detection Model

There are no per-site adapters. One `MediaController` handles every site, built on two
facts that hold everywhere:

1. **Capture-phase events** — media events (`play`, `pause`, `volumechange`, `ended`)
   don't bubble but *do* fire during the capture phase, so a single set of listeners on
   `document` catches every `<audio>`/`<video>`, including ones created after load. No
   polling, no `MutationObserver`, no prototype patching.
2. **Audible, not visible** — the element that owns the audio is the one that is
   `playing && !muted && volume > 0`. Muted media is ignored entirely (it can't conflict
   with anything). Viewport visibility is used only as a tiebreak when two elements are
   audible at once (e.g. a TikTok feed).

Each document has at most one **winner** (the audible element). The controller only
messages the background when the winner *changes*, which dedups noisy churn (rapid TikTok
scrolls, mute/unmute) for free.

A few sites can't be observed as a DOM media element — SoundCloud, for example, streams
through a detached/MSE `<audio>` that capture listeners and `querySelectorAll` never see.
Those are handled in **site mode**: a `SITE_CONTROLLERS` entry with `detect: true` drives
detection by polling the site's own player (play button, timeline) and control by clicking
its buttons. Same message protocol, same fade engine — just a different detection source.
Everything else uses the universal element mode.

### How It Works

1. **Detection**: capture listeners recompute the audible winner after a short settle
2. **Report**: on a winner change the controller sends `MEDIA_PLAY` / `MEDIA_PAUSE` / `MEDIA_ENDED`
3. **State Management**: the background maintains:
   - `activeMedia`: currently playing media (browser or desktop)
   - `pausedStack`: stack of paused media (most recent first)
   - `allMedia`: registered media across all tabs
4. **Auto-Pause**: when new media becomes the winner, the previous active media is paused and stacked
5. **Auto-Resume**: when the active media stops, after a delay the next eligible stack item resumes
6. **Fade-in**: the resume command carries `{duration, startVolume}`; the content script ramps
   volume locally (no per-step IPC) back to the user's own volume level

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

Any app that uses the Windows Media Session API (SMTC) — detected automatically with real
play/pause:
- Spotify (regular and Spicetify via fallback)
- VLC Media Player
- Windows Media Player
- Groove Music
- And many more...

**Telegram / AyuGram**:
- **Songs** register with the Windows media session API, so they get real play/pause with
  metadata through the normal path — no special handling.
- **Videos** (video-with-sound) expose *nothing* to Windows — no media session, and their
  player ignores media keys / `WM_APPCOMMAND` (verified in tdesktop source; only Space, sent
  to the focused viewer window, toggles them). So a video **cannot be paused from outside**.
  `_check_telegram_video` in `media_manager.py` therefore does **detection only**: it senses
  the video's audio session (pycaw) and reports `desktop-telegram-video` so that *playing a
  Telegram video pauses the browser* (real browser pause). The reverse — pausing the video
  when the browser plays — is impossible without muting the whole app (rejected) or stealing
  window focus (rejected), so the service just **yields**: it stops reporting the video as
  active so nothing oscillates, and the video keeps playing. Both can be audible at once in
  that direction; that is the honest ceiling.

The service **never mutes a desktop app.** `set_muted` is called exactly once, at startup
(`_reconcile_telegram_mute`), and only to *clear* a mute a prior buggy version may have left.

**Spotify** (Spicetify): the one remaining audio-session fallback, controlled via
`WM_APPCOMMAND` (still a real transport, not muting).

Apps that never register with SMTC can't be controlled — the service will not mute them as a
workaround.

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

## 🔌 Adding Site Support

Almost every site works with no code at all — standard HTML5 `<audio>`/`<video>` plus the
Media Session API (which most sites set for title/cover) is all the controller needs. That
covers YouTube, YouTube Music, Bandcamp, SoundCloud, Spotify Web, Twitch, live cam/adult
sites, TikTok, and generic embeds.

A site only needs a `SITE_CONTROLLERS` entry (in `extension/content/media-controller.js`)
in two cases — both data, not classes, no new files or manifest changes:

**1. Enhance universal mode** — the element is detectable but a control could be better,
e.g. "skip" should click the site's own next button instead of seeking to the end:

```javascript
{ match: 'example.com', next: () => clickFirst(['.next-btn']) }   // getTitle/getCover/prev optional
```

**2. Site mode (`detect: true`)** — the player can't be seen as a DOM media element (like
SoundCloud). Provide detection + control against the site's UI:

```javascript
{
  match: 'soundcloud.com',
  detect: true,
  isPlaying() { /* read the play button state */ },
  play() {}, pause() {}, next() {}, prev() {}, setVolume(v) {}, getVolume() {},
  getTitle() {}, getCover() {}, getCurrentTime() {}, getDuration() {}
}
```

Prefer option 1; only use `detect: true` when the element genuinely isn't observable.

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

- Muted media is ignored by design — it can't conflict, so it's never tracked
- Sites that play audio purely through the Web Audio API with no `<audio>`/`<video>`
  element (rare) can't be detected — there is no element to observe or control
- Cover art / title come from the Media Session API first and best-effort DOM fallbacks;
  a few sites expose neither
- Live streams report no fixed duration, so the progress bar is hidden for them

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

