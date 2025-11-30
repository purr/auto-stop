# Auto-Stop Media 🎵

A Firefox extension that ensures only one media plays at a time across all your tabs. When new media starts playing, it automatically pauses other media. When you stop the current media, it resumes the previously paused one.

![Auto-Stop Media](https://img.shields.io/badge/Firefox-Extension-FF7139?logo=firefox-browser&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## ✨ Features

- **Single Media Focus**: Only one audio/video plays at a time across all tabs
- **Auto-Resume**: When you stop current media, the previously paused one automatically resumes
- **Smart Detection**: Works with native HTML5 audio/video and most embedded players (YouTube, SoundCloud, Spotify Web, etc.)
- **Site-Specific Adapters**: Custom handling for sites like SoundCloud that use non-standard players
- **Beautiful UI**: Modern popup with Rosé Pine dark theme, fixed-height layout with scrollable paused list
- **Dynamic Icon**: Shows ▶ (play) when idle, ‖ (pause) when media is playing
- **Now Playing & Paused Stack**: See active media and paused media with cover art, titles, and controls
- **Click to Focus**: Click on any media card to switch to that tab
- **Pause vs Mute**: Choose whether to pause or mute the entire tab
- **Whitelist**: Mark domains that should never be paused (priority playback)
- **Play/Pause/Skip Controls**: Control media directly from the popup
- **Resume Delay**: Configurable delay before resuming paused media (prevents accidental playback during loading)
- **Fade-In**: Smooth volume fade-in when resuming media (no sudden loud audio)
- **Auto-Expire**: Option to not resume old media if new media played for too long
- **Manual Pause Tracking**: Manually paused media shows a badge and won't auto-resume (configurable)
- **Pending Resume Indicator**: Visual feedback when media is about to resume (pulsing card during delay)

## 📦 Installation (Temporary - Development)

Since this extension is not yet published on Firefox Add-ons, you can load it temporarily for testing:

### Method 1: about:debugging (Recommended)

1. Open Firefox
2. Type `about:debugging` in the address bar and press Enter
3. Click **"This Firefox"** in the left sidebar
4. Click **"Load Temporary Add-on..."**
5. Navigate to the `auto-stop/src` folder and select the `manifest.json` file
6. The extension will be loaded and active!

> ⚠️ **Note**: Temporary extensions are removed when Firefox closes. You'll need to reload it each session.

### Method 2: about:addons

1. Open Firefox
2. Type `about:addons` in the address bar
3. Click the gear icon (⚙️) → **"Debug Add-ons"**
4. Click **"Load Temporary Add-on..."**
5. Select the `manifest.json` file from the `src` folder

## 🎮 How to Use

1. **Click the extension icon** in your toolbar to open the popup
2. **Now Playing**: Shows the currently active media with controls (play/pause, skip)
   - Click the card to switch to that tab
   - Shows "Waiting..." or "Resuming..." when media is about to auto-resume
3. **Paused**: Shows media that was paused (click play to resume, click card to focus tab)
   - Items with ⏸ badge were manually paused and won't auto-resume
   - Scrollable list with shadow indicators when there's more content

### Settings

Click the ⚙️ icon in the popup to access settings:

- **Control Mode**: Toggle between "Pause" and "Mute Tab" modes
  - **Pause**: Completely pauses the media element (recommended)
  - **Mute Tab**: Mutes the entire tab (like right-click → Mute Tab)

- **Resume Behavior**:
  - **Resume Delay**: Wait X milliseconds before resuming paused media (default: 1500ms)
    - Prevents accidental playback when videos are loading/buffering
    - During the delay, the pending media shows in "Now Playing" with a visual indicator
  - **Fade-in Duration**: How long to gradually increase volume (default: 2000ms)
    - Set to 0 to skip fade-in entirely
    - Avoids sudden loud audio when resuming
  - **Start Volume**: Initial volume when fading in (default: 20%)
  - **Resume on Manual Pause**: Whether to auto-resume other media when you manually pause current media
    - Enabled: Pausing YouTube will resume your music
    - Disabled: Manual pause = nothing resumes automatically

- **Auto-Expire**: If you watch new media for longer than X seconds, old media won't auto-resume
  - Set to 0 to disable (always resume)
  - Example: Set to 120 → if you watch a video for 2+ minutes, your music won't auto-resume

- **Whitelist**: Add domains that should never be paused
  - Example: `spotify.com` - Spotify will always keep playing even if you start media elsewhere
  - Whitelisted media doesn't appear in the popup at all

## 🎨 Theme

The extension uses the beautiful [Rosé Pine](https://rosepinetheme.com/) dark theme, featuring:
- Deep purple-blue backgrounds
- Rose and iris accent colors
- Smooth animations and transitions

## 🔧 How It Works

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

5. **Whitelist** domains get priority - they're never paused and don't appear in the popup

## 📁 Project Structure

```
auto-stop/
├── src/                          # Extension source code
│   ├── manifest.json             # Extension manifest
│   ├── shared/
│   │   └── constants.js          # Shared constants, message types & Logger
│   ├── background/
│   │   ├── index.js              # Background entry point
│   │   ├── media-manager.js      # Media state management (pause/resume logic)
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
├── .gitignore
└── README.md
```

## 🔌 Adding New Site Adapters

To add support for a new site with a custom player:

1. Create a new file in `src/content/adapters/` (e.g., `spotify-adapter.js`)
2. Extend `BaseAdapter` class
3. Implement `matches()` to detect the site (return `true` for matching hostnames)
4. Set `priority` getter (higher = checked first, generic is 0)
5. Override control methods as needed:
   - `play(mediaId)` - Start playback
   - `pause(mediaId)` - Pause playback
   - `skip(mediaId)` - Skip to next track
   - `setVolume(mediaId, volume)` - Set volume (0-1)
   - `mute(mediaId)` / `unmute(mediaId)` - Mute controls
6. Optionally override `reRegisterElement(element)` for sites that recreate media elements
7. Register in `src/content/adapters/index.js`
8. Add to `manifest.json` content scripts

See `soundcloud-adapter.js` for a complete example of a site-specific adapter.

## 🐛 Known Limitations

- Some sites with custom players may not be detected (we try our best!)
- Embedded iframes with cross-origin restrictions may not be controllable
- Cover art detection is best-effort and may not work on all sites
- Sites that heavily recreate media elements may occasionally need a page refresh
- Live streams may not report accurate duration

## 📋 TODO / Future Ideas

### 🕐 Video Preview Delay (Planned)
Add a configurable delay before *pausing* other media when new media starts. This would help with:
- **Video previews**: Hovering over video thumbnails often triggers short autoplay previews - these should NOT stop your music
- **Accidental triggers**: Brief media interactions shouldn't interrupt what you're listening to

**Note**: Resume delay and fade-in are already implemented! This is specifically for delaying the *pause* action.

### Other Ideas
- Keyboard shortcuts for global control
- Queue system for sequential playback
- Volume normalization across tabs
- Per-site settings
- Playback history
- Ignore media below a certain volume threshold
- Ignore short media (< X seconds)

## 📄 License

MIT License - feel free to use and modify!

---

Made with 💜 using the Rosé Pine theme
