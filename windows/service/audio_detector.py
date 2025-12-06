# Auto-Stop Media - Audio Session Detector
# Uses pycaw to detect apps playing audio (fallback for apps not using Media Session API)
# Uses WM_APPCOMMAND to control apps like Spotify directly

import ctypes
import logging
from ctypes import wintypes
from dataclasses import dataclass
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    from pycaw.pycaw import AudioUtilities, IAudioMeterInformation, ISimpleAudioVolume

    PYCAW_AVAILABLE = True
except ImportError:
    PYCAW_AVAILABLE = False
    logger.warning("pycaw not available - audio session detection disabled")

try:
    import psutil

    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False
    logger.warning("psutil not available - process detection disabled")


@dataclass
class AudioApp:
    """Info about an app with an audio session"""

    pid: int
    name: str
    volume: float
    muted: bool
    is_playing: bool  # Based on audio meter


class AudioDetector:
    """Detects apps playing audio using Windows Audio Session API"""

    # Apps to detect that might not use Media Session API
    DETECT_APPS = {
        "spotify.exe": "Spotify",
        "vlc.exe": "VLC",
        "foobar2000.exe": "foobar2000",
        "musicbee.exe": "MusicBee",
        "winamp.exe": "Winamp",
        "aimp.exe": "AIMP",
    }

    def __init__(self):
        self._last_detected: Dict[str, AudioApp] = {}

    @property
    def is_available(self) -> bool:
        return PYCAW_AVAILABLE

    def detect_playing_apps(self) -> List[AudioApp]:
        """Detect apps that are currently playing audio"""
        if not PYCAW_AVAILABLE:
            return []

        playing_apps = []

        try:
            sessions = AudioUtilities.GetAllSessions()

            for session in sessions:
                if not session.Process:
                    continue

                proc_name = session.Process.name().lower()

                # Check if it's an app we care about
                if proc_name not in self.DETECT_APPS:
                    continue

                try:
                    # Get volume info
                    volume_ctl = session._ctl.QueryInterface(ISimpleAudioVolume)
                    volume = volume_ctl.GetMasterVolume()
                    muted = volume_ctl.GetMute()

                    # Check if actually producing audio (audio meter)
                    try:
                        meter = session._ctl.QueryInterface(IAudioMeterInformation)
                        peak = meter.GetPeakValue()
                        is_playing = peak > 0.001  # Small threshold
                    except Exception:
                        # If meter fails, assume playing if not muted
                        is_playing = not muted and volume > 0

                    app = AudioApp(
                        pid=session.Process.pid,
                        name=self.DETECT_APPS.get(proc_name, proc_name),
                        volume=volume,
                        muted=muted,
                        is_playing=is_playing,
                    )

                    if is_playing:
                        playing_apps.append(app)
                        logger.debug(f"Audio playing: {app.name} (PID {app.pid})")

                except Exception as e:
                    logger.debug(f"Error checking audio session {proc_name}: {e}")

        except Exception as e:
            logger.error(f"Error detecting audio sessions: {e}")

        return playing_apps

    def is_spotify_playing(self) -> Optional[AudioApp]:
        """Check specifically if Spotify is playing"""
        apps = self.detect_playing_apps()
        for app in apps:
            if app.name == "Spotify":
                return app
        return None


