"""Test getting progress from Spotify"""

import ctypes
from ctypes import wintypes

import psutil

user32 = ctypes.windll.user32


def find_spotify_window():
    """Find Spotify's main window"""
    result = {"hwnd": None, "title": None}

    def callback(hwnd, lParam):
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        try:
            proc = psutil.Process(pid.value)
            if "spotify" not in proc.name().lower():
                return True
        except Exception:
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value

            if " - " in title and title not in [
                "Spotify",
                "Spotify Free",
                "Spotify Premium",
            ]:
                result["hwnd"] = hwnd
                result["title"] = title
                return False

        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return result["hwnd"], result["title"]


print("Finding Spotify window...")
hwnd, title = find_spotify_window()

if hwnd:
    print(f"Window: {hwnd}")
    print(f"Title: {title}")
    print("\nWindow title doesn't contain progress info.")
    print("We need to use Windows Media Session API or another method.")
    print("\nChecking if Spotify appears in Media Session API...")

    try:
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as MediaManager,
        )

        manager = MediaManager.request_async().get_results()
        sessions = manager.get_sessions()

        print(f"Found {len(sessions)} media sessions")
        for i, session in enumerate(sessions):
            app_id = session.source_app_user_model_id or ""
            print(f"  Session {i}: {app_id}")

            if "spotify" in app_id.lower():
                print("  ✓ Spotify found in Media Session API!")
                try:
                    timeline = session.get_timeline_properties()
                    if timeline:
                        pos = (
                            timeline.position.total_seconds()
                            if timeline.position
                            else 0
                        )
                        dur = (
                            timeline.end_time.total_seconds()
                            if timeline.end_time
                            else 0
                        )
                        print(f"    Position: {pos:.1f}s / {dur:.1f}s")
                except Exception as e:
                    print(f"    Error getting timeline: {e}")
    except Exception as e:
        print(f"Error checking Media Session API: {e}")
else:
    print("Spotify window not found!")

input("\nPress Enter...")
