const STATUS_LABEL = {
  idle: "대기",
  resupplying: "보급중",
  resupplied: "보급완료",
  alert: "경보",
};

const POSTURE_LABEL = { active: "평시", silent: "무선 침묵" };
const ALERT_LEVEL_LABEL = { normal: "정상", heightened: "격상" };
// edge-simulator/config.py의 SEND_INTERVAL_RANGE(5~10s) / SILENT_SEND_INTERVAL_RANGE(60~90s) 중간값 추정치
const POSTURE_INTERVAL_SECONDS = { active: 8, silent: 75 };

// 대대 보급기지 고정 좌표 (프론트 전용, 백엔드 관여 없음)
const DEPOT_COORDS = [37.9, 127.3];

const state = {
  edges: new Map(),        // edge_id -> EdgeState
  markers: new Map(),      // edge_id -> L.CircleMarker
  reconStatus: new Map(),  // edge_id -> { safe, message, action }
  lastUpdateAt: new Map(), // edge_id -> 마지막으로 새 상태를 수신한 로컬 시각(ms), 카운트다운 기준점
  selectedId: null,
};

// --- 지도 ---
const map = L.map("map").setView([38.0, 127.5], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const cluster = L.markerClusterGroup();
map.addLayer(cluster);

// 선택된 에지를 클러스터와 별개 레이어에 표시해, 클러스터링에 가려지지 않고 항상 선명하게 보이게 함
let selectionRing = null;
function updateSelectionRing() {
  const edge = state.edges.get(state.selectedId);
  if (!edge) {
    if (selectionRing) {
      map.removeLayer(selectionRing);
      selectionRing = null;
    }
    return;
  }
  const latlng = [edge.lat, edge.lon];
  if (!selectionRing) {
    selectionRing = L.circleMarker(latlng, {
      radius: 14,
      color: "#000000",
      weight: 3,
      fill: false,
      className: "selection-ring",
      interactive: false,
    }).addTo(map);
  } else {
    selectionRing.setLatLng(latlng);
  }
}

function markerColor(ammoPct) {
  if (ammoPct <= 20) return "#e03131";
  if (ammoPct <= 50) return "#f08c00";
  return "#2f9e44";
}

// posture(silent=반투명), alert_level(heightened=주황 테두리)을 기존 ammo 색상 위에 오버레이로 표시
function markerStyle(edge) {
  const base = markerColor(edge.ammo_pct);
  return {
    color: edge.alert_level === "heightened" ? "#f08c00" : base,
    weight: edge.alert_level === "heightened" ? 3 : 1,
    fillColor: base,
    fillOpacity: edge.posture === "silent" ? 0.3 : 0.85,
    opacity: edge.posture === "silent" ? 0.4 : 1,
  };
}

function upsertMarker(edge) {
  let marker = state.markers.get(edge.edge_id);
  if (!marker) {
    marker = L.circleMarker([edge.lat, edge.lon], {
      radius: 8,
      ...markerStyle(edge),
    });
    marker.bindTooltip(edge.edge_id);
    marker.on("click", () => selectEdge(edge.edge_id));
    marker.addTo(cluster);
    state.markers.set(edge.edge_id, marker);
  } else {
    // Leaflet.markercluster는 클러스터에 들어간 마커를 setLatLng만으로 옮기면
    // 내부 공간 인덱스가 갱신되지 않아 위치가 크게 바뀔 때 마커가 사라져 보일 수 있어
    // 제거 후 재삽입한다.
    cluster.removeLayer(marker);
    marker.setLatLng([edge.lat, edge.lon]);
    marker.setStyle(markerStyle(edge));
    cluster.addLayer(marker);
  }
  const popupText = `${edge.edge_id}: ${edge.ammo_pct}% (${STATUS_LABEL[edge.status]})`;
  if (marker.getPopup()) marker.setPopupContent(popupText);
  else marker.bindPopup(popupText);
}

function applyStates(edgeList) {
  const now = Date.now();
  for (const edge of edgeList) {
    // /ws/dashboard의 "state"는 에지 하나가 갱신될 때마다 전체 스냅샷으로 재브로드캐스트되므로,
    // 해당 에지 자신의 timestamp가 실제로 바뀐 경우에만 카운트다운 기준점을 리셋한다.
    const prev = state.edges.get(edge.edge_id);
    if (!prev || prev.timestamp !== edge.timestamp) {
      state.lastUpdateAt.set(edge.edge_id, now);
    }
    state.edges.set(edge.edge_id, edge);
    upsertMarker(edge);
  }
  updateStats();
  if (state.selectedId && state.edges.has(state.selectedId)) {
    renderDetail(state.edges.get(state.selectedId));
  }
}

function updateStats() {
  const all = [...state.edges.values()];
  document.getElementById("stat-total").textContent = all.length;
  document.getElementById("stat-alert").textContent = all.filter((e) => e.ammo_pct <= 20).length;
}

// --- 사이드바 상세 ---
function selectEdge(edgeId) {
  state.selectedId = edgeId;
  const edge = state.edges.get(edgeId);
  if (edge) renderDetail(edge);
}

function renderDetail(edge) {
  document.getElementById("edge-empty").classList.add("hidden");
  const detail = document.getElementById("edge-detail");
  detail.classList.remove("hidden");

  document.getElementById("d-id").textContent = edge.edge_id;
  document.getElementById("d-ammo").textContent = `${edge.ammo_pct}%`;
  const bar = document.getElementById("d-ammo-bar");
  bar.style.width = `${edge.ammo_pct}%`;
  bar.style.backgroundColor = markerColor(edge.ammo_pct);
  document.getElementById("d-status").textContent = STATUS_LABEL[edge.status];
  document.getElementById("d-coords").textContent = `${edge.lat.toFixed(4)}, ${edge.lon.toFixed(4)}`;
  document.getElementById("d-posture").textContent = POSTURE_LABEL[edge.posture] ?? POSTURE_LABEL.active;
  document.getElementById("d-alert-level").textContent = ALERT_LEVEL_LABEL[edge.alert_level] ?? ALERT_LEVEL_LABEL.normal;

  renderPostureCountdown();

  const postureBtn = document.getElementById("d-posture-btn");
  postureBtn.textContent = edge.posture === "silent" ? "무선 침묵 해제" : "무선 침묵 전환";
  const alertLevelBtn = document.getElementById("d-alertlevel-btn");
  alertLevelBtn.textContent = edge.alert_level === "heightened" ? "경계태세 격하" : "경계태세 격상";

  const alertBanner = document.getElementById("d-alert");
  if (edge.ammo_pct <= 20) {
    alertBanner.textContent = `⚠️ [${edge.edge_id}] 탄약 고갈 위기`;
    alertBanner.classList.remove("hidden");
  } else {
    alertBanner.classList.add("hidden");
  }

  renderReconStatus();
  updateSelectionRing();
}

// --- 무선 상태 갱신 카운트다운 (추정치, 매초 감소) ---
function renderPostureCountdown() {
  const el = document.getElementById("d-posture-countdown");
  const edge = state.edges.get(state.selectedId);
  if (!edge) {
    el.textContent = "";
    return;
  }
  const expected = POSTURE_INTERVAL_SECONDS[edge.posture] ?? POSTURE_INTERVAL_SECONDS.active;
  const lastAt = state.lastUpdateAt.get(edge.edge_id) ?? Date.now();
  const remaining = Math.max(0, Math.ceil(expected - (Date.now() - lastAt) / 1000));
  el.textContent = remaining > 0 ? `약 ${remaining}초 후 (추정)` : "갱신 대기중...";
}

setInterval(() => {
  if (state.selectedId) renderPostureCountdown();
}, 1000);

// --- 정찰 결과: 알림 패널과 별개로 선택된 에지의 명령 버튼 옆에도 표시 ---
function renderReconStatus() {
  const statusEl = document.getElementById("d-recon-status");
  const resupplyBtn = document.getElementById("d-resupply-btn");
  const recon = state.reconStatus.get(state.selectedId);

  resupplyBtn.classList.remove("cmd-btn-warn");
  if (!recon) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.classList.remove("hidden");
  statusEl.className = `recon-status ${recon.safe ? "safe" : "unsafe"}`;
  statusEl.textContent = recon.safe ? "🔭 정찰 완료: 보급로 안전" : `🔭 정찰 완료: ${recon.action}`;
  if (!recon.safe) resupplyBtn.classList.add("cmd-btn-warn");
}

// --- 보급 COP 이동 애니메이션 (프론트엔드 전용, 백엔드/WS 관여 없음) ---
function animateConvoy(fromLatLng, toLatLng, durationMs = 10000) {
  const convoyMarker = L.circleMarker(fromLatLng, {
    radius: 6,
    color: "#2563eb",
    fillColor: "#2563eb",
    fillOpacity: 1,
    className: "convoy-marker",
  }).addTo(map);

  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const lat = fromLatLng[0] + (toLatLng[0] - fromLatLng[0]) * t;
    const lon = fromLatLng[1] + (toLatLng[1] - fromLatLng[1]) * t;
    convoyMarker.setLatLng([lat, lon]);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      map.removeLayer(convoyMarker);
    }
  }
  requestAnimationFrame(step);
}

