# 대시보드 실시간성 개선 제안서

## 1. 문제 정의

현재 `dashboard/app.py`는 Streamlit + `st_autorefresh`(8초 polling) + `st_folium` 조합이다.
문서 요건([docs/prompt/init.md](prompt/init.md))이 요구하는 "실시간 상황판"과 구조적으로 충돌하는 지점:

| 요건 (init.md) | Streamlit의 한계 |
|---|---|
| 실시간 데이터 적재/시각화, 줌인줌아웃 클러스터링 | 상태 변경 시마다 **전체 스크립트 재실행(rerun)** → 지도가 매번 다시 그려지고 `map_center`/`map_zoom`을 세션에 수동으로 붙잡아둬야 겨우 위치 유지됨 (이미 코드에 우회 로직 존재) |
| 위기 감지 시 즉시 알림 팝업 | push가 아니라 **8초 polling**. 알림이 최대 8초 지연, 그마저도 사용자가 다른 위젯을 조작하면 rerun 타이밍이 흔들림 |
| 사이드바 상세정보(핀 클릭 → 그래프) | Folium 팝업은 순수 HTML 텍스트이고, `st_folium`의 클릭 이벤트는 rerun을 거쳐야 selectbox에 반영됨 → 클릭 후 반응까지 지연·깜빡임 |
| "하달하기" 버튼 → 즉시 상태 반영 | 버튼 클릭도 전체 rerun. 명령 전송 성공 토스트는 나오지만, 에지가 실제로 "보급중→보급완료"로 바뀌는 건 다음 polling 주기까지 화면에 안 보임 |
| 챗봇 대화창 | 메시지 하나 보낼 때마다 전체 rerun, 대화가 길어지면 스크롤 위치도 리셋 |

즉, Streamlit의 실행 모델(=상태가 바뀌면 스크립트를 처음부터 다시 돎) 자체가 "이벤트 발생 → 즉시 화면 반영"이라는 데모의 핵심 임팩트와 근본적으로 안 맞는다. 폴링 주기를 줄이는 미봉책으로는 한계가 있다.

## 2. 대안 비교

백엔드(FastAPI, WebSocket, `shared/schemas.py`, rule_engine, chat_engine)는 이미 완성되어 있고 그대로 재사용 가능하다는 전제 하에 비교.

| 옵션 | 방식 | 실시간성 | 추가 개발 비용 | 팀 리스크 |
|---|---|---|---|---|
| A. Streamlit 튜닝 | polling 주기 축소 + `st.fragment` 부분 rerun 활용 | 여전히 polling 기반, 근본 해결 안 됨 | 낮음 (30분) | 낮음, 하지만 천장이 낮음 |
| B. NiceGUI로 교체 | Python만으로 작성하는 반응형 웹 프레임워크. WebSocket 기반 부분 업데이트(전체 rerun 없음) | 진짜 push, 위젯 단위 갱신 | 중간 (기존 UI 로직 포팅, 2~3시간) | 낮음 (팀이 Python만 사용) |
| **C. Vanilla JS + Leaflet + 순수 WebSocket** (권장) | 정적 HTML/JS를 FastAPI가 서빙, 브라우저가 WS로 직접 push 수신 | 진짜 push, DOM 단위 갱신, 지연 거의 0 | 중간 (JS 코드 새로 작성, 2~3시간) | JS 작성 필요하지만 라이브러리는 CDN 스크립트 태그만 추가, 빌드툴 불필요 |
| D. React/Vite 등 SPA 프레임워크 | 정식 프론트엔드 빌드 | 진짜 push | 높음 (빌드 세팅, 4시간+) | 남은 시간 대비 과함 |

**권장: C안.** 이유:
- 백엔드가 이미 WebSocket(`/ws/edge`, `/ws/command`)을 쓰고 있어 "브라우저도 WS로 push 받기"는 아키텍처적으로 자연스러운 확장이다.
- 빌드 도구(npm/webpack/vite) 없이 `<script src="https://unpkg.com/leaflet">` CDN 태그 몇 개로 끝나서, 10시간 해커톤 잔여 시간 안에 안전하게 끝낼 수 있다.
- CLAUDE.md의 "완벽한 구현보다 데모에서 눈에 보이는 것 우선" 원칙에 가장 잘 맞는다 — 핀이 실시간으로 색이 바뀌고, 클릭 즉시 사이드바가 반응하고, 명령 하달 후 몇 초 뒤 마커가 실시간으로 "보급완료"로 전환되는 장면은 심사위원에게 가장 강한 인상을 준다.
- B안(NiceGUI)은 팀이 JS를 전혀 못 다룰 경우의 안전한 대체안으로 문서 하단에 남겨둔다.

