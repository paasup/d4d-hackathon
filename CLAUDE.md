# D4D Hackathon — Edge COP / Central Intelligence Platform

## 프로젝트 목표
10시간 내 에지 COP(모킹) ↔ 중앙 플랫폼(대시보드+AI) 데이터·명령 순환 MVP 시연.

## 절대 규칙
- 모든 데이터 모델은 `shared/schemas.py`의 pydantic 모델을 그대로 import해서 쓴다. 임의로 필드 추가/변경 금지.
- 통신은 아래 "엔드포인트 계약" 표를 따른다. 새 엔드포인트 필요 시 이 파일에 먼저 추가 후 구현.
- 저장은 in-memory (dict/list)로 충분. DB 세팅에 시간 쓰지 않는다.
- "완벽한 구현"보다 "데모에서 눈에 보이는 것" 우선.

## 엔드포인트 계약

| 엔드포인트 | 방향 | 스키마 | 소유 |
|---|---|---|---|
| `WS /ws/edge` | 에지 → 중앙 (push) | `EdgeState` | central-backend |
| `WS /ws/command` | 중앙 → 에지 (push) | `Command` | central-backend |
| `GET /api/state` | 대시보드 ← 중앙 | `list[EdgeState]` | central-backend |
| `GET /api/alerts` | 대시보드 ← 중앙 | `list[AlertEvent]` | central-backend |
| `POST /api/command` | 대시보드 → 중앙 (하달 버튼) | `Command` | central-backend |
| `POST /api/chat` | 챗봇 UI → AI 엔진 | `{query: str}` → `{answer: str}` | ai-engine |
| `POST /api/simulator/restart` | 대시보드 → 중앙 (재시작 버튼) | 없음 → `{ok: bool}` (중앙은 상태 초기화 후 각 에지에 `Command(command="RESET"\|"RESET_LOW")` 하달 — 일부 에지는 RESET_LOW로 탄약 경보 3~4건을 즉시 재현) | central-backend |
| `WS /ws/dashboard` | 중앙 → 대시보드 (push, 다중 클라이언트) | `{"kind": "state", "data": list[EdgeState]}` \| `{"kind": "alert", "data": AlertEvent}` | central-backend |

## 컴포넌트별 담당
- edge-simulator: 20~30개 가상 에지, 5~10초 주기 상태 송신, RESUPPLY 명령 수신 시 상태 천이
- central-backend: FastAPI+WebSocket, in-memory 상태 저장, 룰 트리거(ammo_pct<=20 → AlertEvent), 대시보드 정적 파일 서빙(StaticFiles) + `/ws/dashboard` 브로드캐스트
- dashboard: Vanilla JS + Leaflet.js, 순수 WebSocket으로 `/ws/dashboard` 구독 (진짜 실시간 push, 전체 rerun 없음), 개별 에지 마커 상시 노출(에지 25개가 넓게 분산돼 있어 클러스터링 시 클릭이 줌인으로 가로채여지는 문제를 피하기 위해 클러스터링 미사용으로 변경), 사이드바 상세정보, 하달하기 버튼. 상세 배경은 [docs/prompt/02.proposal_realtime_dashboard.md](docs/prompt/02.proposal_realtime_dashboard.md) 참고.
- ai-engine: 교본 텍스트 키워드 매칭(룰 기반) + 챗봇(사전정의 응답 우선, Ollama는 optional)

## 개발 순서 (이 문서 읽는 세션은 자기 단계만 신경쓸 것)
1. central-backend 골격 (다른 모든 것의 의존성)
2. edge-simulator, dashboard 병렬 개발 (더미 데이터로 독립 개발 가능)
3. ai-engine 룰엔진 → 챗봇(가짜 응답 우선)
4. 통합 + scripts/demo_scenario.py로 리허설 자동화

## 교본 텍스트 위치
docs/국방_군수지원_교본.txt (룰 매칭용 더미, 실제 교본 아님)