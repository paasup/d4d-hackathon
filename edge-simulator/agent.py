import asyncio
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.schemas import EdgeState
import config


class EdgeAgent:
    def __init__(self, edge_id: str, lat: float, lon: float, ws_url: str = config.WS_EDGE_URL):
        self.edge_id = edge_id
        self.lat = lat
        self.lon = lon
        self.ammo_pct = random.randint(*config.AMMO_INIT_RANGE)
        self.status = "idle"
        self.ws_url = ws_url

    async def run(self):
        # 상태 송신과 명령 수신은 별도 커넥션이므로 독립적으로 재연결되도록 따로 돌린다.
        await asyncio.gather(self._run_state_loop(), self._run_command_loop())

    async def _run_state_loop(self):
        while True:
            try:
                async with websockets.connect(self.ws_url) as ws:
                    while True:
                        await self._send_state(ws)
                        self._simulate_ammo_drain()
                        await asyncio.sleep(random.uniform(*config.SEND_INTERVAL_RANGE))
            except (websockets.ConnectionClosed, OSError) as e:
                print(f"[{self.edge_id}] state connection lost ({e}), retrying in 3s...")
                await asyncio.sleep(3)

    async def _run_command_loop(self):
        url = f"{config.WS_COMMAND_URL}?edge_id={self.edge_id}"
        while True:
            try:
                async with websockets.connect(url) as ws:
                    await self._listen_commands(ws)
            except (websockets.ConnectionClosed, OSError) as e:
                print(f"[{self.edge_id}] command connection lost ({e}), retrying in 3s...")
                await asyncio.sleep(3)

    async def _send_state(self, ws):
        state = EdgeState(
            edge_id=self.edge_id,
            lat=self.lat,
            lon=self.lon,
            ammo_pct=self.ammo_pct,
            status=self.status,
            timestamp=datetime.now(timezone.utc),
        )
        await ws.send(state.model_dump_json())
        print(f"[{self.edge_id}] ammo={self.ammo_pct}% status={self.status}")

    def _simulate_ammo_drain(self):
        if self.status == "idle" and self.ammo_pct > 0:
            self.ammo_pct = max(0, self.ammo_pct - random.randint(*config.AMMO_DRAIN_RANGE))
            if self.ammo_pct <= config.AMMO_ALERT_THRESHOLD:
                self.status = "alert"

    async def _listen_commands(self, ws):
        async for msg in ws:
            cmd = json.loads(msg)
            if cmd.get("edge_id") == self.edge_id and cmd.get("command") == "RESUPPLY":
                await self._handle_resupply()

    async def _handle_resupply(self):
        print(f"[{self.edge_id}] RESUPPLY 명령 수신, 보급 시작...")
        self.status = "resupplying"
        await asyncio.sleep(10)
        self.ammo_pct = 100
        self.status = "resupplied"
        print(f"[{self.edge_id}] 보급 완료")
