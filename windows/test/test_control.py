"""Test sending a CONTROL message to the service"""

import asyncio
import json

import websockets


async def test_control():
    uri = "ws://127.0.0.1:42089"
    try:
        async with websockets.connect(uri) as websocket:
            print("Connected!")

            # Send CONTROL message
            message = {
                "type": "CONTROL",
                "data": {"action": "play", "mediaId": "desktop-spotify-fallback"},
            }

            print(f"Sending: {json.dumps(message, indent=2)}")
            await websocket.send(json.dumps(message))

            # Wait for response
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                print(f"Response: {response}")
            except asyncio.TimeoutError:
                print("No response (timeout)")

    except Exception as e:
        print(f"Error: {e}")


asyncio.run(test_control())
