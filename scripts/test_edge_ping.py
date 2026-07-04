import asyncio
import json
from datetime import datetime, timezone

import websockets

WS_URL = "ws://localhost:8000/ws/edge"


async def fake_edge():
    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({
            "edge_id": "GOP-21",
            "lat": 38.0,
            "lon": 127.5,
            "ammo_pct": 15,
            "status": "alert",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }))
        await asyncio.sleep(1)  # 서버가 처리할 시간
    print("sent fake EdgeState for GOP-21. check: curl http://localhost:8000/api/state")


if __name__ == "__main__":
    asyncio.run(fake_edge())