async function sendCommand(command) {
  if (!state.selectedId) return;
  const resultEl = document.getElementById("d-command-result");
  resultEl.textContent = "";
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edge_id: state.selectedId,
        command,
        issued_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    resultEl.textContent = `[${state.selectedId}]에 ${command} 명령 하달됨`;
    resultEl.style.color = "#5be07a";
    return true;
  } catch (e) {
    resultEl.textContent = `명령 하달 중 오류: ${e.message}`;
    resultEl.style.color = "#ff8080";
    return false;
  }
}

function bindCommandButton(btnId, resolveCommand, onSuccess) {
  const btn = document.getElementById(btnId);
  btn.addEventListener("click", async () => {
    if (!state.selectedId) return;
    btn.disabled = true;
    const command = resolveCommand();
    const ok = await sendCommand(command);
    if (ok && onSuccess) onSuccess();
    setTimeout(() => { btn.disabled = false; }, 1500);
  });
}

bindCommandButton("d-recon-btn", () => "RECON_DRONE");

document.getElementById("d-resupply-btn").addEventListener("click", async () => {
  if (!state.selectedId) return;
  const recon = state.reconStatus.get(state.selectedId);
  if (recon && !recon.safe) {
    const proceed = confirm(`⚠️ 정찰 결과 위험 지역입니다 (${recon.action}).\n그래도 보급을 실행하시겠습니까?`);
    if (!proceed) return;
  }
  const btn = document.getElementById("d-resupply-btn");
  btn.disabled = true;
  const ok = await sendCommand("RESUPPLY");
  if (ok) {
    const edge = state.edges.get(state.selectedId);
    if (edge) animateConvoy(DEPOT_COORDS, [edge.lat, edge.lon]);
  }
  setTimeout(() => { btn.disabled = false; }, 1500);
});

