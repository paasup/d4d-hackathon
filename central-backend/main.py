import asyncio
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shared.schemas import EdgeState, Command, AlertEvent
from store import store
from rule_engine import rule_engine
from chat_engine import chat_engine

app = FastAPI()


class ChatRequest(BaseModel):
    query: str


class ChatResponse(BaseModel):
    answer: str


class DebugSetAmmo(BaseModel):
    edge_id: str
    ammo_pct: int


class ConnectionManager:
    def __init__(self):
        self.edge_connections: dict[str, WebSocket] = {}   # 명령 하달용 (/ws/command)
        self.dashboard_clients: set[WebSocket] = set()      # 상태/알림 push용 (/ws/dashboard)

    async def send_command(self, cmd: Command):
        ws = self.edge_connections.get(cmd.edge_id)
        if ws:
            await ws.send_json(cmd.model_dump(mode="json"))

    async def broadcast(self, kind: str, data):
        dead = []
        for ws in self.dashboard_clients:
            try:
                await ws.send_json({"kind": kind, "data": data})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.dashboard_clients.discard(ws)


manager = ConnectionManager()

RECON_RESULTS = [
    {"safe": True, "text": "보급로 안전 확인"},
    {"safe": False, "text": "적 활동 포착, 우회로 권장"},
]

# 재시작 직후에도 탄약 알림 데모를 바로 보여주기 위해 일부 에지는 경보 수치로 되돌린다.
# critical(<=10)과 warning(<=20)이 섞이도록 값을 구성.
RESET_LOW_AMMO_VALUES = [18, 15, 8, 4]


async def _run_recon_drone(edge_id: str):
    await asyncio.sleep(6)
    result = random.choice(RECON_RESULTS)
    level = "warning" if result["safe"] else "critical"
    alert = AlertEvent(
        edge_id=edge_id,
        level=level,
        message=f"🔭 [{edge_id}] 정찰 결과: {result['text']}",
        recommended_action="현 보급로로 RESUPPLY 진행 가능" if result["safe"] else "교본 제4조(우회로 운용)에 의거 우회로 확보 후 RESUPPLY 진행 권고",
        triggered_at=datetime.now(timezone.utc),
    )
    store.add_alert(alert)
    await manager.broadcast("alert", alert.model_dump(mode="json"))


# 우회로 정찰은 데모 단순화를 위해 항상 안전 확인으로 종료
async def _run_detour_recon(edge_id: str):
    await asyncio.sleep(6)
    alert = AlertEvent(
        edge_id=edge_id,
        level="warning",
        message=f"🔭 [{edge_id}] 우회로 정찰 결과: 우회로 확보, 보급로 안전 확인",
        recommended_action="확보된 우회로로 RESUPPLY 진행 가능",
        triggered_at=datetime.now(timezone.utc),
    )
    store.add_alert(alert)
    await manager.broadcast("alert", alert.model_dump(mode="json"))


# --- 에지 → 중앙: 상태 수신 ---
@app.websocket("/ws/edge")
async def ws_edge(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            state = EdgeState(**data)
            store.upsert_edge_state(state)
            await manager.broadcast("state", [s.model_dump(mode="json") for s in store.get_all_states()])

            alert = rule_engine.check_and_trigger(state)
            if alert:
                store.add_alert(alert)
                await manager.broadcast("alert", alert.model_dump(mode="json"))
    except WebSocketDisconnect:
        pass


# --- 중앙 → 에지: 명령 하달 push (에지가 자신의 edge_id로 연결해 대기) ---
@app.websocket("/ws/command")
async def ws_command(websocket: WebSocket, edge_id: str):
    await websocket.accept()
    manager.edge_connections[edge_id] = websocket
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        # 이 커넥션이 여전히 등록된 최신 커넥션일 때만 제거 (오래된 커넥션이 나중에 끊기며
        # 새로 등록된 커넥션을 잘못 지우는 경합을 방지)
        if manager.edge_connections.get(edge_id) is websocket:
            manager.edge_connections.pop(edge_id, None)


# --- 중앙 → 대시보드: 상태/알림 push (여러 브라우저 클라이언트 동시 접속) ---
@app.websocket("/ws/dashboard")
async def ws_dashboard(websocket: WebSocket):
    await websocket.accept()
    manager.dashboard_clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.dashboard_clients.discard(websocket)


# --- 대시보드 조회용 REST ---
@app.get("/api/state")
async def get_state():
    return [s.model_dump(mode="json") for s in store.get_all_states()]


@app.get("/api/alerts")
async def get_alerts():
    return [a.model_dump(mode="json") for a in store.get_alerts()]


# --- 대시보드 → 중앙: 명령 하달 버튼 ---
@app.post("/api/command")
async def post_command(cmd: Command):
    store.pending_commands.append(cmd)
    if cmd.command == "RECON_DRONE":
        asyncio.create_task(_run_recon_drone(cmd.edge_id))
    elif cmd.command == "DETOUR_RECON":
        asyncio.create_task(_run_detour_recon(cmd.edge_id))
    else:
        await manager.send_command(cmd)
    return {"ok": True}


# --- 대시보드 → 중앙: 시뮬레이터 재시작 (모든 에지를 초기 상태로 되돌림) ---
@app.post("/api/simulator/restart")
async def restart_simulator():
    target_ids = sorted(store.edge_states.keys())[:len(RESET_LOW_AMMO_VALUES)]
    low_ammo = dict(zip(target_ids, RESET_LOW_AMMO_VALUES))

    store.reset_all(low_ammo)
    rule_engine.alerted_edges.clear()

    now = datetime.now(timezone.utc)
    for edge_id in list(manager.edge_connections.keys()):
        command = "RESET_LOW" if edge_id in low_ammo else "RESET"
        await manager.send_command(Command(edge_id=edge_id, command=command, issued_at=now))

    await manager.broadcast("state", [s.model_dump(mode="json") for s in store.get_all_states()])
    for edge_id in target_ids:
        state = store.edge_states.get(edge_id)
        alert = rule_engine.check_and_trigger(state) if state else None
        if alert:
            store.add_alert(alert)
            await manager.broadcast("alert", alert.model_dump(mode="json"))
    return {"ok": True}


# --- 챗봇 UI → AI 엔진 ---
@app.post("/api/chat")
async def chat(req: ChatRequest) -> ChatResponse:
    answer = await chat_engine.answer(req.query)
    return ChatResponse(answer=answer)


# --- 데모 리허설용 백도어: 특정 에지를 강제로 위기 상태로 주입 ---
@app.post("/api/debug/set_ammo")
async def debug_set_ammo(req: DebugSetAmmo):
    state = store.edge_states.get(req.edge_id)
    if state:
        state.ammo_pct = req.ammo_pct
        await manager.broadcast("state", [s.model_dump(mode="json") for s in store.get_all_states()])
        rule_engine.alerted_edges.discard(req.edge_id)  # 반복 시연을 위해 매번 새로 알림 발생시킴
        alert = rule_engine.check_and_trigger(state)
        if alert:
            store.add_alert(alert)
            await manager.broadcast("alert", alert.model_dump(mode="json"))
    return {"ok": True}


# --- 헬스체크 ---
@app.get("/health")
async def health():
    return {"status": "ok", "edges_connected": len(manager.edge_connections)}


# --- 대시보드 정적 파일 서빙 (API/WS 라우트 정의 이후, 맨 끝에 마운트) ---
app.mount(
    "/",
    StaticFiles(directory=Path(__file__).resolve().parent.parent / "dashboard-web", html=True),
    name="dashboard",
)
