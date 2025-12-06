# Auto-Stop Media - Windows Media Session Manager
# Uses Windows Runtime to control system media playback
# Falls back to pycaw for apps that don't use Media Session API (like Spicetify)

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Optional

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSession as MediaSession,
    )
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    )
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    )
    from winrt.windows.storage.streams import Buffer, DataReader, InputStreamOptions

    WINSDK_AVAILABLE = True
except ImportError:
    WINSDK_AVAILABLE = False
    logging.warning("winrt packages not available - Windows media control disabled")

# Fallback detection for apps like Spotify with Spicetify
try:
    from audio_detector import (  # AudioDetector,; get_spotify_controller,; get_spotify_window_title,
        PYCAW_AVAILABLE,
    )

    logger = logging.getLogger(__name__)
    logger.debug(f"audio_detector loaded, PYCAW_AVAILABLE={PYCAW_AVAILABLE}")
except ImportError as e:
    PYCAW_AVAILABLE = False
    AudioDetector = None
    get_spotify_controller = None
    logging.warning(f"audio_detector not available: {e}")

from config import ACTION

logger = logging.getLogger(__name__)


@dataclass
class DesktopMediaInfo:
    """Information about a desktop media session"""

    session_id: str
    app_id: str
    title: str = "Unknown"
    artist: str = ""
    album: str = ""
    cover_url: str = ""  # Base64 data URL
    duration: float = 0
    current_time: float = 0
    is_playing: bool = False
    playback_rate: float = 1.0
    last_update: datetime = field(default_factory=datetime.now)
    manually_paused: bool = False  # True if user manually paused (vs ended/stopped)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "mediaId": self.session_id,
            "adapter": "desktop",
            "appId": self.app_id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "cover": self.cover_url,
            "duration": self.duration,
            "currentTime": self.current_time,
            "isPlaying": self.is_playing,
            "playbackRate": self.playback_rate,
            "isDesktop": True,  # Flag to identify desktop media in extension
            "mediaType": "audio",
            "manuallyPaused": self.manually_paused,  # True if user manually paused
        }


