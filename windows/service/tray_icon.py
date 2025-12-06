# Auto-Stop Media - System Tray Icon
# Shows connection status with Rosé Pine colors

import logging
import threading
from typing import Callable, Optional

try:
    import pystray
    from PIL import Image, ImageDraw

    TRAY_AVAILABLE = True
except ImportError:
    TRAY_AVAILABLE = False

logger = logging.getLogger(__name__)


# Rosé Pine colors
class Colors:
    # Status colors
    FOAM = "#9ccfd8"  # Connected/active (cyan-ish)
    LOVE = "#eb6f92"  # Disconnected/error (pink-red)
    GOLD = "#f6c177"  # Warning/idle (gold)
    PINE = "#31748f"  # Accent (teal)

    # Background
    BASE = "#191724"  # Dark background
    SURFACE = "#1f1d2e"  # Slightly lighter

    @staticmethod
    def hex_to_rgb(hex_color: str) -> tuple:
        """Convert hex color to RGB tuple"""
        hex_color = hex_color.lstrip("#")
        return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


class TrayIcon:
    """System tray icon for Auto-Stop Media service"""

    def __init__(self, on_quit: Optional[Callable] = None):
        self._icon: Optional[pystray.Icon] = None
        self._on_quit = on_quit
        self._connected_clients = 0
        self._active_media = None
        self._running = False
        self._thread: Optional[threading.Thread] = None

    @property
    def is_available(self) -> bool:
        return TRAY_AVAILABLE

    def _create_icon_image(
        self, connected: bool = False, has_media: bool = False
    ) -> "Image":
        """Create a simple circular icon with status color"""
        size = 64
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)

        # Determine color based on status
        if has_media:
            # Active media playing - use foam (cyan)
            color = Colors.hex_to_rgb(Colors.FOAM)
        elif connected:
            # Connected but no media - use pine (teal)
            color = Colors.hex_to_rgb(Colors.PINE)
        else:
            # No connections - use muted gold
            color = Colors.hex_to_rgb(Colors.GOLD)

        # Draw outer circle (background)
        padding = 4
        draw.ellipse(
            [padding, padding, size - padding, size - padding],
            fill=Colors.hex_to_rgb(Colors.BASE),
            outline=color,
            width=3,
        )

        # Draw inner circle (status indicator)
        inner_padding = 16
        draw.ellipse(
            [inner_padding, inner_padding, size - inner_padding, size - inner_padding],
            fill=color,
        )

        return image

    def _get_tooltip(self) -> str:
        """Generate tooltip text"""
        lines = ["Auto-Stop Media"]

        if self._connected_clients > 0:
            lines.append(f"✓ {self._connected_clients} browser(s) connected")
        else:
            lines.append("○ No browsers connected")

        if self._active_media:
            title = self._active_media.get("title", "Unknown")
            if len(title) > 40:
                title = title[:37] + "..."
            lines.append(f"♪ {title}")

        return "\n".join(lines)

    def _create_menu(self) -> pystray.Menu:
        """Create the right-click menu"""
        return pystray.Menu(
            pystray.MenuItem("Auto-Stop Media", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                lambda item: f"Clients: {self._connected_clients}", None, enabled=False
            ),
            pystray.MenuItem(
                lambda item: f"Media: {'Playing' if self._active_media else 'None'}",
                None,
                enabled=False,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._on_quit_clicked),
        )

    def _on_quit_clicked(self, icon, item):
        """Handle quit menu item click"""
        logger.info("Quit requested from tray icon")
        if self._on_quit:
            self._on_quit()
        self.stop()

    def start(self):
        """Start the tray icon in a separate thread"""
        if not TRAY_AVAILABLE:
            logger.warning("Tray icon not available (pystray/Pillow not installed)")
            return False

        if self._running:
            return True

        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        logger.info("Tray icon started")
        return True

    def _run(self):
        """Run the tray icon (blocking, runs in thread)"""
        try:
            self._icon = pystray.Icon(
                name="AutoStopMedia",
                icon=self._create_icon_image(False, False),
                title=self._get_tooltip(),
                menu=self._create_menu(),
            )
            self._icon.run()
        except Exception as e:
            logger.error(f"Tray icon error: {e}")
        finally:
            self._running = False

    def stop(self):
        """Stop the tray icon"""
        self._running = False
        if self._icon:
            try:
                self._icon.stop()
            except Exception:
                pass
            self._icon = None
        logger.info("Tray icon stopped")

    def update_status(self, connected_clients: int = 0, active_media: dict = None):
        """Update the tray icon status"""
        self._connected_clients = connected_clients
        self._active_media = active_media

        if self._icon:
            try:
                # Update icon image
                has_media = active_media is not None
                connected = connected_clients > 0
                self._icon.icon = self._create_icon_image(connected, has_media)

                # Update tooltip
                self._icon.title = self._get_tooltip()
            except Exception as e:
                logger.debug(f"Failed to update tray icon: {e}")


# Singleton instance
_tray_icon: Optional[TrayIcon] = None


def get_tray_icon(on_quit: Optional[Callable] = None) -> TrayIcon:
    """Get or create the tray icon singleton"""
    global _tray_icon
    if _tray_icon is None:
        _tray_icon = TrayIcon(on_quit=on_quit)
    return _tray_icon
