# Auto-Stop Media - Windows Service Main Entry Point
# Runs as a background service with logging, watchdog, and tray icon

import asyncio
import logging
import logging.handlers
import os
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

from config import (
    LOG_BACKUP_COUNT,
    LOG_DIR,
    LOG_FILE,
    LOG_MAX_SIZE,
    VERSION,
    WATCHDOG_CHECK_INTERVAL,
    WEBSOCKET_PORT,
)
from media_manager import WindowsMediaManager
from tray_icon import TRAY_AVAILABLE, get_tray_icon
from websocket_server import WebSocketServer

# Add service directory to path for imports
SERVICE_DIR = Path(__file__).parent
sys.path.insert(0, str(SERVICE_DIR))


_logging_configured = False


def setup_logging():
    """Configure logging with rotation"""
    global _logging_configured

    # Only configure once to avoid duplicate handlers
    if _logging_configured:
        return logging.getLogger(__name__)

    # Ensure log directory exists
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Create formatter
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )

    # File handler with rotation
    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE, maxBytes=LOG_MAX_SIZE, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.DEBUG)

    # Console handler (for debugging when running manually)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    console_handler.setLevel(logging.INFO)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    # Reduce noise from websockets library
    logging.getLogger("websockets").setLevel(logging.WARNING)

    _logging_configured = True
    return logging.getLogger(__name__)


