const STATUS_LABEL = {
  idle: "대기",
  resupplying: "보급중",
  resupplied: "보급완료",
  alert: "경보",
};

const state = {
  edges: new Map(),   // edge_id -> EdgeState
  markers: new Map(), // edge_id -> L.CircleMarker
  selectedId: null,
};

// --- 지도 ---
const map = L.map("map").setView([38.0, 127.5], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const cluster = L.markerClusterGroup();
map.addLayer(cluster);

function markerColor(ammoPct) {
  if (ammoPct <= 20) return "#e03131";
  if (ammoPct <= 50) return "#f08c00";
  return "#2f9e44";
}

function upsertMarker(edge) {
  let marker = state.markers.get(edge.edge_id);
  if (!marker) {
    marker = L.circleMarker([edge.lat, edge.lon], {
      radius: 8,
      color: markerColor(edge.ammo_pct),
      fillColor: markerColor(edge.ammo_pct),
      fillOpacity: 0.85,
    });
    marker.bindTooltip(edge.edge_id);
    marker.on("click", () => selectEdge(edge.edge_id));
    marker.addTo(cluster);
    state.markers.set(edge.edge_id, marker);
  } else {
    marker.setLatLng([edge.lat, edge.lon]);
    marker.setStyle({ color: markerColor(edge.ammo_pct), fillColor: markerColor(edge.ammo_pct) });
  }
  const popupText = `${edge.edge_id}: ${edge.ammo_pct}% (${STATUS_LABEL[edge.status]})`;
  if (marker.getPopup()) marker.setPopupContent(popupText);
  else marker.bindPopup(popupText);
}

function applyStates(edgeList) {
  for (const edge of edgeList) {
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

  const alertBanner = document.getElementById("d-alert");
  if (edge.ammo_pct <= 20) {
    alertBanner.textContent = `⚠️ [${edge.edge_id}] 탄약 고갈 위기`;
    alertBanner.classList.remove("hidden");
  } else {
    alertBanner.classList.add("hidden");
  }
}

document.getElementById("d-resupply-btn").addEventListener("click", async () => {
  if (!state.selectedId) return;
  const btn = document.getElementById("d-resupply-btn");
  const resultEl = document.getElementById("d-command-result");
  btn.disabled = true;
  resultEl.textContent = "";
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edge_id: state.selectedId,
        command: "RESUPPLY",
        issued_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    resultEl.textContent = `[${state.selectedId}]에 RESUPPLY 명령 하달됨`;
    resultEl.style.color = "#5be07a";
  } catch (e) {
    resultEl.textContent = `명령 하달 중 오류: ${e.message}`;
    resultEl.style.color = "#ff8080";
  } finally {
    setTimeout(() => { btn.disabled = false; }, 1500);
  }
});

// --- 알림 로그 ---
function renderAlert(alert) {
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
