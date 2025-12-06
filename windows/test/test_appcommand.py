"""Quick test of WM_APPCOMMAND to Spotify"""

import ctypes
import time
from ctypes import wintypes

import psutil

user32 = ctypes.windll.user32

APPCOMMAND_MEDIA_PLAY_PAUSE = 14
WM_APPCOMMAND = 0x0319


def find_spotify_main_window():
    """Find Spotify's main window (the one with track title)"""
    result = {"hwnd": None, "title": None}

    def callback(hwnd, lParam):
        # Get process ID
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        try:
            proc = psutil.Process(pid.value)
            if "spotify" not in proc.name().lower():
                return True
        except Exception:
            return True

        # Get title
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value

            # The main window has "Artist - Track" format
            if " - " in title and title not in [
                "Spotify",
                "Spotify Free",
                "Spotify Premium",
            ]:
                result["hwnd"] = hwnd
                result["title"] = title
                return False  # Stop enumeration

        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return result["hwnd"], result["title"]


def send_play_pause(hwnd):
    """Send play/pause to window"""
    lParam = APPCOMMAND_MEDIA_PLAY_PAUSE << 16
    return user32.SendMessageW(hwnd, WM_APPCOMMAND, hwnd, lParam)


print("Finding Spotify...")
hwnd, title = find_spotify_main_window()

if hwnd:
    print(f"Found: {title}")
    print(f"Window handle: {hwnd}")
    print("\nSending PLAY/PAUSE in 2 seconds...")
    time.sleep(2)
    result = send_play_pause(hwnd)
    print(f"Result: {result}")
    print("Did Spotify pause/resume?")
else:
    print("Spotify main window not found!")

input("\nPress Enter...")
