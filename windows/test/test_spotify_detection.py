"""
Test script to explore different ways to detect and control Spotify on Windows
"""

import asyncio
import ctypes

print("=" * 60)
print("Spotify Detection Test")
print("=" * 60)

# ============================================================================
# TEST 1: Windows Media Session API (current approach)
# ============================================================================
print("\n[TEST 1] Windows Media Session API")
print("-" * 40)

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    )

    async def test_media_session():
        manager = await MediaManager.request_async()
        sessions = manager.get_sessions()

        print(f"Sessions found: {len(list(sessions))}")

        # Re-get sessions (iterator consumed)
        sessions = manager.get_sessions()
        for session in sessions:
            app_id = session.source_app_user_model_id or "unknown"
            print(f"  - App ID: {app_id}")

            try:
                props = await session.try_get_media_properties_async()
                if props:
                    print(f"    Title: {props.title}")
                    print(f"    Artist: {props.artist}")
            except Exception as e:
                print(f"    Error getting props: {e}")

        current = manager.get_current_session()
        if current:
            print(f"\nCurrent session: {current.source_app_user_model_id}")
        else:
            print("\nNo current session")

    asyncio.run(test_media_session())

except Exception as e:
    print(f"ERROR: {e}")

# ============================================================================
# TEST 2: pycaw - Audio Session Control (detects apps playing audio)
# ============================================================================
print("\n[TEST 2] pycaw - Audio Sessions")
print("-" * 40)

try:
    from pycaw.pycaw import AudioUtilities, ISimpleAudioVolume

    sessions = AudioUtilities.GetAllSessions()
    print(f"Audio sessions found: {len(sessions)}")

    for session in sessions:
        if session.Process:
            volume = session._ctl.QueryInterface(ISimpleAudioVolume)
            mute = volume.GetMute()
            vol = volume.GetMasterVolume()
            print(f"  - {session.Process.name()} (PID: {session.Process.pid})")
            print(f"    Volume: {vol:.0%}, Muted: {mute}")

            if "spotify" in session.Process.name().lower():
                print("    *** SPOTIFY DETECTED! ***")

except ImportError:
    print("pycaw not installed. Run: pip install pycaw")
except Exception as e:
    print(f"ERROR: {e}")

# ============================================================================
# TEST 3: Check for Spotify process directly
# ============================================================================
print("\n[TEST 3] Process Detection")
print("-" * 40)

try:
    import psutil

    spotify_procs = []
    for proc in psutil.process_iter(["pid", "name", "status"]):
        if "spotify" in proc.info["name"].lower():
            spotify_procs.append(proc.info)

    print(f"Spotify processes: {len(spotify_procs)}")
    for p in spotify_procs:
        print(f"  - PID {p['pid']}: {p['name']} ({p['status']})")

except ImportError:
    print("psutil not installed. Run: pip install psutil")
except Exception as e:
    print(f"ERROR: {e}")

# ============================================================================
# TEST 4: Simulate media key press
# ============================================================================
print("\n[TEST 4] Media Key Simulation")
print("-" * 40)

try:
    # Virtual key codes for media keys
    VK_MEDIA_PLAY_PAUSE = 0xB3
    VK_MEDIA_NEXT_TRACK = 0xB0
    VK_MEDIA_PREV_TRACK = 0xB1

    user32 = ctypes.windll.user32

    def press_media_key(vk_code):
        """Simulate a media key press"""
        KEYEVENTF_EXTENDEDKEY = 0x0001
        KEYEVENTF_KEYUP = 0x0002

        # Key down
        user32.keybd_event(vk_code, 0, KEYEVENTF_EXTENDEDKEY, 0)
        # Key up
        user32.keybd_event(vk_code, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)

    print("Media key simulation available!")
    print("  - press_media_key(VK_MEDIA_PLAY_PAUSE) to toggle play/pause")
    print("  - press_media_key(VK_MEDIA_NEXT_TRACK) to skip")
    print("  - press_media_key(VK_MEDIA_PREV_TRACK) to go back")

    # Uncomment to test:
    # print("\nSimulating Play/Pause in 2 seconds...")
    # import time
    # time.sleep(2)
    # press_media_key(VK_MEDIA_PLAY_PAUSE)
    # print("Done!")

except Exception as e:
    print(f"ERROR: {e}")

# ============================================================================
# TEST 5: Spotify window title (for current track)
# ============================================================================
print("\n[TEST 5] Window Title Detection")
print("-" * 40)

try:
    user32 = ctypes.windll.user32

    def get_spotify_window_title():
        """Find Spotify window and get its title (contains current track)"""
        EnumWindows = user32.EnumWindows
        EnumWindowsProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)
        )
        GetWindowTextW = user32.GetWindowTextW
        GetWindowTextLengthW = user32.GetWindowTextLengthW
        IsWindowVisible = user32.IsWindowVisible
        GetClassNameW = user32.GetClassNameW

        titles = []

        def foreach_window(hwnd, lParam):
            if IsWindowVisible(hwnd):
                length = GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    GetWindowTextW(hwnd, buff, length + 1)
                    title = buff.value

                    # Get class name
                    class_buff = ctypes.create_unicode_buffer(256)
                    GetClassNameW(hwnd, class_buff, 256)
                    class_name = class_buff.value

                    if "spotify" in title.lower() or "spotify" in class_name.lower():
                        titles.append((title, class_name))
            return True

        EnumWindows(EnumWindowsProc(foreach_window), 0)
        return titles

    spotify_windows = get_spotify_window_title()
    print(f"Spotify windows found: {len(spotify_windows)}")
    for title, class_name in spotify_windows:
        print(f"  - Title: '{title}'")
        print(f"    Class: {class_name}")

        # Parse title for track info
        if " - " in title and title != "Spotify":
            parts = title.split(" - ", 1)
            if len(parts) == 2:
                print(f"    -> Artist: {parts[0]}")
                print(f"    -> Track: {parts[1]}")

except Exception as e:
    print(f"ERROR: {e}")

print("\n" + "=" * 60)
print("Tests complete!")
print("=" * 60)

input("\nPress Enter to exit...")