class AutoStopService:
    """Main service class that coordinates all components"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.media_manager = WindowsMediaManager()
        self.websocket_server = WebSocketServer(self.media_manager)
        self._running = False
        self._shutdown_event = asyncio.Event()
        self._last_heartbeat = time.time()
        self._tray_icon = None

    async def start(self):
        """Start all service components"""
        self.logger.info(f"Starting Auto-Stop Media Service v{VERSION}")
        self.logger.info(f"WebSocket port: {WEBSOCKET_PORT}")

        self._running = True

        # Start tray icon
        if TRAY_AVAILABLE:
            self._tray_icon = get_tray_icon(on_quit=self._request_shutdown)
            self._tray_icon.start()
            self.logger.info("Tray icon started")
        else:
            self.logger.info("Tray icon not available (pystray/Pillow not installed)")

        # Start media manager
        if not self.media_manager.is_available:
            self.logger.error(
                "Windows Media API not available. Please install winrt packages."
            )
            return False

        async def on_media_state_change(state):
            """Called when desktop media state changes"""
            await self.websocket_server.broadcast_desktop_state()
            # Update tray icon
            self._update_tray_icon()

        if not await self.media_manager.start(on_state_change=on_media_state_change):
            self.logger.error("Failed to start media manager")
            return False

        # Start WebSocket server
        if not self.websocket_server.is_available:
            self.logger.error(
                "WebSocket library not available. Please install websockets."
            )
            return False

        if not await self.websocket_server.start():
            self.logger.error("Failed to start WebSocket server")
            await self.media_manager.stop()
            return False

        self.logger.info("Service started successfully")
        self._update_tray_icon()
        return True

    async def stop(self):
        """Stop all service components"""
        self.logger.info("Stopping service...")
        self._running = False
        self._shutdown_event.set()

        # Stop tray icon
        if self._tray_icon:
            self._tray_icon.stop()
            self._tray_icon = None

        await self.websocket_server.stop()
        await self.media_manager.stop()

        self.logger.info("Service stopped")

    def _request_shutdown(self):
        """Request shutdown from tray icon"""
        self.logger.info("Shutdown requested from tray icon")
        # Set the shutdown event from any thread
        if self._shutdown_event:
            # Use call_soon_threadsafe to set event from tray thread
            try:
                loop = asyncio.get_event_loop()
                loop.call_soon_threadsafe(self._shutdown_event.set)
            except Exception:
                self._shutdown_event.set()

    def _update_tray_icon(self):
        """Update tray icon with current status"""
        if not self._tray_icon:
            return

        try:
            client_count = self.websocket_server.client_count
            state = self.media_manager.get_state()
            active_media = state.get("activeMedia")

            self._tray_icon.update_status(
                connected_clients=client_count, active_media=active_media
            )
        except Exception as e:
            self.logger.debug(f"Failed to update tray icon: {e}")

    async def run(self):
        """Main run loop"""
        if not await self.start():
            return 1

        # Start watchdog task
        watchdog_task = asyncio.create_task(self._watchdog())

        # Wait for shutdown signal
        await self._shutdown_event.wait()

        # Cleanup
        watchdog_task.cancel()
        try:
            await watchdog_task
        except asyncio.CancelledError:
            pass

        await self.stop()
        return 0

    async def _watchdog(self):
        """Watchdog task to monitor service health"""
        while self._running:
            try:
                await asyncio.sleep(WATCHDOG_CHECK_INTERVAL)

                # Log heartbeat
                self._last_heartbeat = time.time()
                client_count = self.websocket_server.client_count
                state = self.media_manager.get_state()
                active_count = 1 if state.get("activeMedia") else 0
                paused_count = len(state.get("pausedList", []))

                self.logger.debug(
                    f"Heartbeat: {client_count} clients, "
                    f"{active_count} active, {paused_count} paused desktop media"
                )

                # Update tray icon
                self._update_tray_icon()

            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Watchdog error: {e}")

    def handle_signal(self, signum, frame):
        """Handle shutdown signals"""
        self.logger.info(f"Received signal {signum}, initiating shutdown...")
        self._shutdown_event.set()


async def main():
    """Main entry point"""
    logger = setup_logging()

    logger.info("=" * 50)
    logger.info(f"Auto-Stop Media Service v{VERSION}")
    logger.info(f"Started at: {datetime.now().isoformat()}")
    logger.info(f"PID: {os.getpid()}")
    logger.info("=" * 50)

    service = AutoStopService()

    # Register signal handlers (Windows compatible)
    if sys.platform == "win32":
        # On Windows, we can only handle SIGINT (Ctrl+C) and SIGTERM
        signal.signal(signal.SIGINT, service.handle_signal)
        signal.signal(signal.SIGTERM, service.handle_signal)
    else:
        signal.signal(signal.SIGINT, service.handle_signal)
        signal.signal(signal.SIGTERM, service.handle_signal)
        signal.signal(signal.SIGHUP, service.handle_signal)

    try:
        exit_code = await service.run()
    except Exception as e:
        logger.exception(f"Unhandled exception: {e}")
        exit_code = 1
    finally:
        logger.info("Service exiting")

    return exit_code


def run_with_restart():
    """Run the service with automatic restart on crash (watchdog behavior)"""
    logger = setup_logging()
    max_restarts = 5
    restart_window = 300  # 5 minutes
    restart_times = []

    while True:
        try:
            # Clean up old restart times
            now = time.time()
            restart_times = [t for t in restart_times if now - t < restart_window]

            if len(restart_times) >= max_restarts:
                logger.error(
                    f"Too many restarts ({max_restarts}) in {restart_window}s. Exiting."
                )
                return 1

            restart_times.append(now)

            # Run the async main
            if sys.platform == "win32":
                # Windows needs special event loop policy
                asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

            exit_code = asyncio.run(main())

            if exit_code == 0:
                # Clean exit
                return 0

            logger.warning(
                f"Service exited with code {exit_code}. Restarting in 5 seconds..."
            )
            time.sleep(5)

        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received. Exiting.")
            return 0
        except Exception as e:
            logger.exception(f"Service crashed: {e}")
            logger.warning("Restarting in 5 seconds...")
            time.sleep(5)


if __name__ == "__main__":
    # Check if running with --no-restart flag (for debugging)
    if "--no-restart" in sys.argv:
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        sys.exit(asyncio.run(main()))
    else:
        sys.exit(run_with_restart())
