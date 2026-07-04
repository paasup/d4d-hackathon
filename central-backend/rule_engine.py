import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import datetime, timezone
from shared.schemas import EdgeState, AlertEvent

MANUAL_PATH = Path(__file__).resolve().parent.parent / "docs" / "국방_군수지원_교본.txt"
THRESHOLD = 20
CRITICAL_THRESHOLD = 10


class RuleEngine:
    def __init__(self):
        self.manual_text = MANUAL_PATH.read_text(encoding="utf-8")
        self.alerted_edges: set[str] = set()

    def check_and_trigger(self, state: EdgeState) -> AlertEvent | None:
        if state.ammo_pct <= THRESHOLD and state.edge_id not in self.alerted_edges:
            self.alerted_edges.add(state.edge_id)
            level = "critical" if state.ammo_pct <= CRITICAL_THRESHOLD else "warning"
            return AlertEvent(
                edge_id=state.edge_id,
                level=level,
                message=f"⚠️ [{state.edge_id}] 탄약 고갈 위기 ({state.ammo_pct}%)",
                recommended_action=self._match_manual(state.ammo_pct),
                triggered_at=datetime.now(timezone.utc),
            )
        if state.ammo_pct > THRESHOLD and state.edge_id in self.alerted_edges:
            self.alerted_edges.discard(state.edge_id)
        return None

    def _match_manual(self, ammo_pct: int) -> str:
        if ammo_pct <= CRITICAL_THRESHOLD:
            return "교본 제4조(우회로 운용)에 의거, 우회로를 통한 긴급 탄약 재보급을 실시할 것을 권고합니다."
        return "교본 제3조(탄약 고갈 위기 대응)에 의거, 즉시 재보급 부대를 편성하고 방어 태세로 전환할 것을 권고합니다."


rule_engine = RuleEngine()
