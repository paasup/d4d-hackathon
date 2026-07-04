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
  markers: new Map(),      // edge_id -> L.CircleMarker (시각용)
  hitMarkers: new Map(),   // edge_id -> L.CircleMarker (클릭 판정용, 시각 마커보다 넓게)
  reconStatus: new Map(),  // edge_id -> { safe, message, action }
  detourWaypoint: new Map(), // edge_id -> [lat,lon], 우회로 정찰 성공 시 설정, 다음 RESUPPLY 1회에 소비됨
  lastUpdateAt: new Map(), // edge_id -> 마지막으로 새 상태를 수신한 로컬 시각(ms), 카운트다운 기준점
  selectedId: null,
  activeFilter: null, // null(전체) | "alert" | "silent" | "heightened"
};

function matchesFilter(edge) {
  switch (state.activeFilter) {
    case "alert": return edge.ammo_pct <= 20;
    case "silent": return edge.posture === "silent";
    case "heightened": return edge.alert_level === "heightened";
    default: return true;
  }
}

// --- 지도 ---
const map = L.map("map").setView([38.0, 127.5], 9);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

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
      color: "#ffd700",
      weight: 3,
      fill: false,
      className: "selection-ring",
      interactive: false,
    }).addTo(map);
  } else {
    selectionRing.setLatLng(latlng);
    selectionRing.bringToFront();
  }
}

function markerColor(ammoPct) {
  if (ammoPct <= 20) return "#e03131";
  if (ammoPct <= 50) return "#f08c00";
  return "#2f9e44";
}

// posture(silent=반투명+점선 테두리로 스텔스 표현), alert_level(heightened=주황 테두리)을 기존 ammo 색상 위에 오버레이로 표시
// activeFilter가 걸려 있으면 매칭 안 되는 마커는 흐리게 눌러서 대시보드 카드 클릭 결과를 지도에서 바로 구분되게 함
function markerStyle(edge) {
  const base = markerColor(edge.ammo_pct);
  if (state.activeFilter && !matchesFilter(edge)) {
    return { color: base, weight: 1, fillColor: base, fillOpacity: 0.08, opacity: 0.15 };
  }
  return {
    color: edge.alert_level === "heightened" ? "#f08c00" : base,
    weight: edge.alert_level === "heightened" ? 3 : 1,
    fillColor: base,
    fillOpacity: edge.posture === "silent" ? 0.3 : 0.85,
    opacity: edge.posture === "silent" ? 0.4 : 1,
    dashArray: edge.posture === "silent" ? "3 4" : null,
  };
}

function refreshMarkerStyles() {
  for (const [edgeId, marker] of state.markers) {
    const edge = state.edges.get(edgeId);
    if (edge) marker.setStyle(markerStyle(edge));
  }
}

function setFilter(filter) {
  state.activeFilter = filter === "all" || state.activeFilter === filter ? null : filter;
  document.querySelectorAll(".stat-card").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === state.activeFilter);
  });
  refreshMarkerStyles();
  if (state.activeFilter) {
    const matched = [...state.edges.values()].filter(matchesFilter);
    if (matched.length) {
      map.fitBounds(matched.map((e) => [e.lat, e.lon]), { padding: [60, 60], maxZoom: 11 });
    }
  }
}

document.querySelectorAll(".stat-card").forEach((btn) => {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
});

// 시각 마커(반경 8px)는 그대로 두고, 그보다 넓은 투명 원(반경 16px)을 얹어 클릭 판정 범위를 넓힌다.
// 지도에서 좁은 점을 정확히 클릭해야 하는 불편을 줄이기 위함 — 클릭/툴팁/팝업은 모두 이 투명 원이 담당.
const HIT_RADIUS = 16;

function upsertMarker(edge) {
  let marker = state.markers.get(edge.edge_id);
  let hitMarker = state.hitMarkers.get(edge.edge_id);
  if (!marker) {
    marker = L.circleMarker([edge.lat, edge.lon], {
      radius: 8,
      interactive: false,
      ...markerStyle(edge),
    });
    marker.addTo(map);
    state.markers.set(edge.edge_id, marker);

    hitMarker = L.circleMarker([edge.lat, edge.lon], {
      radius: HIT_RADIUS,
      stroke: false,
      fill: true,
      fillOpacity: 0.01,
      className: "marker-hit-area",
    });
    hitMarker.bindTooltip(edge.edge_id);
    hitMarker.on("click", () => selectEdge(edge.edge_id));
    hitMarker.addTo(map);
    state.hitMarkers.set(edge.edge_id, hitMarker);
  } else {
    marker.setLatLng([edge.lat, edge.lon]);
    marker.setStyle(markerStyle(edge));
    hitMarker.setLatLng([edge.lat, edge.lon]);
  }
  const popupText = `${edge.edge_id}: ${edge.ammo_pct}% (${STATUS_LABEL[edge.status]})`;
  if (hitMarker.getPopup()) hitMarker.setPopupContent(popupText);
  else hitMarker.bindPopup(popupText);
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
  document.getElementById("stat-silent").textContent = all.filter((e) => e.posture === "silent").length;
  document.getElementById("stat-heightened").textContent = all.filter((e) => e.alert_level === "heightened").length;
}