## 3. 목표 아키텍처 (C안)

```
edge-simulator (변경 없음)
      │ WS /ws/edge
      ▼
central-backend (FastAPI)
   ├─ store (in-memory, 변경 없음)
   ├─ rule_engine (변경 없음)
   ├─ chat_engine (변경 없음)
   ├─ 기존 REST: /api/state /api/alerts /api/command /api/chat  (변경 없음)
   ├─ 기존 WS: /ws/command (에지용, 변경 없음)
   ├─ [신규] WS /ws/dashboard  ← 브라우저 여러 개 동시 접속, 상태/알림 변경 시 broadcast
   └─ [신규] StaticFiles mount("/")  ← dashboard-web/ 정적 파일 서빙
                │
                ▼
        브라우저 (dashboard-web/index.html + app.js)
   ├─ 최초 로드: GET /api/state, /api/alerts 로 초기 스냅샷
   ├─ WS /ws/dashboard 연결 유지 → 이벤트 수신 즉시 지도/사이드바/알림 갱신
   ├─ Leaflet.js + Leaflet.markercluster → 줌 레벨별 클러스터링, 마커 클릭 → 사이드바
   ├─ 하달 버튼 → fetch POST /api/command (기존 계약 그대로)
   └─ 챗봇 패널 → fetch POST /api/chat (기존 계약 그대로)
```

기존 엔드포인트 계약(`WS /ws/edge`, `WS /ws/command`, `GET /api/state`, `GET /api/alerts`, `POST /api/command`, `POST /api/chat`)은 **하나도 변경하지 않는다.** 딱 하나, 브로드캐스트용 WS만 추가한다.

### 신규 엔드포인트 (CLAUDE.md 계약 표에 추가 필요)

| 엔드포인트 | 방향 | 스키마 | 소유 |
|---|---|---|---|
| `WS /ws/dashboard` | 중앙 → 대시보드 (push, 다중 클라이언트) | `{"kind": "state", "data": list[EdgeState]}` 또는 `{"kind": "alert", "data": AlertEvent}` | central-backend |

- 새 pydantic 모델을 만들지 않는다 — `EdgeState`/`AlertEvent`를 그대로 감싸서 보낼 뿐이다 (CLAUDE.md의 "모든 데이터 모델은 shared/schemas.py를 그대로 import" 규칙 준수).
- `kind` 필드는 클라이언트가 어떤 종류의 push인지 구분하기 위한 최소한의 래퍼일 뿐, 데이터 모델 자체는 변경하지 않는다.

## 4. 적용 절차

### Step 0. 계약 갱신 (5분)
- `CLAUDE.md`의 "엔드포인트 계약" 표에 위 `WS /ws/dashboard` 행 추가.

### Step 1. central-backend: 브로드캐스트 채널 추가 (30분)
- `central-backend/main.py`의 `ConnectionManager`에 대시보드 클라이언트 목록 추가:
  ```python
  self.dashboard_clients: set[WebSocket] = set()

  async def broadcast(self, kind: str, data):
      dead = []
      for ws in self.dashboard_clients:
          try:
              await ws.send_json({"kind": kind, "data": data})
          except Exception:
              dead.append(ws)
      for ws in dead:
          self.dashboard_clients.discard(ws)
  ```
- `WS /ws/dashboard` 엔드포인트 추가 (accept 후 `dashboard_clients`에 등록, `receive_text()`로 연결 유지 + 끊기면 discard).
- 다음 세 지점에서 `broadcast()` 호출 추가:
  - `ws_edge`: 상태 upsert 후 → `broadcast("state", [state.model_dump(mode="json") for state in store.get_all_states()])`
  - `ws_edge`: alert 발생 시 → `broadcast("alert", alert.model_dump(mode="json"))`
  - `debug_set_ammo`: 동일하게 alert 발생 시 broadcast (리허설 데모용 백도어도 실시간 반영되어야 함)

### Step 2. central-backend: 정적 파일 서빙 추가 (10분)
- `main.py` 하단에:
  ```python
  from fastapi.staticfiles import StaticFiles
  app.mount("/", StaticFiles(directory="../dashboard-web", html=True), name="dashboard")
  ```
- API 라우트(`/api/*`, `/ws/*`)가 먼저 매칭되도록 이 mount는 **라우트 정의 이후, 파일 맨 끝**에 위치시킨다 (순서 중요).
- 별도 프로세스/포트 없이 `localhost:8000/` 하나로 대시보드+API가 뜨므로 CORS 설정이 필요 없다.

