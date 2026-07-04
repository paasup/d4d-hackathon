import sys
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


store = InMemoryStore()
