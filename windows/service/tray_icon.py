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


# Extension icon colors (matching exactly)
class Colors:
    # Extension active icon colors (pause bars when playing)
    ACTIVE_STROKE = "#eb6f92"  # Pink stroke
    ACTIVE_GRADIENT_START = "#eb6f92"  # Pink
    ACTIVE_GRADIENT_END = "#c4a7e7"  # Purple

    # Extension idle icon colors (play triangle when not playing)
    IDLE_STROKE = "#6e6a86"  # Muted gray stroke
    IDLE_SYMBOL = "#6e6a86"  # Muted gray symbol

    # Background colors (matching extension)
    BG_DARK = "#191724"  # Dark background
    BG_LIGHT = "#26233a"  # Lighter background

    # Status colors
    RED = "#eb6f92"  # Not connected (red/pink)
    YELLOW = "#f6c177"  # Idle, no browser connected (yellow)

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
        self._has_any_media = False
        self._running = False
        self._thread: Optional[threading.Thread] = None

    @property
    def is_available(self) -> bool:
        return TRAY_AVAILABLE

    def _create_icon_image(
        self, connected: bool = False, has_media: bool = False
    ) -> "Image":
        """Create icon matching extension exactly - play/pause with proper colors"""
        size = 64
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)

        center_x, center_y = size // 2, size // 2
        radius = 58  # Matching extension icon size

        if has_media:
            # MEDIA PLAYING: Pause bars with active colors (matching icon-active.svg)
            # Background circle with pink stroke
            draw.ellipse(
                [center_x - radius, center_y - radius, center_x + radius, center_y + radius],
                fill=Colors.hex_to_rgb(Colors.BG_LIGHT),
                outline=Colors.hex_to_rgb(Colors.ACTIVE_STROKE),
                width=6,
            )

            # Draw pause bars (two vertical rectangles with rounded corners)
            bar_width = 14
            bar_height = 52
            bar_spacing = 4
            x1 = center_x - bar_spacing // 2 - bar_width
            x2 = center_x + bar_spacing // 2
            y = center_y - bar_height // 2

            # Create gradient effect (simplified - using solid color for now)
            # Left bar (with rounded corners manually)
            draw.rectangle(
                [x1, y + 4, x1 + bar_width, y + bar_height - 4],
                fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START),
            )
            # Rounded top
            draw.ellipse([x1, y, x1 + 8, y + 8], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            draw.ellipse([x1 + 6, y, x1 + bar_width, y + 8], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            # Rounded bottom
            draw.ellipse([x1, y + bar_height - 8, x1 + 8, y + bar_height], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            draw.ellipse([x1 + 6, y + bar_height - 8, x1 + bar_width, y + bar_height], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))

            # Right bar (with rounded corners manually)
            draw.rectangle(
                [x2, y + 4, x2 + bar_width, y + bar_height - 4],
                fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START),
            )
            # Rounded top
            draw.ellipse([x2, y, x2 + 8, y + 8], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            draw.ellipse([x2 + 6, y, x2 + bar_width, y + 8], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            # Rounded bottom
            draw.ellipse([x2, y + bar_height - 8, x2 + 8, y + bar_height], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))
            draw.ellipse([x2 + 6, y + bar_height - 8, x2 + bar_width, y + bar_height], fill=Colors.hex_to_rgb(Colors.ACTIVE_GRADIENT_START))

        elif connected:
            # CONNECTED, NO MEDIA: Play triangle, dimmed (matching icon-idle.svg)
            # Background circle with muted gray stroke
            draw.ellipse(
                [center_x - radius, center_y - radius, center_x + radius, center_y + radius],
                fill=Colors.hex_to_rgb(Colors.BG_DARK),
                outline=Colors.hex_to_rgb(Colors.IDLE_STROKE),
                width=4,
            )

            # Draw play triangle (pointing right)
            triangle_size = 56  # Matching extension size
            x1 = center_x - triangle_size // 3
            y1 = center_y - triangle_size // 2
            x2 = center_x - triangle_size // 3
            y2 = center_y + triangle_size // 2
            x3 = center_x + triangle_size * 2 // 3
            y3 = center_y
            draw.polygon(
                [(x1, y1), (x2, y2), (x3, y3)],
                fill=Colors.hex_to_rgb(Colors.IDLE_SYMBOL),
            )

        else:
            # NOT CONNECTED, IDLE: Play triangle, yellow
            # Background circle with yellow stroke
            draw.ellipse(
                [center_x - radius, center_y - radius, center_x + radius, center_y + radius],
                fill=Colors.hex_to_rgb(Colors.BG_DARK),
                outline=Colors.hex_to_rgb(Colors.YELLOW),
                width=4,
            )

            # Draw play triangle (pointing right) in yellow
            triangle_size = 56
            x1 = center_x - triangle_size // 3
            y1 = center_y - triangle_size // 2
            x2 = center_x - triangle_size // 3
            y2 = center_y + triangle_size // 2
            x3 = center_x + triangle_size * 2 // 3
            y3 = center_y
            draw.polygon(
                [(x1, y1), (x2, y2), (x3, y3)],
                fill=Colors.hex_to_rgb(Colors.YELLOW),
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

    def update_status(
        self, connected_clients: int = 0, active_media: dict = None, has_any_media: bool = False
    ):
        """Update the tray icon status"""
        self._connected_clients = connected_clients
        self._active_media = active_media
        self._has_any_media = has_any_media

        if self._icon:
            try:
                # Update icon image
                connected = connected_clients > 0
                self._icon.icon = self._create_icon_image(connected, has_any_media)

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