### Step 3. `dashboard-web/` 신설 (1.5~2시간)
```
dashboard-web/
├── index.html   (레이아웃: 지도 영역 + 사이드바 + 알림 로그 + 챗봇 패널)
├── app.js       (WS 연결, Leaflet 초기화, 클러스터링, 클릭 핸들러, fetch 호출)
└── style.css
```
- **Leaflet + Leaflet.markercluster**: CDN `<link>`/`<script>` 태그만 추가. `L.markerClusterGroup()`으로 기존 Folium `MarkerCluster`와 동일한 줌레벨별 클러스터링 재현.
- **초기 로드**: `fetch('/api/state')`, `fetch('/api/alerts')`로 최초 스냅샷을 그린 뒤, `new WebSocket('ws://localhost:8000/ws/dashboard')` 연결.
- **`ws.onmessage`**: `kind === "state"`면 마커 색상/좌표 갱신(마커 재사용, `setLatLng`/`setStyle`로 애니메이션 느낌), `kind === "alert"`이면 알림 로그 영역 맨 위에 즉시 추가 + 토스트 팝업.
- **마커 클릭 → 사이드바**: 기존 Streamlit의 selectbox 대체. 클릭 이벤트에서 해당 `edge_id` 상세정보(잔여 탄약 progress bar, 상태 라벨)를 즉시 DOM에 렌더링. 서버 왕복 없음.
- **하달 버튼**: `fetch('/api/command', {method:'POST', body: JSON.stringify(cmd)})`. 성공 시 버튼을 잠깐 비활성화하는 정도의 optimistic UI만 넣고, 실제 상태 전환(보급중→보급완료)은 `/ws/dashboard`로 들어오는 push가 그대로 반영한다 — 별도 polling 불필요.
- **챗봇 패널**: 기존 로직과 동일하게 `fetch('/api/chat', {method:'POST', body: JSON.stringify({query})})`, 응답을 채팅창 DOM에 append. 리렌더 없이 스크롤 유지.
- **재연결 처리**: `ws.onclose`에서 1~2초 후 재연결 시도 (데모 중 네트워크 흔들림 대비 최소한의 안전장치).

### Step 4. 기존 Streamlit 코드 정리 (5분)
- `dashboard/app.py`, `dashboard/requirements.txt` 등은 **삭제하지 않고** `dashboard/legacy_streamlit/`로 이동 보관 (시간 부족 시 즉시 롤백 가능하도록).
- 실행 스크립트/README에서 대시보드 기동 방법을 "central-backend만 띄우면 `/`에서 대시보드 접속 가능"으로 갱신.

### Step 5. 통합 검증 (30분)
1. `central-backend` 기동 → `http://localhost:8000/` 접속, 초기 마커 로딩 확인.
2. `edge-simulator` 20~30개 기동 → 마커가 5~10초 주기로 push되어 실시간 갱신되는지 확인 (새로고침 없이).
3. `scripts/demo_scenario.py` 실행 (엔드포인트 계약이 그대로이므로 **수정 불필요**) → 탄약 15% 강제 주입 시 알림이 지연 없이 뜨는지, 챗봇 응답, 명령 하달 후 마커가 "보급중→보급완료"로 push 기반으로 전환되는지 확인.
4. 마커 클릭 → 사이드바 반응 속도, 클러스터링 줌레벨 동작 확인.

### Step 6. 리허설
- 전체 시나리오(탄약 감소 → 알림 → 챗봇 질문 → 명령 하달 → 보급완료)를 반복하며 지연/깜빡임이 실제로 사라졌는지 스톱워치로 체감 확인.

## 5. 예상 소요 시간

Step 0~2 (백엔드) 약 45분 + Step 3 (프론트) 약 2시간 + Step 4~6 약 40분 → **총 3.5시간 이내**. 기존 백엔드/스키마/룰엔진/챗엔진은 전혀 건드리지 않으므로 리스크는 프론트엔드 코드 자체에 국한된다.

## 6. 대체안 (JS 작성이 정말 부담스러운 경우)

**NiceGUI(Python)**로 교체: `pip install nicegui`, `ui.leaflet()` 컴포넌트로 지도, 서버 push 기반 갱신(`ui.timer` 대신 이벤트 큐 → `ui.update()`)으로 전체 rerun 없이 위젯 단위 갱신 가능. 팀이 Python만으로 작업 가능하다는 장점이 있으나, 커스텀 마커 클러스터링/팝업 세밀 제어는 Leaflet 직접 제어보다 부자연스러워 C안보다 완성도가 낮아질 수 있다.
