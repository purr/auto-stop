# Auto-Stop Media 🎵

A Firefox extension that ensures only one media plays at a time across all your browser tabs **and desktop applications**. Stop multiple videos playing simultaneously, prevent audio conflicts, and auto-pause other tabs when you play media. Control desktop apps like Spotify and VLC from your browser. When new media starts playing, it automatically pauses other media. When you stop the current media, it resumes the previously paused one.

![Auto-Stop Media](https://img.shields.io/badge/Firefox-Extension-FF7139?logo=firefox-browser&logoColor=white)
![Version](https://img.shields.io/badge/version-2.0.5-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)

## ✨ Features

### Browser Media
- **One Media at a Time**: Only one audio or video plays across all browser tabs
- **Auto-Resume**: When you stop current media, the previously paused one automatically resumes
- **Works Everywhere**: Supports YouTube, SoundCloud, Spotify Web, and any site with HTML5 audio/video
- **Beautiful Popup**: See what's playing and what's paused, with cover art and controls
- **Smart Controls**: Play, pause, skip, and previous buttons work right from the popup
- **Click to Switch**: Click any media card to jump to that tab instantly

### 🖥️ Desktop Media (Windows)
- **Control Desktop Apps**: Manage Spotify, VLC, Windows Media Player, and more from your browser
- **Unified Experience**: Desktop media appears in the same popup alongside browser media
- **Cross-Platform Pause**: Playing browser media automatically pauses desktop apps (and vice versa)
- **Full Control**: Play, pause, skip, and previous buttons work for desktop apps too

## 📦 Installation

### Browser Extension

1. Go to the [Releases](../../releases) page
2. Download the latest `.xpi` file
3. Open Firefox and drag the `.xpi` file into the browser window
4. Click **"Add"** when prompted
5. Done! The extension is now installed

> 💡 **Tip**: The extension works immediately for browser media. Desktop media control is optional and requires the Windows service below.

### Windows Desktop Service (Optional)

To control desktop apps like Spotify and VLC from the browser:

**Requirements:**
- Windows 10 or 11
- Python 3.9 or higher (must be in your system PATH)

**Quick Install:**

1. Open PowerShell
2. Navigate to the `windows` folder in this project
3. Run: `.\install.ps1`

The installer will:
- Check that Python is installed
- Install required dependencies
- Set up the service to run automatically at login
- Start the service immediately

That's it! The extension will automatically detect and connect to the service.

> 📖 **Need help?** See [windows/README.md](windows/README.md) for detailed instructions and troubleshooting.

## 🎮 How to Use

1. **Click the extension icon** in your Firefox toolbar to open the popup

2. **Now Playing**: Shows the currently active media
   - Use the controls: ⏮ Previous, ▶/⏸ Play/Pause, ⏭ Next
   - Click the card to switch to that tab
   - Desktop media shows a 🖥️ icon

3. **Paused**: Shows all paused media
   - Click play on any item to resume it
   - Click the card to jump to that tab
   - Items with a ⏸ badge were manually paused and won't auto-resume

4. **Settings**: Click the ⚙️ icon to customize behavior

## ⚙️ Settings

All settings are saved automatically and apply immediately.

### Resume Effects

Control how paused media resumes:

- **Resume Delay**: How long to wait before resuming (default: 1.5 seconds)
  - Prevents accidental playback when videos are loading
  - During the delay, you'll see "Resuming..." in the popup

- **Fade-in Duration**: How long to gradually increase volume (default: 2 seconds)
  - Set to 0 to skip fade-in (instant volume)
  - Prevents sudden loud audio when resuming

  - **Start Volume**: Initial volume when fading in (default: 20%)
  - Media starts quiet and fades up to normal volume

### Auto-Resume Rules

Control when media automatically resumes:

- **Resume on Manual Pause**: When enabled, pausing one media will resume the previous one
  - Example: Pause YouTube → your music automatically resumes
  - When disabled, manual pause = nothing resumes automatically

- **Auto-Expire**: Don't auto-resume if new media played longer than this (default: disabled)
  - Set to 0 to always resume
  - Example: Set to 120 seconds → if you watch a video for 2+ minutes, your music won't auto-resume

### Blacklist

Add websites that should never be paused:

- Enter a domain (e.g., `spotify.com`) and click Add
  - Supports wildcards: `*.example.com` matches all subdomains
- Blacklisted media won't be paused and won't appear in the popup
- Useful for background music or podcasts you want to keep playing

## 🖥️ Desktop Media Status

When the Windows service is running and connected, you'll see "Desktop" in the popup header. Desktop media will appear with a 🖥️ icon.

**To check if the service is running:**
- Look for "Desktop" in the popup header
- If missing, the service may not be installed or running

**To restart the service:**
- Run `.\restart.ps1` from the `windows` folder
- Or use Task Scheduler (search "Task Scheduler" in Windows)

## ❓ Common Questions

**Q: Does it work with YouTube?**
A: Yes! YouTube and most video sites work automatically.

**Q: Can I control Spotify from the browser?**
A: Yes, if you install the Windows service. Spotify will appear in the popup with a 🖥️ icon.

**Q: What if a site doesn't work?**
A: Most sites with standard HTML5 audio/video work automatically. If a site uses a custom player, it may need special support.

**Q: Can I disable auto-resume?**
A: Yes! In settings, set "Resume on Manual Pause" to off, and set "Auto-Expire" to 0.

**Q: How do I uninstall?**
A: For the extension: Right-click the icon → Remove Extension. For the Windows service: Run `.\uninstall.ps1` from the `windows` folder.

## 📖 Need More Information?

For technical details, development information, and advanced configuration, see **[TECHNICAL.md](TECHNICAL.md)**.

---

Made with 💜