// --- 사이드바 상세 ---
function selectEdge(edgeId) {
  state.selectedId = edgeId;
  document.getElementById("d-command-result").textContent = "";
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
  const alertLevelEl = document.getElementById("d-alert-level");
  alertLevelEl.textContent = ALERT_LEVEL_LABEL[edge.alert_level] ?? ALERT_LEVEL_LABEL.normal;
  alertLevelEl.classList.toggle("classification-badge", edge.alert_level === "heightened");
  alertLevelEl.classList.toggle("level-heightened", edge.alert_level === "heightened");

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
  const detourBtn = document.getElementById("d-detour-btn");
  const recon = state.reconStatus.get(state.selectedId);

  resupplyBtn.classList.remove("cmd-btn-warn");
  detourBtn.classList.add("hidden");
  if (!recon) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.classList.remove("hidden");
  statusEl.className = `recon-status ${recon.safe ? "safe" : "unsafe"}`;
  statusEl.textContent = recon.safe ? "🔭 정찰 완료: 보급로 안전" : `🔭 정찰 완료: ${recon.action}`;
  if (!recon.safe) {
    resupplyBtn.classList.add("cmd-btn-warn");
    detourBtn.classList.remove("hidden");
  }
}

// --- 이동 유닛 애니메이션 (프론트엔드 전용, 백엔드/WS 관여 없음) ---
// path: [[lat,lon], ...] 2개 이상의 경유점을 구간별로 균등 시간 배분해 순서대로 이동
function animateUnit(path, { color = "#2563eb", durationMs = 10000, className = "convoy-marker", showRoute = false } = {}) {
  const marker = L.circleMarker(path[0], {
    radius: 6,
    color,
    fillColor: color,
    fillOpacity: 1,
    className,
  }).addTo(map);

  const route = showRoute
    ? L.polyline(path, { color, weight: 2, opacity: 0.6, dashArray: "4 6", interactive: false }).addTo(map)
    : null;

  const segCount = path.length - 1;
  const segMs = durationMs / segCount;
  const start = performance.now();

  function step(now) {
    const elapsed = now - start;
    const segIndex = Math.min(segCount - 1, Math.floor(elapsed / segMs));
    const segT = Math.min(1, (elapsed - segIndex * segMs) / segMs);
    const [fromLat, fromLon] = path[segIndex];
    const [toLat, toLon] = path[segIndex + 1];
    marker.setLatLng([fromLat + (toLat - fromLat) * segT, fromLon + (toLon - fromLon) * segT]);
    if (elapsed < durationMs) {
      requestAnimationFrame(step);
    } else {
      map.removeLayer(marker);
      if (route) map.removeLayer(route);
    }
  }
  requestAnimationFrame(step);
}

// waypoint가 있으면(직전 우회로 정찰로 확보된 경로) 그 경로를 그대로 따라가고,
// 없으면 보급기지->에지 직선으로 이동한다.
function animateConvoy(fromLatLng, toLatLng, durationMs = 10000, waypoint = null) {
  const path = waypoint ? [fromLatLng, waypoint, toLatLng] : [fromLatLng, toLatLng];
  animateUnit(path, { color: "#2563eb", durationMs, className: "convoy-marker", showRoute: !!waypoint });
}

// 직선의 수직 방향으로 경유점을 밀어 우회 경로처럼 보이게 함
function detourWaypoint(from, to, offsetFraction = 0.35) {
  const dLat = to[0] - from[0];
  const dLon = to[1] - from[1];
  return [(from[0] + to[0]) / 2 - dLon * offsetFraction, (from[1] + to[1]) / 2 + dLat * offsetFraction];
}

// RECON_DRONE: 보급기지 -> 에지 -> 보급기지 왕복, 서버 정찰 소요시간(6s)에 맞춤
function animateRecon(edgeLatLng, durationMs = 6000) {
  animateUnit([DEPOT_COORDS, edgeLatLng, DEPOT_COORDS], {
    color: "#22d3ee",
    durationMs,
    className: "recon-marker",
    showRoute: true,
  });
}