class WindowsMediaManager:
    """Manages Windows media sessions and provides control"""

    # Known browser app IDs to filter out
    BROWSER_APP_IDS = {
        "firefox",
        "firefox.exe",
        "mozilla.firefox",
        "chrome",
        "chrome.exe",
        "google.chrome",
        "msedge",
        "msedge.exe",
        "microsoft.edge",
        "opera",
        "opera.exe",
        "opera.opera",
        "brave",
        "brave.exe",
        "brave.brave",
        "vivaldi",
        "vivaldi.exe",
    }

    def __init__(self):
        self._manager: Optional[MediaManager] = None
        self._sessions: Dict[str, MediaSession] = {}
        self._media_info: Dict[str, DesktopMediaInfo] = {}
        self._active_session_id: Optional[str] = None
        self._on_state_change: Optional[Callable] = None
        self._running = False
        self._poll_task: Optional[asyncio.Task] = None

        # Browser filtering
        self._registered_browser: Optional[str] = (
            None  # App ID of the browser with extension
        )
        self._browser_media_titles: set = set()  # Titles currently playing in browser

        # Process name cache for .exe name lookup
        self._process_name_cache: Dict[str, str] = {}  # app_id -> exe_name
        self._process_cache_time = 0
        self._process_cache_ttl = 30  # Refresh every 30 seconds

    @property
    def is_available(self) -> bool:
        return WINSDK_AVAILABLE

    def register_browser(self, browser_info: Dict[str, Any]):
        """Register the browser that has the extension installed"""
        browser_name = browser_info.get("browser", "").lower()
        user_agent = browser_info.get("userAgent", "").lower()

        # Try to detect browser from user agent
        if "firefox" in user_agent:
            self._registered_browser = "firefox"
        elif "edg/" in user_agent or "edge" in user_agent:
            self._registered_browser = "msedge"
        elif "chrome" in user_agent:
            self._registered_browser = "chrome"
        elif "opera" in user_agent:
            self._registered_browser = "opera"
        elif "brave" in user_agent:
            self._registered_browser = "brave"
        else:
            self._registered_browser = browser_name or "unknown"

        logger.info(f"Registered browser: {self._registered_browser}")

    def update_browser_media(self, title: str, is_playing: bool):
        """Update the list of media titles currently in browser"""
        # Normalize title for comparison
        normalized = self._normalize_title(title)

        if is_playing and normalized:
            self._browser_media_titles.add(normalized)
            logger.debug(f"Browser media added: {normalized}")
        elif normalized in self._browser_media_titles:
            self._browser_media_titles.discard(normalized)
            logger.debug(f"Browser media removed: {normalized}")

    def _normalize_title(self, title: str) -> str:
        """Normalize a title for comparison"""
        if not title:
            return ""
        # Lowercase and strip whitespace
        return title.lower().strip()

    def _is_browser_app_id(self, app_id: str) -> bool:
        """Quick check if an app ID looks like a browser (for early filtering)"""
        if not app_id:
            return False

        app_id_lower = app_id.lower()

        # Check known browser app IDs
        for browser_id in self.BROWSER_APP_IDS:
            if browser_id in app_id_lower:
                return True

        # Firefox on Windows often has a hex hash as app ID (e.g., "83C1C0F3FA8524B1")
        # Detect this: all hex chars, no dots/slashes, 8+ chars
        if len(app_id) >= 8 and all(c in "0123456789ABCDEFabcdef" for c in app_id):
            return True

        return False

    def _is_browser_session(
        self, session: "MediaSession", info: "DesktopMediaInfo"
    ) -> bool:
        """Check if a session is from the registered browser - by app ID"""
        try:
            app_id = session.source_app_user_model_id or ""
            app_id_lower = app_id.lower()

            # Check if this is the registered browser
            if self._registered_browser:
                if self._registered_browser in app_id_lower:
                    logger.debug(f"Filtering browser by app ID: {app_id}")
                    return True

            # Check known browser app IDs
            for browser_id in self.BROWSER_APP_IDS:
                if browser_id in app_id_lower:
                    logger.debug(f"Filtering known browser: {app_id}")
                    return True

            # Firefox on Windows often has a hex hash as app ID (e.g., "83C1C0F3FA8524B1")
            # Detect this: all hex chars, no dots/slashes, 8+ chars
            if len(app_id) >= 8 and all(c in "0123456789ABCDEFabcdef" for c in app_id):
                # This is likely a browser with a hash ID
                # Only filter if browser is registered (we know we have a browser extension running)
                if self._registered_browser:
                    logger.debug(
                        f"Filtering hex-hash app ID (likely browser): {app_id}"
                    )
                    return True

            return False

        except Exception as e:
            logger.debug(f"Error checking browser session: {e}")
            return False

    async def start(self, on_state_change: Callable = None):
        """Initialize and start monitoring media sessions"""
        if not WINSDK_AVAILABLE:
            logger.error("Windows SDK not available")
            return False

        self._on_state_change = on_state_change
        self._running = True

        try:
            self._manager = await MediaManager.request_async()

            # Get initial sessions
            await self._refresh_sessions()

            # Start polling for changes (events are unreliable)
            self._poll_task = asyncio.create_task(self._poll_media_state())

            logger.info("Windows Media Manager started")
            return True

        except Exception as e:
            logger.error(f"Failed to start Windows Media Manager: {e}")
            return False

    async def stop(self):
        """Stop monitoring media sessions"""
        self._running = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        self._sessions.clear()
        self._media_info.clear()
        logger.info("Windows Media Manager stopped")

    async def _refresh_sessions(self):
        """Refresh the list of media sessions"""
        if not self._manager:
            return

        try:
            sessions = self._manager.get_sessions()

            # Log ALL sessions Windows reports
            session_count = 0
            for s in sessions:
                session_count += 1
            logger.debug(f"Windows reports {session_count} media session(s)")

            # Track current session IDs
            current_ids = set()

            for session in sessions:
                app_id = session.source_app_user_model_id or "unknown"
                session_id = self._get_session_id(session)
                current_ids.add(session_id)

                # Log every session we see
                logger.debug(
                    f"Found session: app_id='{app_id}' -> session_id='{session_id}'"
                )

                if session_id not in self._sessions:
                    self._sessions[session_id] = session
                    logger.info(f"NEW session discovered: {session_id} (app: {app_id})")

            # Remove stale sessions
            stale_ids = set(self._sessions.keys()) - current_ids
            for session_id in stale_ids:
                del self._sessions[session_id]
                if session_id in self._media_info:
                    del self._media_info[session_id]
                logger.info(f"Session REMOVED: {session_id}")

            # Update current session (the one Windows considers "active")
            current = self._manager.get_current_session()
            if current:
                current_app_id = current.source_app_user_model_id or "unknown"
                self._active_session_id = self._get_session_id(current)
                logger.info(
                    f"Windows CURRENT/ACTIVE session: {current_app_id} -> {self._active_session_id}"
                )

                # If current session isn't in our list, add it!
                if self._active_session_id not in self._sessions:
                    self._sessions[self._active_session_id] = current
                    logger.info(
                        f"Added current session that wasn't in list: {self._active_session_id}"
                    )
            else:
                self._active_session_id = None
                logger.debug("No current/active session")

        except Exception as e:
            logger.error(f"Error refreshing sessions: {e}")

    def _get_session_id(self, session: "MediaSession") -> str:
        """Generate a unique ID for a session based on app ID only (dedupe by app)"""
        try:
            source_app_id = session.source_app_user_model_id or ""
            # Use just the app ID - we'll dedupe further by title in get_state()
            return f"desktop-{source_app_id}"
        except Exception:
            return f"desktop-{id(session)}"

    def _refresh_process_cache(self):
        """Refresh the process name cache"""
        import time

        now = time.time()
        if now - self._process_cache_time < self._process_cache_ttl:
            return  # Cache still valid

        try:
            import psutil

            self._process_name_cache = {}
            for proc in psutil.process_iter(["pid", "name"]):
                if proc.info["name"]:
                    exe_name = proc.info["name"].replace(".exe", "").replace(".EXE", "")
                    name_lower = exe_name.lower()
                    # Store mapping: lowercase name -> display name
                    self._process_name_cache[name_lower] = exe_name
            self._process_cache_time = now
            logger.debug(
                f"Refreshed process cache: {len(self._process_name_cache)} processes"
            )
        except Exception as e:
            logger.debug(f"Could not refresh process cache: {e}")

    def _get_app_name(self, session: "MediaSession") -> str:
        """Get a friendly app name from the session - prefer .exe name"""
        try:
            app_id = session.source_app_user_model_id or ""

            # Refresh process cache if needed
            self._refresh_process_cache()

            # Try to match app_id to a cached process name
            app_id_lower = app_id.lower()

            # Direct match: if app_id contains .exe, extract and match
            if ".exe" in app_id_lower:
                exe_part = app_id_lower.split(".exe")[0].split(".")[-1]
                if exe_part in self._process_name_cache:
                    return self._process_name_cache[exe_part]

            # Try matching app_id parts to process names
            app_id_parts = [
                p
                for p in app_id_lower.split(".")
                if p and p not in ["exe", "com", "app", "squirrel"]
            ]
            for part in reversed(app_id_parts):  # Check from end (usually the app name)
                if part in self._process_name_cache:
                    return self._process_name_cache[part]

            # Try substring matching (app_id might contain process name)
            for proc_name, display_name in self._process_name_cache.items():
                if proc_name in app_id_lower or app_id_lower in proc_name:
                    return display_name

            # Known app ID mappings for common apps (fallback if process cache doesn't have it)
            known_apps = {
                "spotify": "Spotify",
                "spotify.exe": "Spotify",
                "musicbee": "MusicBee",
                "foobar2000": "foobar2000",
                "vlc": "VLC",
                "itunes": "iTunes",
                "winamp": "Winamp",
                "groove": "Groove Music",
                "amazon music": "Amazon Music",
                "deezer": "Deezer",
                "tidal": "TIDAL",
                "youtube music": "YouTube Music",
                "chrome": "Chrome",
                "firefox": "Firefox",
                "msedge": "Edge",
                "opera": "Opera",
            }

            # Check known apps
            for key, name in known_apps.items():
                if key in app_id_lower:
                    return name

            # Try to extract a readable name from the app ID
            if app_id:
                # Handle various formats:
                # "Spotify.exe" -> "Spotify"
                # "com.squirrel.Spotify.Spotify" -> "Spotify"
                # "{83C1C0F3...}" -> try to get .exe name
                # "Microsoft.ZuneMusic_8wekyb..." -> "Zune Music"

                # If it contains .exe, extract the exe name
                if ".exe" in app_id or ".EXE" in app_id:
                    # Extract the .exe name (without extension)
                    parts = app_id.replace(".exe", "").replace(".EXE", "").split(".")
                    exe_name = (
                        parts[-1] if parts else app_id.split(".exe")[0].split(".EXE")[0]
                    )
                    if exe_name:
                        return exe_name

                # Remove .exe suffix for further processing
                clean_id = app_id.replace(".exe", "").replace(".EXE", "")

                # If it's a GUID/hash (starts with { or is all hex), try to find .exe name
                if clean_id.startswith("{") or (
                    len(clean_id) >= 8
                    and all(c in "0123456789ABCDEFabcdef" for c in clean_id)
                ):
                    # For now, return a generic name but we could improve this
                    return "Desktop App"

                # Handle Microsoft Store apps: Microsoft.ZuneMusic_xxx -> Zune Music
                if clean_id.startswith("Microsoft."):
                    parts = clean_id.split("_")[0].replace("Microsoft.", "")
                    # Convert CamelCase to spaces
                    name = ""
                    for c in parts:
                        if c.isupper() and name:
                            name += " "
                        name += c
                    return name or "Desktop App"

                # Split by . and get the last meaningful part
                parts = clean_id.split(".")
                # Filter out common prefixes and get the app name
                for part in reversed(parts):
                    if part.lower() not in ["exe", "com", "app", "squirrel", ""]:
                        return part.capitalize() if part.islower() else part

                return parts[-1] if parts else "Desktop App"

            return "Desktop App"
        except Exception as e:
            logger.debug(f"Error getting app name: {e}")
            return "Desktop App"

    def _get_dedup_key(self, info: "DesktopMediaInfo") -> str:
        """Get a key for deduplicating media (same app + same title = same media)"""
        # Use app name + title to deduplicate
        # This prevents the same song showing multiple times
        return f"{info.app_id}:{info.title}"

    async def _poll_media_state(self):
        """Poll media state periodically"""
        from config import MEDIA_POLL_INTERVAL

        poll_count = 0
        BROADCAST_EVERY_N_POLLS = (
            4  # Broadcast state every N polls even without changes
        )
        logger.info("Media polling started")

        while self._running:
            try:
                await self._refresh_sessions()
                await self._update_all_media_info()

                # Also check for Spotify via pycaw (fallback for Spicetify)
                try:
                    await self._check_spotify_fallback()
                except Exception as e:
                    logger.error(f"Spotify fallback check error: {e}", exc_info=True)

                # Periodically broadcast state for progress updates
                poll_count += 1
                if poll_count >= BROADCAST_EVERY_N_POLLS:
                    poll_count = 0
                    if self._on_state_change and self._media_info:
                        logger.debug("Periodic state broadcast for progress updates")
                        await self._on_state_change(self.get_state())

            except Exception as e:
                logger.error(f"Error polling media state: {e}")

            await asyncio.sleep(MEDIA_POLL_INTERVAL)

    async def _check_spotify_fallback(self):
        """Check for Spotify playing via pycaw (for Spicetify that doesn't use Media Session API)"""

        if not PYCAW_AVAILABLE:
            return

        # Check if Spotify is already detected via Media Session API
        # Also check by app_id in existing media_info (more reliable)
        spotify_in_sessions = any(
            "spotify" in sid.lower() for sid in self._sessions.keys()
        )

        # Also check if we already have a Spotify session in media_info (not fallback)
        spotify_in_media_info = any(
            info.app_id.lower() == "spotify"
            and not session_id.startswith("desktop-spotify-fallback")
            for session_id, info in self._media_info.items()
        )

        if spotify_in_sessions or spotify_in_media_info:
            # Remove fallback if it exists (regular detection is better)
            if "desktop-spotify-fallback" in self._media_info:
                logger.debug(
                    "Removing Spotify fallback - detected via Media Session API"
                )
                del self._media_info["desktop-spotify-fallback"]
                if self._on_state_change:
                    await self._on_state_change(self.get_state())
            return  # Already detected normally

        try:
            from audio_detector import AudioDetector, get_spotify_controller

            detector = AudioDetector()
            spotify_app = detector.is_spotify_playing()

            if spotify_app:
                # Spotify is playing but not in Media Session API!
                controller = get_spotify_controller()
                track_info = controller.get_current_track()

                session_id = "desktop-spotify-fallback"

                # Create or update Spotify media info
                if track_info:
                    title = f"{track_info.get('artist', '')} - {track_info.get('title', 'Unknown')}"
                    if title.startswith(" - "):
                        title = track_info.get("title", "Spotify")
                else:
                    title = "Spotify"

                # Try to get REAL progress from Media Session API
                # If we can't get it, set to 0 so progress bar doesn't show
                current_time = 0
                duration = 0
                got_real_progress = False

                # Try to get progress from Media Session API
                # Spotify might appear there even if not in our sessions list
                try:
                    manager = MediaManager.request_async().get_results()
                    sessions = manager.get_sessions()
                    for session in sessions:
                        app_id = session.source_app_user_model_id or ""
                        if "spotify" in app_id.lower():
                            # Found Spotify in Media Session API - try to get timeline
                            try:
                                timeline = session.get_timeline_properties()
                                if timeline:
                                    current_time = (
                                        timeline.position.total_seconds()
                                        if timeline.position
                                        else 0
                                    )
                                    duration = (
                                        timeline.end_time.total_seconds()
                                        if timeline.end_time
                                        else 0
                                    )
                                    if duration > 0:
                                        got_real_progress = True
                                        logger.info(
                                            f"Got REAL Spotify progress from Media Session API: {current_time:.1f}/{duration:.1f}"
                                        )
                            except Exception as e:
                                logger.debug(
                                    f"Error getting timeline from Spotify session: {e}"
                                )
                            break
                except Exception as e:
                    # Can't get progress - that's okay, we'll just not show progress bar
                    logger.debug(
                        f"Could not get Spotify progress from Media Session API: {e}"
                    )

                # Get or create existing info
                old_info = self._media_info.get(session_id)

                # If we have old info and it's the same track, update progress ONLY if we got real progress
                if old_info and old_info.title == title:
                    # Check if Spotify just started playing (was paused, now playing)
                    was_paused = not old_info.is_playing

                    if got_real_progress:
                        # Update with real progress
                        old_info.current_time = current_time
                        old_info.duration = duration
                        logger.debug(
                            f"Spotify progress update (REAL): {current_time:.1f}/{duration:.1f}"
                        )
                    # If no real progress, keep existing values (or set to 0 if we never had progress)
                    elif old_info.duration == 0:
                        # Never had progress, keep at 0
                        old_info.current_time = 0
                        old_info.duration = 0

                    old_info.is_playing = True
                    self._media_info[session_id] = old_info

                    # CRITICAL: If Spotify just started playing, pause all other desktop media
                    if was_paused:
                        logger.info(
                            f"Spotify fallback resumed playing: {title} - pausing other desktop media"
                        )
                        paused_count = await self.pause_all_except(session_id)
                        if paused_count > 0:
                            logger.info(
                                f"Paused {paused_count} other desktop media session(s)"
                            )

                    if self._on_state_change:
                        await self._on_state_change(self.get_state())
                else:
                    # New track or new session - only set progress if we have real data
                    info = DesktopMediaInfo(
                        session_id=session_id,
                        app_id="Spotify",
                        title=title,
                        artist=track_info.get("artist", "") if track_info else "",
                        is_playing=True,
                        current_time=current_time if got_real_progress else 0,
                        duration=duration
                        if got_real_progress
                        else 0,  # 0 = no progress bar
                    )
                    if got_real_progress:
                        logger.info(
                            f"Spotify detected via fallback: {title} (REAL progress: {current_time:.1f}/{duration:.1f})"
                        )
                    else:
                        logger.info(
                            f"Spotify detected via fallback: {title} (no progress available)"
                        )
                    self._media_info[session_id] = info

                    # CRITICAL: New Spotify track started - pause all other desktop media
                    logger.info(
                        f"Spotify fallback new track: {title} - pausing other desktop media"
                    )
                    paused_count = await self.pause_all_except(session_id)
                    if paused_count > 0:
                        logger.info(
                            f"Paused {paused_count} other desktop media session(s)"
                        )

                    if self._on_state_change:
                        await self._on_state_change(self.get_state())
            else:
                # Spotify not playing - check if we should keep fallback or remove it
                if "desktop-spotify-fallback" in self._media_info:
                    # Check if Spotify is in regular sessions - if so, remove fallback
                    spotify_in_sessions = any(
                        "spotify" in sid.lower() for sid in self._sessions.keys()
                    )
                    spotify_in_media_info = any(
                        info.app_id.lower() == "spotify"
                        and not sid.startswith("desktop-spotify-fallback")
                        for sid, info in self._media_info.items()
                    )

                    if spotify_in_sessions or spotify_in_media_info:
                        # Remove fallback - regular session handles it
                        logger.debug(
                            "Removing Spotify fallback - detected in regular sessions"
                        )
                        del self._media_info["desktop-spotify-fallback"]
                        if self._on_state_change:
                            await self._on_state_change(self.get_state())
                    else:
                        # Keep fallback but mark as paused
                        old_info = self._media_info["desktop-spotify-fallback"]
                        old_info.is_playing = False
                        logger.debug("Spotify paused (fallback)")
                        # Still broadcast update so extension knows it's paused
                        if self._on_state_change:
                            await self._on_state_change(self.get_state())

        except Exception as e:
            logger.debug(f"Spotify fallback check error: {e}")

    async def _update_all_media_info(self):
        """Update info for all sessions and notify of changes"""
        changed = False
        current_session_ids = set()

        for session_id, session in list(self._sessions.items()):
            try:
                # Skip browser sessions early to avoid hanging on their async calls
                app_id_raw = ""
                try:
                    app_id_raw = session.source_app_user_model_id or ""
                except Exception:
                    pass

                if self._is_browser_app_id(app_id_raw):
                    continue  # Skip browser sessions

                info = await self._get_media_info(session, session_id)
                current_session_ids.add(session_id)

                logger.debug(
                    f"Session {session_id}: playing={info.is_playing}, title='{info.title}', pos={info.current_time:.1f}/{info.duration:.1f}"
                )

                # Filter out browser sessions
                if self._is_browser_session(session, info):
                    logger.debug(f"Filtering browser session: {session_id}")
                    if session_id in self._media_info:
                        del self._media_info[session_id]
                        changed = True
                    continue

                # Check if this is a meaningful change
                old_info = self._media_info.get(session_id)
                if old_info:
                    # Check for significant changes (title, playing state, duration, or large position jump)
                    title_changed = old_info.title != info.title
                    playing_changed = old_info.is_playing != info.is_playing
                    duration_changed = abs(old_info.duration - info.duration) > 1
                    # Position jump detection (track skip)
                    position_jump = abs(info.current_time - old_info.current_time) > 10

                    if (
                        title_changed
                        or playing_changed
                        or duration_changed
                        or position_jump
                    ):
                        logger.info(
                            f"Media changed: {session_id} - title:{title_changed} playing:{playing_changed} duration:{duration_changed} jump:{position_jump}"
                        )
                        changed = True

                    # CRITICAL: If this media just started playing, pause all other desktop media
                    # This ensures only one desktop media plays at a time (like browser media)
                    if playing_changed and info.is_playing and not old_info.is_playing:
                        logger.info(
                            f"Desktop media started playing: {session_id} - '{info.title}' - pausing other desktop media"
                        )
                        paused_count = await self.pause_all_except(session_id)
                        if paused_count > 0:
                            logger.info(
                                f"Paused {paused_count} other desktop media session(s)"
                            )
                else:
                    logger.info(f"New media session: {session_id} - '{info.title}'")
                    changed = True

                    # CRITICAL: If new media is playing, pause all other desktop media
                    if info.is_playing:
                        logger.info(
                            f"New desktop media playing: {session_id} - '{info.title}' - pausing other desktop media"
                        )
                        paused_count = await self.pause_all_except(session_id)
                        if paused_count > 0:
                            logger.info(
                                f"Paused {paused_count} other desktop media session(s)"
                            )

                self._media_info[session_id] = info

            except Exception as e:
                logger.error(f"Error updating session {session_id}: {e}")

        # Clean up stale sessions that no longer exist
        # Don't clean up fallback sessions (they're managed separately)
        stale_ids = set(self._media_info.keys()) - current_session_ids
        for stale_id in stale_ids:
            if stale_id.startswith("desktop-spotify-fallback"):
                continue  # Fallback session is managed by _check_spotify_fallback
            logger.info(f"Removing stale session: {stale_id}")
            del self._media_info[stale_id]
            changed = True

        # Clean up sessions that have been stopped for a while (more than 30 seconds)
        # This prevents ended media from staying in the paused list forever
        from datetime import datetime, timedelta

        now = datetime.now()
        stopped_timeout = timedelta(seconds=30)

        for session_id, info in list(self._media_info.items()):
            if session_id.startswith("desktop-spotify-fallback"):
                continue  # Fallback session is managed separately

            # If not playing and hasn't been updated recently, remove it
            if not info.is_playing:
                time_since_update = now - info.last_update
                if time_since_update > stopped_timeout:
                    logger.info(
                        f"Removing stopped session (timeout): {session_id} - '{info.title}'"
                    )
                    del self._media_info[session_id]
                    changed = True

        if changed and self._on_state_change:
            logger.debug(f"Broadcasting state change: {len(self._media_info)} sessions")
            await self._on_state_change(self.get_state())

    async def _get_media_info(
        self, session: "MediaSession", session_id: str
    ) -> DesktopMediaInfo:
        """Get current media info from a session"""
        info = DesktopMediaInfo(
            session_id=session_id,
            app_id=self._get_app_name(session),
        )

        try:
            # Get timeline (position/duration) - get this first to check if media ended
            timeline = session.get_timeline_properties()
            if timeline:
                # Convert from TimeSpan (100-nanosecond units) to seconds
                info.current_time = (
                    timeline.position.total_seconds() if timeline.position else 0
                )
                info.duration = (
                    timeline.end_time.total_seconds() if timeline.end_time else 0
                )
        except Exception as e:
            logger.debug(f"Error getting timeline: {e}")

        try:
            # Get playback info
            playback_info = session.get_playback_info()
            if playback_info:
                status = playback_info.playback_status
                info.is_playing = status == PlaybackStatus.PLAYING

                # Detect manual pause: check if status is PAUSED
                # Windows Media Session API status values:
                # 0 = Playing, 1 = Paused, 2 = Stopped, 3 = Closed
                # If status is PAUSED (1), it's likely manually paused
                # If status is STOPPED (2) or CLOSED (3), it's likely ended/closed
                try:
                    # Try to access PAUSED constant
                    paused_status = getattr(PlaybackStatus, "PAUSED", None)
                    if paused_status is None:
                        # Fallback: check if status value is 1 (PAUSED)
                        # Convert status to int and check
                        status_value = (
                            int(status) if hasattr(status, "__int__") else status
                        )
                        info.manually_paused = status_value == 1  # 1 = PAUSED
                    else:
                        info.manually_paused = status == paused_status
                except Exception:
                    # Fallback: assume not manually paused if we can't determine
                    info.manually_paused = False

                # Check if media has reached the end (even if status is still PLAYING)
                # Some apps don't update playback status immediately when media ends
                if info.duration > 0 and info.current_time > 0:
                    # If we're at or past the end (with 2 second tolerance), mark as stopped
                    if info.current_time >= (info.duration - 2.0):
                        info.is_playing = False
                        info.manually_paused = False  # Ended, not manually paused
                        logger.debug(
                            f"Media ended: {info.title} ({info.current_time:.1f}/{info.duration:.1f})"
                        )

                # Get playback rate if available
                if playback_info.playback_rate:
                    info.playback_rate = playback_info.playback_rate
        except Exception as e:
            logger.debug(f"Error getting playback info: {e}")

        try:
            # Get media properties (title, artist, etc.)
            # WinRT async can hang, so run in thread with timeout
            def get_props():
                try:
                    import asyncio

                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        return loop.run_until_complete(
                            asyncio.wait_for(
                                session.try_get_media_properties_async(), 1.5
                            )
                        )
                    finally:
                        loop.close()
                except Exception:
                    return None

            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(get_props)
                try:
                    media_props = future.result(timeout=2.0)
                except concurrent.futures.TimeoutError:
                    logger.debug(
                        f"Thread timeout getting media properties for {session_id}"
                    )
                    media_props = None

            if media_props:
                info.title = media_props.title or info.app_id
                info.artist = media_props.artist or ""
                info.album = media_props.album_title or ""

                # Build display title
                if info.artist:
                    info.title = f"{info.artist} - {info.title}"

                # Try to get thumbnail with timeout (runs in thread to avoid blocking)
                thumbnail = media_props.thumbnail
                if thumbnail:
                    try:
                        def get_thumbnail():
                            try:
                                import asyncio
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                try:
                                    return loop.run_until_complete(
                                        asyncio.wait_for(
                                            self._get_thumbnail_data_url(thumbnail), 1.0
                                        )
                                    )
                                finally:
                                    loop.close()
                            except Exception:
                                return ""

                        with concurrent.futures.ThreadPoolExecutor() as executor:
                            future = executor.submit(get_thumbnail)
                            try:
                                info.cover_url = future.result(timeout=1.5)
                            except concurrent.futures.TimeoutError:
                                logger.debug(f"Thumbnail timeout for {session_id}")
                    except Exception as e:
                        logger.debug(f"Error getting thumbnail: {e}")

        except Exception as e:
            logger.debug(f"Error getting media properties: {e}")

        return info

    async def _get_thumbnail_data_url(self, thumbnail) -> str:
        """Convert a thumbnail stream to a base64 data URL"""
        try:
            stream = await thumbnail.open_read_async()
            size = stream.size

            if size == 0 or size > 10 * 1024 * 1024:  # Skip if empty or > 10MB
                return ""

            # Read the stream
            buffer = Buffer(size)
            await stream.read_async(buffer, size, InputStreamOptions.NONE)

            # Get bytes from buffer
            reader = DataReader.from_buffer(buffer)
            bytes_data = bytearray(size)
            for i in range(size):
                bytes_data[i] = reader.read_byte()

            # Convert to base64 data URL
            import base64

            b64 = base64.b64encode(bytes(bytes_data)).decode("ascii")

            # Detect image type from magic bytes
            if bytes_data[:3] == b"\xff\xd8\xff":
                mime = "image/jpeg"
            elif bytes_data[:8] == b"\x89PNG\r\n\x1a\n":
                mime = "image/png"
            else:
                mime = "image/jpeg"  # Default assumption

            return f"data:{mime};base64,{b64}"

        except Exception as e:
            logger.debug(f"Error reading thumbnail: {e}")
            return ""

    def get_state(self) -> Dict[str, Any]:
        """Get current state of all desktop media (deduplicated)"""
        active_media = None
        paused_list = []
        seen_keys = set()  # For deduplication
        seen_titles = set()  # For Spotify-specific deduplication by title
        seen_media_ids = set()  # Also deduplicate by mediaId to catch exact duplicates

        for session_id, info in self._media_info.items():
            # First check: if we've seen this exact mediaId, skip it
            media_id = info.session_id
            if media_id in seen_media_ids:
                logger.debug(
                    f"Skipping duplicate mediaId: {media_id} (session: {session_id})"
                )
                continue
            seen_media_ids.add(media_id)

            # Second check: For Spotify, deduplicate by title only (app_id might differ between regular and fallback)
            # For others, use app_id:title
            if info.app_id.lower() == "spotify":
                # Normalize title for comparison (strip whitespace, case-insensitive)
                normalized_title = info.title.strip().lower() if info.title else ""
                if normalized_title in seen_titles:
                    logger.debug(
                        f"Skipping duplicate Spotify: {info.title} (session: {session_id})"
                    )
                    continue
                seen_titles.add(normalized_title)
            else:
                dedup_key = self._get_dedup_key(info)
                if dedup_key in seen_keys:
                    logger.debug(
                        f"Skipping duplicate: {dedup_key} (session: {session_id})"
                    )
                    continue
                seen_keys.add(dedup_key)

            media_dict = info.to_dict()

            if info.is_playing:
                # If we have an active and another is playing, add active to paused
                if active_media:
                    paused_list.append(active_media)
                active_media = media_dict
            else:
                paused_list.append(media_dict)

        logger.debug(
            f"State: active={active_media.get('title') if active_media else None}, paused={len(paused_list)}"
        )

        return {
            "activeMedia": active_media,
            "pausedList": paused_list,
        }

    async def play(self, session_id: str) -> bool:
        """Play a specific session"""
        logger.info(f"play() called for session_id={session_id}")

        # Handle Spotify fallback
        if session_id == "desktop-spotify-fallback":
            logger.info("play() - handling Spotify fallback")
            result = self._handle_spotify_control(ACTION.PLAY)
            logger.info(f"play() - Spotify result: {result}")
            return result

        session = self._sessions.get(session_id)
        if not session:
            logger.warning(f"Session not found: {session_id}")
            return False

        try:
            await session.try_play_async()
            logger.info(f"Play sent to {session_id}")
            return True
        except Exception as e:
            logger.error(f"Error playing {session_id}: {e}")
            return False

    async def pause(self, session_id: str) -> bool:
        """Pause a specific session"""
        # Handle Spotify fallback
        if session_id == "desktop-spotify-fallback":
            return self._handle_spotify_control(ACTION.PAUSE)

        session = self._sessions.get(session_id)
        if not session:
            logger.warning(f"Session not found: {session_id}")
            return False

        try:
            await session.try_pause_async()
            logger.info(f"Pause sent to {session_id}")
            return True
        except Exception as e:
            logger.error(f"Error pausing {session_id}: {e}")
            return False

    async def toggle(self, session_id: str) -> bool:
        """Toggle play/pause for a specific session"""
        session = self._sessions.get(session_id)
        if not session:
            logger.warning(f"Session not found: {session_id}")
            return False

        try:
            await session.try_toggle_play_pause_async()
            logger.info(f"Toggle sent to {session_id}")
            return True
        except Exception as e:
            logger.error(f"Error toggling {session_id}: {e}")
            return False

    async def next_track(self, session_id: str) -> bool:
        """Skip to next track"""
        session = self._sessions.get(session_id)
        if not session:
            return False

        try:
            await session.try_skip_next_async()
            logger.info(f"Next track sent to {session_id}")
            return True
        except Exception as e:
            logger.error(f"Error skipping {session_id}: {e}")
            return False

    async def prev_track(self, session_id: str) -> bool:
        """Go to previous track"""
        session = self._sessions.get(session_id)
        if not session:
            return False

        try:
            await session.try_skip_previous_async()
            logger.info(f"Previous track sent to {session_id}")
            return True
        except Exception as e:
            logger.error(f"Error going to previous {session_id}: {e}")
            return False

    async def pause_all_except(self, except_session_id: Optional[str] = None) -> int:
        """Pause all playing sessions except the specified one"""
        paused_count = 0

        for session_id, info in self._media_info.items():
            if info.is_playing and session_id != except_session_id:
                if await self.pause(session_id):
                    paused_count += 1

        return paused_count

    async def handle_control(self, action: str, session_id: str) -> bool:
        """Handle a control action from the extension"""
        logger.info(f"handle_control: action={action}, session_id={session_id}")

        # Handle Spotify fallback session specially
        if session_id == "desktop-spotify-fallback":
            logger.info(f"Handling Spotify fallback control: {action}")
            result = self._handle_spotify_control(action)
            logger.info(f"Spotify control result: {result}")
            return result

        if action == ACTION.PLAY:
            return await self.play(session_id)
        elif action == ACTION.PAUSE:
            return await self.pause(session_id)
        elif action == ACTION.SKIP:
            return await self.next_track(session_id)
        elif action == ACTION.PREV:
            return await self.prev_track(session_id)
        else:
            logger.warning(f"Unknown action: {action}")
            return False

    def _handle_spotify_control(self, action: str) -> bool:
        """Handle control for Spotify via WM_APPCOMMAND"""
        try:
            from audio_detector import get_spotify_controller

            controller = get_spotify_controller()

            if action == ACTION.PLAY:
                return controller.play()
            elif action == ACTION.PAUSE:
                return controller.pause()
            elif action == ACTION.SKIP:
                return controller.next_track()
            elif action == ACTION.PREV:
                return controller.prev_track()
            else:
                logger.warning(f"Unknown Spotify action: {action}")
                return False
        except Exception as e:
            logger.error(f"Spotify control error: {e}")
            return False
