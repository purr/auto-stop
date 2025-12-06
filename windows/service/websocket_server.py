# Auto-Stop Media - WebSocket Server
# Handles communication between the browser extension and Windows media control

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set

try:
    import websockets
    from websockets.server import WebSocketServerProtocol, serve

    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False

from config import MSG, WEBSOCKET_HOST, WEBSOCKET_PORT

logger = logging.getLogger(__name__)


@dataclass
class ConnectedClient:
    """Represents a connected WebSocket client"""

    websocket: "WebSocketServerProtocol"
    client_id: str
    connected_at: float


class WebSocketServer:
    """WebSocket server for browser extension communication"""

    def __init__(self, media_manager):
        self._media_manager = media_manager
        self._clients: Set[WebSocketServerProtocol] = set()
        self._server = None
        self._running = False
        self._on_browser_media_event: Optional[Callable] = None
        # Flag to prevent auto-pause loop when browser controls desktop media
        self._control_in_progress = False
        self._control_cooldown_task: Optional[asyncio.Task] = None

    @property
    def is_available(self) -> bool:
        return WEBSOCKETS_AVAILABLE

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def set_browser_event_handler(self, handler: Callable):
        """Set handler for browser media events (play/pause notifications)"""
        self._on_browser_media_event = handler

    async def start(self):
        """Start the WebSocket server"""
        if not WEBSOCKETS_AVAILABLE:
            logger.error("websockets library not available")
            return False

        self._running = True

        try:
            self._server = await serve(
                self._handle_client,
                WEBSOCKET_HOST,
                WEBSOCKET_PORT,
                ping_interval=30,
                ping_timeout=10,
            )
            logger.info(
                f"WebSocket server started on ws://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}"
            )
            return True

        except OSError as e:
            if e.errno == 10048:  # Port already in use
                logger.error(
                    f"Port {WEBSOCKET_PORT} is already in use. Is another instance running?"
                )
            else:
                logger.error(f"Failed to start WebSocket server: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to start WebSocket server: {e}")
            return False

    async def stop(self):
        """Stop the WebSocket server"""
        self._running = False

        # Close all client connections
        if self._clients:
            await asyncio.gather(
                *[
                    client.close(1001, "Server shutting down")
                    for client in self._clients
                ],
                return_exceptions=True,
            )
            self._clients.clear()

        # Close the server
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        logger.info("WebSocket server stopped")

    async def _handle_client(self, websocket: WebSocketServerProtocol):
        """Handle a client connection"""
        client_id = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
        logger.info(f"Client connected: {client_id}")

        self._clients.add(websocket)

        try:
            # Send initial desktop state
            await self._send_desktop_state(websocket)

            # Handle incoming messages
            async for message in websocket:
                await self._handle_message(websocket, message)

        except websockets.exceptions.ConnectionClosed as e:
            logger.debug(f"Client {client_id} disconnected: {e.code} {e.reason}")
        except Exception as e:
            logger.error(f"Error handling client {client_id}: {e}")
        finally:
            self._clients.discard(websocket)
            logger.info(f"Client disconnected: {client_id}")

    async def _handle_message(
        self, websocket: WebSocketServerProtocol, raw_message: str
    ):
        """Handle an incoming message from a client"""
        try:
            message = json.loads(raw_message)
            msg_type = message.get("type")
            data = message.get("data", {})

            logger.debug(f"Received message: {msg_type}")

            if msg_type == MSG.PING:
                await self._send(websocket, {"type": MSG.PONG})

            elif msg_type == MSG.GET_DESKTOP_STATE:
                await self._send_desktop_state(websocket)

            elif msg_type == MSG.CONTROL:
                # Control desktop media
                logger.info(f"Received CONTROL message: {data}")
                action = data.get("action")
                media_id = data.get("mediaId")
                logger.info(f"CONTROL: action={action}, media_id={media_id}")

                if media_id and media_id.startswith("desktop-"):
                    # Set control flag to prevent auto-pause loop
                    self._control_in_progress = True
                    logger.info(
                        f"CONTROL: calling handle_control({action}, {media_id})"
                    )

                    success = await self._media_manager.handle_control(action, media_id)
                    logger.info(
                        f"Control {action} on {media_id}: {'success' if success else 'failed'}"
                    )

                    # Send updated state after control
                    if success:
                        await asyncio.sleep(0.2)  # Brief delay for state to update
                        await self.broadcast_desktop_state()

                    # Clear control flag after a cooldown
                    await self._start_control_cooldown()
                else:
                    logger.warning(
                        f"CONTROL: media_id doesn't start with 'desktop-': {media_id}"
                    )

            elif msg_type == MSG.REGISTER_BROWSER:
                # Register which browser the extension is in
                self._media_manager.register_browser(data)
                logger.info(f"Browser registered: {data.get('browser', 'unknown')}")

            elif msg_type == MSG.MEDIA_PLAY:
                # Browser media started playing - pause desktop media
                # BUT skip if browser just sent a control command (prevent loop)
                if self._control_in_progress:
                    logger.debug(
                        "Ignoring MEDIA_PLAY during control cooldown (preventing loop)"
                    )
                    return

                # Update browser media titles for filtering
                title = data.get("title", "")
                if title:
                    self._media_manager.update_browser_media(title, True)

                if self._on_browser_media_event:
                    await self._on_browser_media_event("play", data)
                # Pause all desktop media when browser starts playing
                await self._media_manager.pause_all_except()
                logger.info("Browser media started - paused desktop media")
                await self.broadcast_desktop_state()

            elif msg_type == MSG.MEDIA_PAUSE:
                # Browser media paused
                title = data.get("title", "")
                if title:
                    self._media_manager.update_browser_media(title, False)

                if self._on_browser_media_event:
                    await self._on_browser_media_event("pause", data)

            elif msg_type == MSG.MEDIA_ENDED:
                # Browser media ended
                title = data.get("title", "")
                if title:
                    self._media_manager.update_browser_media(title, False)

                if self._on_browser_media_event:
                    await self._on_browser_media_event("ended", data)

        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON received: {raw_message[:100]}")
        except Exception as e:
            logger.error(f"Error handling message: {e}")

    async def _start_control_cooldown(self):
        """Start a cooldown period after control command to prevent loops"""
        # Cancel existing cooldown if any
        if self._control_cooldown_task and not self._control_cooldown_task.done():
            self._control_cooldown_task.cancel()

        async def cooldown():
            await asyncio.sleep(1.0)  # 1 second cooldown
            self._control_in_progress = False
            logger.debug("Control cooldown ended")

        self._control_cooldown_task = asyncio.create_task(cooldown())

    async def _send(self, websocket: WebSocketServerProtocol, message: Dict[str, Any]):
        """Send a message to a specific client"""
        try:
            await websocket.send(json.dumps(message))
        except Exception as e:
            logger.debug(f"Failed to send to client: {e}")

    async def _send_desktop_state(self, websocket: WebSocketServerProtocol):
        """Send current desktop media state to a client"""
        state = self._media_manager.get_state()
        await self._send(websocket, {"type": MSG.DESKTOP_STATE_UPDATE, "data": state})

    async def broadcast_desktop_state(self):
        """Broadcast desktop media state to all connected clients"""
        if not self._clients:
            return

        state = self._media_manager.get_state()
        message = json.dumps({"type": MSG.DESKTOP_STATE_UPDATE, "data": state})

        # Send to all clients
        await asyncio.gather(
            *[client.send(message) for client in self._clients], return_exceptions=True
        )

    async def broadcast(self, message: Dict[str, Any]):
        """Broadcast a message to all connected clients"""
        if not self._clients:
            return

        raw_message = json.dumps(message)
        await asyncio.gather(
            *[client.send(raw_message) for client in self._clients],
            return_exceptions=True,
        )
