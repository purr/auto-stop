# Auto-Stop Media 🎵

A Firefox extension that ensures only one media plays at a time across all your browser tabs **and desktop applications**. When new media starts playing, it automatically pauses other media. When you stop the current media, it resumes the previously paused one.

![Auto-Stop Media](https://img.shields.io/badge/Firefox-Extension-FF7139?logo=firefox-browser&logoColor=white)
![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)

## ✨ Features

### Browser Media
- **Single Media Focus**: Only one audio/video plays at a time across all tabs
- **Auto-Resume**: When you stop current media, the previously paused one automatically resumes
- **Smart Detection**: Works with native HTML5 audio/video and most embedded players (YouTube, SoundCloud, Spotify Web, etc.)
- **Site-Specific Adapters**: Custom handling for sites like SoundCloud that use non-standard players
- **Beautiful UI**: Modern popup with Rosé Pine dark theme, fixed-height layout with scrollable paused list
- **Dynamic Icon**: Shows ▶ (play) when idle, ‖ (pause) when media is playing
- **Now Playing & Paused Stack**: See active media and paused media with cover art, titles, and controls
- **Click to Focus**: Click on any media card to switch to that tab
- **Blacklist**: Mark domains that should never be paused (supports wildcards: `*.example.com`)
- **Full Playback Controls**: Play/Pause, Previous (⏮), and Next (⏭) buttons in the popup
- **Resume Delay**: Configurable delay before resuming paused media (prevents accidental playback during loading)
- **Fade-In**: Smooth volume fade-in when resuming media (no sudden loud audio)
- **Auto-Expire**: Option to not resume old media if new media played for too long
- **Manual Pause Tracking**: Manually paused media shows a badge and won't auto-resume (configurable)
- **Pending Resume Indicator**: Visual feedback when media is about to resume (pulsing card during delay)

### 🖥️ Desktop Media (Windows)
- **Desktop App Integration**: Control Spotify, VLC, Windows Media Player, and more from the browser popup
- **Unified Experience**: Desktop media appears alongside browser media with a 🖥️ icon
- **Cross-Platform Pause**: Playing browser media automatically pauses desktop apps (and vice versa)
- **Full Metadata**: See cover art, titles, and artist info from desktop apps
- **Playback Controls**: Play, Pause, Next, Previous buttons work for desktop apps too

## 📦 Installation

### Browser Extension

#### Method 1: Install Signed XPI (Recommended)

1. Go to the [Releases](../../releases) page
2. Download the latest `.xpi` file
3. Open Firefox and drag the `.xpi` file into the browser window
4. Click **"Add"** when prompted
5. Done! The extension is permanently installed

#### Method 2: Temporary Load (Development)

For development/testing, you can load the extension temporarily:

1. Open Firefox
2. Type `about:debugging` in the address bar and press Enter
3. Click **"This Firefox"** in the left sidebar
4. Click **"Load Temporary Add-on..."**
5. Navigate to the `auto-stop/extension` folder and select the `manifest.json` file
6. The extension will be loaded and active!

> ⚠️ **Note**: Temporary extensions are removed when Firefox closes. You'll need to reload it each session.

### Windows Desktop Service (Optional)

To enable desktop media control (Spotify, VLC, etc.):

**Requirements:**
- Windows 10 or 11
- Python 3.9 or higher (in PATH)

**Installation:**

1. Open PowerShell
2. Navigate to the windows folder:
   ```powershell
   cd path\to\auto-stop\windows
   ```
3. Run the installer:
   ```powershell
   .\install.ps1
   ```

The installer will set up the service to run automatically at login. See [windows/README.md](windows/README.md) for detailed instructions.

## 🎮 How to Use

1. **Click the extension icon** in your toolbar to open the popup
2. **Now Playing**: Shows the currently active media with controls
   - ⏮ Previous (seek to start), ▶/⏸ Play/Pause, ⏭ Next (skip to end)
   - Click the card to switch to that tab
   - Shows "Waiting..." or "Resuming..." when media is about to auto-resume
   - Desktop media shows a 🖥️ icon and the app name
3. **Paused**: Shows media that was paused (click play to resume, click card to focus tab)
   - Items with ⏸ badge were manually paused and won't auto-resume
   - Desktop media shows a small 🖥️ badge
   - Scrollable list with shadow indicators when there's more content
4. **Desktop Status**: Header shows "Desktop" when Windows service is connected

### Settings

Click the ⚙️ icon in the popup to access settings:

- **Resume Effects**:
  - **Resume Delay**: Wait X milliseconds before resuming paused media (default: 1500ms)
    - Prevents accidental playback when videos are loading/buffering
    - During the delay, the pending media shows in "Now Playing" with a visual indicator
  - **Fade-in Duration**: How long to gradually increase volume (default: 2000ms)
    - Set to 0 to skip fade-in entirely
    - Avoids sudden loud audio when resuming
  - **Start Volume**: Initial volume when fading in (default: 20%)

- **Auto-Resume Rules**:
  - **Resume on Manual Pause**: Whether to auto-resume other media when you manually pause current media
    - Enabled: Pausing YouTube will resume your music
    - Disabled: Manual pause = nothing resumes automatically
  - **Auto-Expire**: If you watch new media for longer than X seconds, old media won't auto-resume
    - Set to 0 to disable (always resume)
    - Example: Set to 120 → if you watch a video for 2+ minutes, your music won't auto-resume

- **Blacklist**: Add domains that should never be paused
  - Supports wildcards: `*.example.com` matches all subdomains
  - Example: `spotify.com` - Spotify will always keep playing even if you start media elsewhere
  - Blacklisted media doesn't appear in the popup at all


## 🔧 How It Works

### Browser Media

1. **Adapter System**: Site-specific adapters handle different player implementations
   - **Generic Adapter**: Hooks into `HTMLMediaElement.prototype.play()` to catch all standard HTML5 media
   - **SoundCloud Adapter**: Interacts with SoundCloud's custom player controls directly
   - More adapters can be added for other sites as needed
   - **Fallback Mechanism**: If a media element is recreated (common on YouTube), the adapter automatically finds and plays/pauses any available media

2. **Background Script** (`media-manager.js`) manages the state of all media across tabs
   - Maintains active media and paused stack
   - Handles resume delays and volume fade-in
   - Tracks manually vs. extension-paused media

3. When media starts playing:
   - Any pending resume is cancelled
   - The currently playing media (if any) is paused/muted
   - It's added to a "paused stack" with `manuallyPaused: false`

4. When media stops (paused/ended/tab closed):
   - After the resume delay, the next auto-resumable media plays
   - Manually paused items are skipped during auto-resume
   - Volume fades in smoothly from the configured start volume

5. **Blacklist** domains get priority - they're never paused and don't appear in the popup

### Desktop Media

1. **Windows Service** (`main.py`) runs as a background process
2. **WebSocket Server** listens on `ws://127.0.0.1:42089`
3. **Extension** connects to the WebSocket automatically
4. **Windows Media API** (`winsdk`) detects and controls desktop apps

When browser media starts:
- Extension notifies the Windows service
- Service pauses all desktop media
- Desktop media appears in the paused stack

When desktop media starts:
- Service notifies the extension
- Extension pauses browser media
- Desktop media shows in "Now Playing" with a 🖥️ icon

## 📁 Project Structure

```
auto-stop/
├── .github/
│   └── workflows/
│       └── build-and-sign.yml    # GitHub Actions workflow for building & signing
│
├── extension/                    # Firefox extension source code
│   ├── manifest.json             # Extension manifest (v2.0.0)
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
│   │   └── popup.js              # Popup logic & state rendering
│   └── icons/
│       ├── icon-active.svg       # Pause icon (‖) - shown when media is playing
│       └── icon-idle.svg         # Play icon (▶) - shown when no media playing
│
├── windows/                      # Windows background service
│   ├── install.ps1               # PowerShell installer (checks prereqs, creates task)
│   ├── uninstall.ps1             # PowerShell uninstaller
│   ├── requirements.txt          # Python dependencies
│   ├── README.md                 # Windows-specific documentation
│   └── service/
│       ├── main.py               # Service entry point (with watchdog)
│       ├── media_manager.py      # Windows media session control
│       ├── websocket_server.py   # WebSocket server
│       └── config.py             # Configuration
│
├── .gitignore
└── README.md
```

## 🔌 Adding New Site Adapters

To add support for a new site with a custom player:

1. Create a new file in `extension/content/adapters/` (e.g., `spotify-adapter.js`)
2. Extend `BaseAdapter` class
3. Implement `matches()` to detect the site (return `true` for matching hostnames)
4. Set `priority` getter (higher = checked first, generic is 0)
5. Override control methods as needed:
   - `play(mediaId)` - Start playback
   - `pause(mediaId)` - Pause playback
   - `skip(mediaId)` - Skip to next track (seeks to end)
   - `prev(mediaId)` - Go to previous/start (seeks to beginning)
   - `setVolume(mediaId, volume)` - Set volume (0-1)
6. Optionally override `reRegisterElement(element)` for sites that recreate media elements
7. Register in `extension/content/adapters/index.js`
8. Add to `manifest.json` content scripts

See `soundcloud-adapter.js` for a complete example of a site-specific adapter.

## 🐛 Known Limitations

### Browser
- Some sites with custom players may not be detected (we try our best!)
- Embedded iframes with cross-origin restrictions may not be controllable
- Cover art detection is best-effort and may not work on all sites
- Sites that heavily recreate media elements may occasionally need a page refresh
- Live streams may not report accurate duration

### Desktop
- Not all apps expose media session info to Windows
- Some apps (like games) may not be controllable
- Windows 10/11 only
- Requires Python 3.9+

## 📋 TODO / Future Ideas

### Other Ideas
- Keyboard shortcuts for global control
- Queue system for sequential playback
- Volume normalization across tabs
- Per-site settings
- Playback history
- Ignore media below a certain volume threshold
- Ignore short media (< X seconds)
- macOS/Linux desktop support

## 🔨 Building & Signing

### GitHub Actions (Recommended)

The repository includes a GitHub workflow that builds and signs the extension automatically.

**One-time setup:**

1. **Get Mozilla API keys:**
   - Go to https://addons.mozilla.org/developers/addon/api/key/
   - Log in with your Firefox account
   - Copy both the **JWT issuer** and **JWT secret**

2. **Add secrets to GitHub:**
   - Go to your repository on GitHub
   - Click **Settings** → **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Add `AMO_JWT_ISSUER` with your JWT issuer value
   - Add `AMO_JWT_SECRET` with your JWT secret value

**Build the extension:**
- **Automatic**: Just bump the version in `manifest.json` and push - the workflow triggers automatically!
- **Manual**: **Actions** tab → **Build and Sign Firefox Extension** → **Run workflow**

The signed `.xpi` file will be available as a download in the workflow run or GitHub Release.

### Manual Build

```bash
# Install web-ext
npm install -g web-ext

# Sign with Mozilla
web-ext sign --source-dir=extension --channel=unlisted

# The signed .xpi will be in ./web-ext-artifacts/
```

Set these environment variables or pass as flags:
- `WEB_EXT_API_KEY` or `--api-key` - Your JWT issuer
- `WEB_EXT_API_SECRET` or `--api-secret` - Your JWT secret

## 🗑️ Removed Features

Features that were removed from the extension:

- **Mute Tab Mode**: Originally allowed muting the entire tab instead of pausing media. Removed in favor of always using direct media pause which provides better control and a smoother experience.

## 📄 License

MIT License - feel free to use and modify!

---

Made with 💜 using the Rosé Pine theme