// DETOUR_RECON: 직선이 아닌 우회 경유점을 지나는 경로로 대안 경로 탐색을 표현.
// 확보된 경유점은 state.detourWaypoint에 저장해 다음 RESUPPLY가 같은 경로를 따르게 한다.
function animateDetourRecon(edgeId, edgeLatLng, durationMs = 6000) {
  const waypoint = detourWaypoint(DEPOT_COORDS, edgeLatLng);
  state.detourWaypoint.set(edgeId, waypoint);
  animateUnit([DEPOT_COORDS, waypoint, edgeLatLng], {
    color: "#f08c00",
    durationMs,
    className: "detour-marker",
    showRoute: true,
  });
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
    if (!state.selectedId || btn.disabled) return;
    btn.disabled = true;
    const command = resolveCommand();
    // 서버는 명령 수신 즉시 정찰 타이머(6s)를 시작하므로, 네트워크 응답(특히 첫 요청의 콜드
    // 커넥션 지연)을 기다리지 않고 시각 효과를 먼저 재생해 체감 지연을 없앤다.
    if (onSuccess) onSuccess();
    // 응답이 올 때까지 버튼을 잠가 중복 클릭으로 명령이 두 번 전달되는 것을 막는다.
    await sendCommand(command);
    btn.disabled = false;
  });
}

bindCommandButton("d-recon-btn", () => "RECON_DRONE", () => {
  const edge = state.edges.get(state.selectedId);
  if (edge) animateRecon([edge.lat, edge.lon]);
});
bindCommandButton("d-detour-btn", () => "DETOUR_RECON", () => {
  const edge = state.edges.get(state.selectedId);
  if (edge) animateDetourRecon(state.selectedId, [edge.lat, edge.lon]);
});