bindCommandButton("d-posture-btn", () => {
  const edge = state.edges.get(state.selectedId);
  return edge && edge.posture === "silent" ? "ACTIVE_MODE" : "SILENT_MODE";
});

bindCommandButton("d-alertlevel-btn", () => {
  const edge = state.edges.get(state.selectedId);
  return edge && edge.alert_level === "heightened" ? "ALERT_LEVEL_DOWN" : "ALERT_LEVEL_UP";
});

// --- 알림 로그 ---
function trackReconResult(alert) {
  if (!alert.message.includes("정찰 결과")) return;
  state.reconStatus.set(alert.edge_id, {
    safe: alert.level === "warning",
    action: alert.recommended_action,
  });
  if (alert.edge_id === state.selectedId) renderReconStatus();
}

function renderAlert(alert) {
  trackReconResult(alert);
  const list = document.getElementById("alerts-list");
  if (list.classList.contains("muted")) {
    list.classList.remove("muted");
    list.textContent = "";
  }
  const item = document.createElement("div");
  item.className = `alert-item ${alert.level}`;
  item.innerHTML = `<span class="icon"></span><span>${alert.message} — ${alert.recommended_action}</span>`;
  list.prepend(item);
  while (list.children.length > 5) list.removeChild(list.lastChild);
}

function renderAlertList(alerts) {
  // 오래된 것부터 순서대로 prepend하면 최신 알림이 최종적으로 맨 위에 위치한다.
  for (const a of alerts.slice(-5)) renderAlert(a);
}

// --- 챗봇 ---
function appendChatMessage(role, text) {
  const history = document.getElementById("chat-history");
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  history.appendChild(el);
  history.scrollTop = history.scrollHeight;
}

document.getElementById("chat-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("chat-input");
  const query = input.value.trim();
  if (!query) return;
  appendChatMessage("user", query);
  input.value = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appendChatMessage("assistant", data.answer);
  } catch (e) {
    appendChatMessage("assistant", `AI 서버에 연결할 수 없습니다: ${e.message}`);
  }
});

// --- 연결 상태 배지 ---
function setConnStatus(mode) {
  const el = document.getElementById("conn-status");
  el.className = `badge badge-${mode}`;
  el.textContent = { connecting: "연결 중...", live: "실시간 연결됨", down: "연결 끊김" }[mode];
}

// --- WebSocket push 구독 ---
function connectDashboardSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);

  ws.onopen = () => setConnStatus("live");
  ws.onclose = () => {
    setConnStatus("down");
    setTimeout(connectDashboardSocket, 1500);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.kind === "state") {
      applyStates(msg.data);
    } else if (msg.kind === "alert") {
      renderAlert(msg.data);
    }
  };
}

// --- 초기 스냅샷 로딩 ---
async function loadInitialSnapshot() {
  try {
    const [statesRes, alertsRes] = await Promise.all([
      fetch("/api/state"),
      fetch("/api/alerts"),
    ]);
    const states = await statesRes.json();
    const alerts = await alertsRes.json();
    applyStates(states);
    renderAlertList(alerts);
  } catch (e) {
    setConnStatus("down");
  }
}

loadInitialSnapshot();
connectDashboardSocket();
