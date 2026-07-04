import asyncio
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

from store import store
from rule_engine import rule_engine

load_dotenv(Path(__file__).resolve().parent.parent / ".local.env")

logger = logging.getLogger("chat_engine")

# OpenCode Go 구독(opencode.ai) — OpenAI 호환 게이트웨이, MiniMax M3 모델
# 주의: OpenCode "Zen"(종량제, /zen/v1)과 "Go"(구독제, /zen/go/v1)는 별도 상품/베이스 URL이다.
OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1"
OPENCODE_GO_MODEL = "minimax-m3"
# MiniMax M3는 응답 전에 <think> 추론을 거쳐 5초를 자주 넘기므로 넉넉히 잡는다.
LLM_TIMEOUT_SEC = 20

EDGE_ID_PATTERN = re.compile(r"[A-Z]+-\d+")
RECENT_ALERT_COUNT = 5

SYSTEM_PROMPT_TEMPLATE = """당신은 국방 군수지원 상황실의 챗봇 보좌관입니다.
아래 교본과 현재 에지(전방 기지) 상태만을 근거로, 장교의 질문에 한국어로 간결하고 정확하게 답하세요.
근거가 없는 내용은 추측하지 말고 모른다고 답하세요.

[교본]
{manual}

[현재 에지 상태 — 탄약 잔량 오름차순]
{states}

[최근 알림 (최신순 최대 {alert_count}건)]
{alerts}
"""


class ChatEngine:
    def __init__(self):
        api_key = os.environ.get("API_KEY")
        self._client = (
            AsyncOpenAI(api_key=api_key, base_url=OPENCODE_GO_BASE_URL)
            if api_key
            else None
        )

    async def answer(self, query: str) -> str:
        q = query.strip()
        if self._client is not None:
            try:
                return await self._llm_answer(q)
            except Exception:
                logger.warning("LLM 응답 실패, 규칙 기반으로 폴백", exc_info=True)
        return self._rule_based_answer(q)

    def _build_context(self, query: str) -> str:
        states = sorted(store.get_all_states(), key=lambda s: s.ammo_pct)

        mentioned = set(EDGE_ID_PATTERN.findall(query))
        filtered = [s for s in states if s.edge_id in mentioned] if mentioned else []
        if filtered:
            states = filtered

        state_lines = "\n".join(
            f"- [{s.edge_id}] 탄약 {s.ammo_pct}%, 상태 {s.status}, 태세 {s.posture}, 경계수준 {s.alert_level}"
            for s in states
        ) or "(수신된 에지 데이터 없음)"

        recent_alerts = store.get_alerts()[-RECENT_ALERT_COUNT:][::-1]
        alert_lines = "\n".join(
            f"- {a.message} / 권고: {a.recommended_action}" for a in recent_alerts
        ) or "(최근 알림 없음)"

        return SYSTEM_PROMPT_TEMPLATE.format(
            manual=rule_engine.manual_text,
            states=state_lines,
            alerts=alert_lines,
            alert_count=RECENT_ALERT_COUNT,
        )

    async def _llm_answer(self, query: str) -> str:
        system_prompt = self._build_context(query)
        response = await asyncio.wait_for(
            self._client.chat.completions.create(
                model=OPENCODE_GO_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": query},
                ],
            ),
            timeout=LLM_TIMEOUT_SEC,
        )
        answer = response.choices[0].message.content or ""
        answer = re.sub(r"<think>.*?</think>", "", answer, flags=re.DOTALL).strip()
        if not answer:
            raise RuntimeError("empty LLM response")
        return answer

    def _rule_based_answer(self, q: str) -> str:
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
