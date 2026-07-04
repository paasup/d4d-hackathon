import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.schemas import EdgeState, AlertEvent, Command


class InMemoryStore:
    def __init__(self):
        self.edge_states: dict[str, EdgeState] = {}
        self.alerts: list[AlertEvent] = []
        self.pending_commands: list[Command] = []

    def upsert_edge_state(self, state: EdgeState):
        self.edge_states[state.edge_id] = state

    def get_all_states(self) -> list[EdgeState]:
        return list(self.edge_states.values())

    def add_alert(self, alert: AlertEvent):
        self.alerts.append(alert)

    def get_alerts(self) -> list[AlertEvent]:
        return self.alerts

    def reset_all(self, low_ammo: dict[str, int] | None = None):
        # 위치(lat/lon)는 에지 시뮬레이터가 고정 시드로 배정한 값이라 그대로 두고,
        # 시연 중 누적된 상태만 초기값으로 되돌린다. low_ammo로 지정된 일부 에지는
        # 재시작 직후에도 탄약 알림 데모를 바로 보여줄 수 있도록 경보 수치로 되돌린다.
        low_ammo = low_ammo or {}
        now = datetime.now(timezone.utc)
        for edge_id, state in self.edge_states.items():
            if edge_id in low_ammo:
                state.ammo_pct = low_ammo[edge_id]
                state.status = "alert"
            else:
                state.ammo_pct = 100
                state.status = "idle"
            state.posture = "active"
            state.alert_level = "normal"
            state.timestamp = now
        self.alerts.clear()
        self.pending_commands.clear()


store = InMemoryStore()
