"""
Test specific Spotify control methods (not global media keys)
"""

import ctypes
import socket
import time
from ctypes import wintypes

print("=" * 60)
print("Spotify Specific Control Test")
print("=" * 60)

# ============================================================================
# METHOD 1: WM_APPCOMMAND to Spotify window
# Some apps respond to these even when not focused
# ============================================================================
print("\n[METHOD 1] WM_APPCOMMAND to Spotify window")
print("-" * 40)

user32 = ctypes.windll.user32

# App commands
APPCOMMAND_MEDIA_PLAY_PAUSE = 14
APPCOMMAND_MEDIA_STOP = 13
APPCOMMAND_MEDIA_NEXTTRACK = 11
APPCOMMAND_MEDIA_PREVIOUSTRACK = 12

WM_APPCOMMAND = 0x0319


def find_spotify_window():
    """Find Spotify's main window handle"""
    EnumWindows = user32.EnumWindows
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    GetWindowTextW = user32.GetWindowTextW
    GetWindowTextLengthW = user32.GetWindowTextLengthW
    GetClassNameW = user32.GetClassNameW
    GetWindowThreadProcessId = user32.GetWindowThreadProcessId

    spotify_hwnd = None

    def callback(hwnd, lParam):
        nonlocal spotify_hwnd

        # Get window class
        class_buff = ctypes.create_unicode_buffer(256)
        GetClassNameW(hwnd, class_buff, 256)
        # class_name = class_buff.value

        # Get window title
        length = GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value
        else:
            title = ""

        # Get process ID
        pid = ctypes.c_ulong()
        GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        # Check if it's Spotify
        try:
            import psutil

            proc = psutil.Process(pid.value)
            if "spotify" in proc.name().lower():
                # Prefer the main window (has title with track info)
                if title and title not in [
                    "",
                    "Spotify",
                    "Spotify Free",
                    "Spotify Premium",
                ]:
                    spotify_hwnd = hwnd
                    print(
                        f"  Found Spotify window: hwnd={hwnd}, title='{title[:50]}...'"
                    )
                    return False  # Stop
                elif not spotify_hwnd and title:
                    spotify_hwnd = hwnd
        except Exception:
            pass

        return True

    EnumWindows(EnumWindowsProc(callback), 0)
    return spotify_hwnd


def send_app_command(hwnd, command):
    """Send WM_APPCOMMAND to a window"""
    lParam = command << 16
    result = user32.SendMessageW(hwnd, WM_APPCOMMAND, hwnd, lParam)
    return result


hwnd = find_spotify_window()
if hwnd:
    print(f"\n  Spotify window found: {hwnd}")
    print("  Try sending play/pause command...")
    # Uncomment to test:
    # result = send_app_command(hwnd, APPCOMMAND_MEDIA_PLAY_PAUSE)
    # print(f"  Result: {result}")
else:
    print("  Spotify window NOT found")

# ============================================================================
# METHOD 2: Spicetify WebSocket/HTTP (if extension installed)
# ============================================================================
print("\n[METHOD 2] Spicetify Local Server")
print("-" * 40)


def check_port(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    result = sock.connect_ex(("127.0.0.1", port))
    sock.close()
    return result == 0


# Common Spicetify extension ports
ports_to_check = [8974, 8975, 5000, 9000, 8080, 4381, 4370]

print("  Checking for local servers...")
for port in ports_to_check:
    if check_port(port):
        print(f"  ✓ Port {port} is OPEN - might be Spicetify!")

# Check for WebNowPlaying specifically
try:
    import urllib.request

    req = urllib.request.Request("http://127.0.0.1:8974/", method="GET")
    req.add_header("User-Agent", "AutoStopMedia")
    response = urllib.request.urlopen(req, timeout=1)
    print(f"  WebNowPlaying response: {response.status}")
except Exception:
    print("  WebNowPlaying not found or not responding")

# ============================================================================
# METHOD 3: Focus + Keyboard (space bar)
# ============================================================================
print("\n[METHOD 3] Focus + Spacebar")
print("-" * 40)


def send_space_to_spotify():
    """Briefly focus Spotify, send space, return focus"""
    # Get current foreground window
    current_hwnd = user32.GetForegroundWindow()

    # Find and focus Spotify
    spotify_hwnd = find_spotify_window()
    if not spotify_hwnd:
        print("  Spotify window not found")
        return False

    # Focus Spotify
    user32.SetForegroundWindow(spotify_hwnd)
    time.sleep(0.05)

    # Send space
    VK_SPACE = 0x20
    user32.keybd_event(VK_SPACE, 0, 0, 0)  # Key down
    user32.keybd_event(VK_SPACE, 0, 0x0002, 0)  # Key up

    time.sleep(0.05)

    # Restore focus
    if current_hwnd:
        user32.SetForegroundWindow(current_hwnd)

    print("  Sent space to Spotify!")
    return True


print("  This method briefly steals focus - not ideal but works")
# Uncomment to test:
# send_space_to_spotify()

# ============================================================================
# METHOD 4: COM Automation (if Spotify exposes it)
# ============================================================================
print("\n[METHOD 4] Check for Spotify COM/Automation")
print("-" * 40)

try:
    import win32com.client

    # Try to connect to Spotify automation
    # Most apps don't expose this
    try:
        spotify = win32com.client.Dispatch("Spotify.Application")
        print("  Spotify COM object found!")
    except Exception:
        print("  No Spotify COM automation available")
except ImportError:
    print("  pywin32 not installed (pip install pywin32)")

# ============================================================================
# Summary
# ============================================================================
print("\n" + "=" * 60)
print("RECOMMENDATIONS:")
print("=" * 60)
print("""
1. WM_APPCOMMAND - May work if Spotify handles these messages
2. Spicetify extension - Best option if you install WebNowPlaying
3. Focus+Space - Works but briefly steals focus
4. Media Keys - Global, may hit wrong app

For Spicetify, consider installing:
  spicetify config extensions webnowplaying.js
  spicetify apply

This exposes a WebSocket we can control!
""")

input("\nPress Enter to test WM_APPCOMMAND play/pause...")
if hwnd:
    print("Sending PLAY/PAUSE command to Spotify...")
    result = send_app_command(hwnd, APPCOMMAND_MEDIA_PLAY_PAUSE)
    print(f"Result: {result} (0 = not handled, other = handled)")
else:
    print("No Spotify window found")

input("\nPress Enter to exit...")