document.getElementById("d-resupply-btn").addEventListener("click", async () => {
  const btn = document.getElementById("d-resupply-btn");
  if (!state.selectedId || btn.disabled) return;
  const recon = state.reconStatus.get(state.selectedId);
  if (recon && !recon.safe) {
    const proceed = confirm(`⚠️ 정찰 결과 위험 지역입니다 (${recon.action}).\n그래도 보급을 실행하시겠습니까?`);
    if (!proceed) return;
  }
  btn.disabled = true;
  // 응답이 올 때까지 버튼을 잠가 중복 클릭으로 명령이 두 번 전달되는 것을 막는다.
  const ok = await sendCommand("RESUPPLY");
  if (ok) {
    const edge = state.edges.get(state.selectedId);
    if (edge) {
      const waypoint = state.detourWaypoint.get(state.selectedId) ?? null;
      animateConvoy(DEPOT_COORDS, [edge.lat, edge.lon], 10000, waypoint);
      state.detourWaypoint.delete(state.selectedId); // 1회 소비 후 초기화
    }
  }
  btn.disabled = false;
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
  // 정찰/우회로 정찰의 "안전 확인"은 level상 warning으로 오지만 내용은 긍정적 결과이므로
  // 경보용 주황 아이콘 대신 별도의 안전(초록) 표시로 구분한다.
  const isSafeRecon = alert.level === "warning" && alert.message.includes("정찰 결과") && alert.message.includes("안전");
  const item = document.createElement("div");
  item.className = `alert-item ${isSafeRecon ? "safe" : alert.level}`;
  item.innerHTML = `<span class="icon"></span><span>${alert.message} — ${alert.recommended_action}</span>`;
  if (state.edges.has(alert.edge_id)) {
    item.classList.add("alert-item-linked");
    item.addEventListener("click", () => {
      selectEdge(alert.edge_id);
      document.getElementById("side-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  list.prepend(item);
  while (list.children.length > 5) list.removeChild(list.lastChild);
}

function renderAlertList(alerts) {
  // 오래된 것부터 순서대로 prepend하면 최신 알림이 최종적으로 맨 위에 위치한다.
  for (const a of alerts.slice(-5)) renderAlert(a);
}

// --- 전술 AI 프롬프트 패널 (지도 위 좌측 오버레이) ---
const chatModal = document.getElementById("chat-modal");
const chatToggleBtn = document.getElementById("chat-toggle-btn");
const chatFullscreenBtn = document.getElementById("chat-fullscreen-btn");
function setChatOpen(open) {
  chatModal.classList.toggle("hidden", !open);
  chatToggleBtn.classList.toggle("hidden", open);
  if (!open) setChatFullscreen(false);
  if (open) document.getElementById("chat-input").focus();
}
function setChatFullscreen(full) {
  chatModal.classList.toggle("map-modal-fullscreen", full);
  chatFullscreenBtn.setAttribute("aria-label", full ? "전체화면 해제" : "전체화면");
}
chatToggleBtn.addEventListener("click", () => setChatOpen(true));
document.getElementById("chat-modal-close").addEventListener("click", () => setChatOpen(false));
chatFullscreenBtn.addEventListener("click", () => {
  setChatFullscreen(!chatModal.classList.contains("map-modal-fullscreen"));
});

// --- 챗봇 ---
// '>' 는 이스케이프하지 않는다 — 블록인용(>) 마커 탐지가 이스케이프 이후 텍스트에 대해 이뤄지므로,
// 여기서 '>' 를 '&gt;' 로 바꾸면 인용 블록 정규식이 매칭되지 않는다. 단독 '>' 는 태그를 열 수 없어 안전하다.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

// 챗봇 답변에 언급된 에지 ID(GOP-21, COP-02 등)를 클릭 가능한 링크로 표시한다.
const EDGE_LINK_PATTERN = /\b([A-Z]{2,}-\d{1,3})\b/g;

function renderInlineMd(s) {
  return s
    .replace(EDGE_LINK_PATTERN, (match) => `<a href="#" class="edge-link" data-edge-id="${match}">${match}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function renderMdTable(rows) {
  const dataRows = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
  if (!dataRows.length) return "";
  const cellsOf = (r) => r.slice(1, -1).split("|").map((c) => c.trim());
  const header = cellsOf(dataRows[0]);
  const body = dataRows.slice(1);
  let html = "<table><thead><tr>" +
    header.map((h) => `<th>${renderInlineMd(h)}</th>`).join("") +
    "</tr></thead><tbody>";
  for (const r of body) {
    html += "<tr>" + cellsOf(r).map((c) => `<td>${renderInlineMd(c)}</td>`).join("") + "</tr>";
  }
  return html + "</tbody></table>";
}

// 간단한 마크다운 → HTML 렌더러 (헤더/볼드/이탤릭/목록/인용/표/구분선). 외부 라이브러리 미사용.
function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let listItems = null;
  let tableRows = null;
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length) {
      html += `<p>${paraLines.map(renderInlineMd).join("<br>")}</p>`;
      paraLines = [];
    }
  };
  const flushList = () => {
    if (listItems) {
      html += `<ul>${listItems.map((i) => `<li>${renderInlineMd(i)}</li>`).join("")}</ul>`;
      listItems = null;
    }
  };
  const flushTable = () => {
    if (tableRows) html += renderMdTable(tableRows);
    tableRows = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (/^\|.*\|$/.test(line)) {
      flushPara();
      flushList();
      (tableRows || (tableRows = [])).push(line);
      continue;
    }
    if (tableRows) flushTable();

    if (!line) {
      flushPara();
      flushList();
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      flushList();
      const level = Math.min(m[1].length + 2, 6);
      html += `<h${level}>${renderInlineMd(m[2])}</h${level}>`;
    } else if (/^-{3,}$/.test(line)) {
      flushPara();
      flushList();
      html += "<hr>";
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      flushList();
      html += `<blockquote>${renderInlineMd(m[1])}</blockquote>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      (listItems || (listItems = [])).push(m[1]);
    } else {
      flushList();
      paraLines.push(line);
    }
  }
  flushPara();
  flushList();
  flushTable();
  return html;
}

function appendChatMessage(role, text) {
  const history = document.getElementById("chat-history");
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  if (role === "assistant") {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
  history.appendChild(el);
  history.scrollTop = history.scrollHeight;
  return el;
}

document.getElementById("chat-history").addEventListener("click", (ev) => {
  const link = ev.target.closest(".edge-link");
  if (!link) return;
  ev.preventDefault();
  const edgeId = link.dataset.edgeId;
  if (!state.edges.has(edgeId)) return;
  setChatFullscreen(false);
  selectEdge(edgeId);
  document.getElementById("side-panel").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("chat-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("chat-input");
  const query = input.value.trim();
  if (!query) return;
  appendChatMessage("user", query);
  input.value = "";
  const pending = appendChatMessage("assistant", "생각 중...");
  pending.classList.add("pending");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    pending.innerHTML = renderMarkdown(data.answer);
    pending.classList.remove("pending");
  } catch (e) {
    pending.textContent = `AI 서버에 연결할 수 없습니다: ${e.message}`;
    pending.classList.remove("pending");
  }
});

// --- 시뮬레이터 재시작 ---
document.getElementById("restart-sim-btn").addEventListener("click", async () => {
  const btn = document.getElementById("restart-sim-btn");
  if (btn.disabled) return;
  const proceed = confirm("시뮬레이터를 초기 상태로 재시작하시겠습니까?\n모든 에지의 탄약/경계태세/알림 기록이 초기화됩니다.");
  if (!proceed) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/simulator/restart", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.reconStatus.clear();
    const list = document.getElementById("alerts-list");
    list.className = "muted";
    list.textContent = "알림 없음";
  } catch (e) {
    alert(`재시작 실패: ${e.message}`);
  } finally {
    btn.disabled = false;
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
