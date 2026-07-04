from store import store
from rule_engine import rule_engine


class ChatEngine:
    def answer(self, query: str) -> str:
        q = query.strip()

        if any(k in q for k in ["가장 위험", "위험한 에지", "최우선"]):
            return self._most_critical_edge()
        if any(k in q for k in ["보급 현황", "보급 상태", "몇 개"]):
            return self._resupply_status()
        if any(k in q for k in ["교본", "매뉴얼", "조치", "대응책"]):
            return self._manual_guidance()
        if any(k in q for k in ["전체 현황", "전반적", "요약"]):
            return self._overall_summary()

        return "질문을 이해하지 못했습니다. '가장 위험한 에지는?', '보급 현황은?' 형태로 질문해주세요."

    def _most_critical_edge(self) -> str:
        states = store.get_all_states()
        if not states:
            return "현재 수신된 에지 데이터가 없습니다."
        worst = min(states, key=lambda s: s.ammo_pct)
        action = rule_engine._match_manual(worst.ammo_pct)
        return f"현재 탄약이 {worst.ammo_pct}% 남은 [{worst.edge_id}]이 가장 위험합니다. {action}"

    def _resupply_status(self) -> str:
        states = store.get_all_states()
        resupplying = [s for s in states if s.status == "resupplying"]
        alert = [s for s in states if s.ammo_pct <= 20]
        return (f"현재 {len(states)}개 에지 중 {len(alert)}개가 위기 상태, "
                f"{len(resupplying)}개가 보급 진행 중입니다.")

    def _manual_guidance(self) -> str:
        states = store.get_all_states()
        critical = [s for s in states if s.ammo_pct <= 20]
        if not critical:
            return "현재 긴급 대응이 필요한 에지는 없습니다."
        lines = [f"[{s.edge_id}] {rule_engine._match_manual(s.ammo_pct)}" for s in critical]
        return "\n".join(lines)

    def _overall_summary(self) -> str:
        states = store.get_all_states()
        avg = sum(s.ammo_pct for s in states) / len(states) if states else 0
        return f"전체 {len(states)}개 에지 평균 탄약 {avg:.0f}%. 알림 {len(store.get_alerts())}건 발생."


chat_engine = ChatEngine()
