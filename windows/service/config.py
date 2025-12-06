# Auto-Stop Media - Windows Service Configuration

import os
from pathlib import Path

# Version - used for update checking
VERSION = "1.0.0"

# WebSocket server configuration
WEBSOCKET_HOST = "127.0.0.1"
WEBSOCKET_PORT = 42089

# Installation paths
APP_NAME = "AutoStopMedia"
INSTALL_DIR = Path(os.environ.get("APPDATA", "")) / APP_NAME

# Logging configuration
LOG_DIR = INSTALL_DIR / "logs"
LOG_FILE_PREFIX = "service"  # Will be service-YYYY-MM-DD.log
LOG_MAX_SIZE = 5 * 1024 * 1024  # 5 MB
LOG_RETENTION_DAYS = 7  # Keep logs for 7 days

# Watchdog configuration
WATCHDOG_CHECK_INTERVAL = 30  # seconds
MEDIA_POLL_INTERVAL = 0.5  # seconds - how often to check for media changes


# Message types (must match extension constants)
class MSG:
    # Media events
    MEDIA_REGISTERED = "MEDIA_REGISTERED"
    MEDIA_UNREGISTERED = "MEDIA_UNREGISTERED"
    MEDIA_PLAY = "MEDIA_PLAY"
    MEDIA_PAUSE = "MEDIA_PAUSE"
    MEDIA_ENDED = "MEDIA_ENDED"
    TIME_UPDATE = "TIME_UPDATE"

    # Control
    CONTROL = "CONTROL"

    # State sync
    GET_DESKTOP_STATE = "GET_DESKTOP_STATE"
    DESKTOP_STATE_UPDATE = "DESKTOP_STATE_UPDATE"

    # Connection
    PING = "PING"
    PONG = "PONG"
    REGISTER_BROWSER = "REGISTER_BROWSER"
    BROWSER_STATE_SYNC = "BROWSER_STATE_SYNC"


class ACTION:
    PLAY = "play"
    PAUSE = "pause"
    SKIP = "skip"
    PREV = "prev"