class SpotifyController:
    """Control Spotify directly using WM_APPCOMMAND (works with Spicetify!)"""

    # WM_APPCOMMAND message
    WM_APPCOMMAND = 0x0319

    # App command codes (shifted left 16 bits when sent)
    APPCOMMAND_MEDIA_PLAY_PAUSE = 14
    APPCOMMAND_MEDIA_STOP = 13
    APPCOMMAND_MEDIA_NEXTTRACK = 11
    APPCOMMAND_MEDIA_PREVIOUSTRACK = 12
    APPCOMMAND_MEDIA_PLAY = 46
    APPCOMMAND_MEDIA_PAUSE = 47

    def __init__(self):
        self._user32 = ctypes.windll.user32
        self._cached_hwnd = None
        self._cached_title = None

    def _find_spotify_window(self) -> Optional[int]:
        """Find Spotify's main window handle"""
        if not PSUTIL_AVAILABLE:
            return None

        # Try cached window first (if still valid)
        if self._cached_hwnd:
            # Check if window still exists
            if self._user32.IsWindow(self._cached_hwnd):
                # Verify it's still Spotify
                pid = ctypes.c_ulong()
                self._user32.GetWindowThreadProcessId(
                    self._cached_hwnd, ctypes.byref(pid)
                )
                try:
                    proc = psutil.Process(pid.value)
                    if "spotify" in proc.name().lower():
                        return self._cached_hwnd
                except Exception:
                    pass
            # Cache invalid, clear it
            self._cached_hwnd = None
            self._cached_title = None

        # Search for Spotify window
        result = {"hwnd": None, "title": None, "fallback_hwnd": None}

        def callback(hwnd, lParam):
            # Get process ID
            pid = ctypes.c_ulong()
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

            try:
                proc = psutil.Process(pid.value)
                if "spotify" not in proc.name().lower():
                    return True
            except Exception:
                return True

            # Get title
            length = self._user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                self._user32.GetWindowTextW(hwnd, buff, length + 1)
                title = buff.value

                # Prefer main window with "Artist - Track" format
                if " - " in title and title not in [
                    "Spotify",
                    "Spotify Free",
                    "Spotify Premium",
                ]:
                    result["hwnd"] = hwnd
                    result["title"] = title
                    return False  # Stop enumeration
                elif (
                    not result["fallback_hwnd"]
                    and title
                    and title not in ["Spotify", "Spotify Free", "Spotify Premium", ""]
                ):
                    # Fallback: any window with a title (might be paused/minimized)
                    result["fallback_hwnd"] = hwnd
            elif not result["fallback_hwnd"]:
                # Last resort: any Spotify window (even without title)
                result["fallback_hwnd"] = hwnd

            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        self._user32.EnumWindows(WNDENUMPROC(callback), 0)

        # Use best match
        hwnd = result["hwnd"] or result["fallback_hwnd"]
        self._cached_hwnd = hwnd
        self._cached_title = result["title"]
        return hwnd

    def _send_command(self, command: int) -> bool:
        """Send WM_APPCOMMAND to Spotify window"""
        hwnd = self._find_spotify_window()
        if not hwnd:
            logger.warning("Spotify window not found")
            return False

        lParam = command << 16
        result = self._user32.SendMessageW(hwnd, self.WM_APPCOMMAND, hwnd, lParam)
        logger.debug(f"Sent command {command} to Spotify, result: {result}")
        return result != 0

    def play_pause(self) -> bool:
        """Toggle play/pause"""
        logger.info("Spotify: play/pause")
        return self._send_command(self.APPCOMMAND_MEDIA_PLAY_PAUSE)

    def play(self) -> bool:
        """Start playback"""
        logger.info("Spotify: play() called")
        hwnd = self._find_spotify_window()
        if not hwnd:
            logger.error("Spotify: window not found!")
            return False

        logger.info(f"Spotify: window found: {hwnd}, trying play command")
        # Try explicit play first, fall back to play/pause toggle
        result1 = self._send_command(self.APPCOMMAND_MEDIA_PLAY)
        logger.info(f"Spotify: APPCOMMAND_MEDIA_PLAY result: {result1}")

        if not result1:
            # If explicit play doesn't work, use play/pause toggle
            # This works because if paused, play/pause will resume
            logger.info("Spotify: Play command not handled, trying play/pause toggle")
            result2 = self._send_command(self.APPCOMMAND_MEDIA_PLAY_PAUSE)
            logger.info(f"Spotify: APPCOMMAND_MEDIA_PLAY_PAUSE result: {result2}")
            return result2
        return True

    def pause(self) -> bool:
        """Pause playback"""
        logger.info("Spotify: pause")
        # Try pause first, fall back to play_pause
        if not self._send_command(self.APPCOMMAND_MEDIA_PAUSE):
            return self._send_command(self.APPCOMMAND_MEDIA_PLAY_PAUSE)
        return True

    def next_track(self) -> bool:
        """Skip to next track"""
        logger.info("Spotify: next")
        return self._send_command(self.APPCOMMAND_MEDIA_NEXTTRACK)

    def prev_track(self) -> bool:
        """Go to previous track"""
        logger.info("Spotify: previous")
        return self._send_command(self.APPCOMMAND_MEDIA_PREVIOUSTRACK)

    def get_current_track(self) -> Optional[dict]:
        """Get current track info from window title"""
        hwnd = self._find_spotify_window()
        if not hwnd or not self._cached_title:
            return None

        title = self._cached_title
        # Parse "Artist - Track" format
        if " - " in title:
            parts = title.split(" - ", 1)
            return {
                "artist": parts[0].strip(),
                "title": parts[1].strip() if len(parts) > 1 else "Unknown",
                "full_title": title,
            }
        return {"title": title, "artist": "", "full_title": title}


# Keep old name for compatibility
MediaKeyController = SpotifyController


def get_spotify_window_title() -> Optional[str]:
    """Get Spotify window title (contains current track info)"""
    controller = SpotifyController()
    track = controller.get_current_track()
    return track.get("full_title") if track else None


# Singleton controller instance
_spotify_controller: Optional[SpotifyController] = None


def get_spotify_controller() -> SpotifyController:
    """Get the Spotify controller singleton"""
    global _spotify_controller
    if _spotify_controller is None:
        _spotify_controller = SpotifyController()
    return _spotify_controller
