// GRID 공무원 대시보드 (Streamlit 대시보드를 대체). 빌드 도구 없음. 데이터는 API로만 가져온다.
import { TYPE_BY_CODE, TYPES } from "../js/types.js";

const API = window.GRID_API || "";
const REFRESH_MS = 10000;
const URGENCY = { 3: "🔴 높음", 2: "🟠 보통", 1: "🟢 낮음" };
const HEAT_STOPS = [[0, [47, 158, 68]], [35, [148, 216, 45]], [55, [252, 216, 60]], [70, [252, 160, 30]], [85, [240, 80, 40]], [100, [190, 25, 45]]];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tLabel = (c) => { const t = TYPE_BY_CODE[c]; return t ? `${t.icon} ${t.label}` : c; };
const tColor = (c) => TYPE_BY_CODE[c]?.color || "#777";

function heatRGB(v) {
  v = Math.max(0, Math.min(100, v));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [b, cb] = HEAT_STOPS[i], [a, ca] = HEAT_STOPS[i - 1];
    if (v <= b) { const t = (v - a) / (b - a); return ca.map((x, k) => Math.round(x + (cb[k] - x) * t)); }
  }
  return HEAT_STOPS.at(-1)[1];
}
const heatCss = (v, a = 1) => `rgba(${heatRGB(v).join(",")},${a})`;

async function get(path) {
  const r = await fetch(API + path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
const safe = (p) => p.catch(() => null);

let state = { complaints: [], prio: [], meta: null, filter: new Set() };

// ---------------------------------------------------------------- CSV
function csv(rows) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1_");

// ---------------------------------------------------------------- 환경
function renderEnv(env) {
  const w = env?.weather || {}, a = env?.air || {};
  const box = $("env");
  if (!env || (!Object.keys(w).length && !Object.keys(a).length)) {
    box.innerHTML = "";
    $("env-note").textContent = "실시간 환경데이터 미연결 — 서버 .env 에 DATA_GO_KR_KEY 를 넣어 주세요.";
    return;
  }
  const f = (v, d, u) => (v == null ? "-" : v.toFixed(d) + u);
  const m = (label, val, sub) => `<div class="card m"><span>${label}</span><b>${val}</b><em>${esc(sub || "")}</em></div>`;
  box.innerHTML = m("기온", f(w.temp, 1, "°C")) + m("습도", f(w.humidity, 0, "%")) +
    m("초미세먼지 PM2.5", f(a.pm25, 0, "㎍/㎥"), a.pm25_grade) + m("미세먼지 PM10", f(a.pm10, 0, "㎍/㎥"), a.grade);
  $("env-note").textContent = `출처: 기상청 초단기실황 · 에어코리아 ${a.station || ""} 측정소 · ${env.updated_at || ""}`;
}

// ---------------------------------------------------------------- 우선 개선 구역
function renderTop3(pr) {
  const medal = ["🥇", "🥈", "🥉"];
  $("top3").innerHTML = pr.slice(0, 3).map((z, i) => {
    const want = z.top_type ? tLabel(z.top_type) : "제안 없음";
    return `<div class="card"><h4>${medal[i]} ${esc(z.name)}</h4>
      <div class="pair"><div class="m"><span>우선순위 점수</span><b>${Math.round(z.score)}</b></div>
      <div class="m"><span>열섬 지수</span><b>${Math.round(z.heat)}</b></div></div>
      시민 제안 <b>${z.proposals}건</b> · 신고 ${z.reports}건 · 공감 ${z.likes}<br>
      가장 많은 요청: <b>${esc(want)}</b><br>
      제안 실현 시 구역 평균 <b>${Math.round(z.heat)} → ${Math.round(z.heat_after)}</b>${z.delta > 0 ? ` (−${z.delta.toFixed(1)})` : ""}</div>`;
  }).join("");
}

function renderPrioTable(pr) {
  const head = ["순위", "구역", "점수", "열섬 평균", "실현 시 평균", "열섬(상위10%)", "제안", "신고", "공감"];
  const rows = pr.slice(0, 15).map((z) => [z.rank, z.name, z.score, z.heat, z.heat_after, z.heat_p90, z.proposals, z.reports, z.likes]);
  $("prio-tbl").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  $("dl-prio").onclick = () => download(`grid_우선개선구역_${stamp()}.csv`, csv([head, ...rows]));
}

// 구역 격자 지도: 구역 = 열섬 색 칸, 점 = 민원
let zoneHit = [];
function drawZoneMap(pr, complaints) {
  const cv = $("zmap"), m = state.meta;
  const s = m?.zone_size || 40;
  const cols = Math.ceil((m?.width || 527) / s), rowsN = Math.ceil((m?.depth || 583) / s);
  const W = cv.clientWidth || 600, cell = W / cols, H = Math.round(cell * rowsN);
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  zoneHit = [];
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  g.font = `600 ${Math.max(10, cell / 5)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const z of pr) {
    const cx = z.zone.charCodeAt(0) - 65, cz = parseInt(z.zone.slice(1), 10) - 1;
    const x = cx * cell, y = cz * cell;
    g.fillStyle = heatCss(z.heat, 0.85); g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    if (z.rank <= 3) { g.strokeStyle = dark ? "#fff" : "#111"; g.lineWidth = 3; g.strokeRect(x + 2, y + 2, cell - 4, cell - 4); }
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillText(z.zone, x + cell / 2, y + cell * 0.2);
    if (z.rank <= 15) { g.fillStyle = "#fff"; g.font = `700 ${Math.max(12, cell / 3)}px sans-serif`; g.fillText(z.rank, x + cell / 2, y + cell / 2); g.font = `600 ${Math.max(10, cell / 5)}px sans-serif`; }
    zoneHit.push({ x, y, w: cell, z });
  }
  const px = cell / s;
  for (const c of complaints) {
    const x = (c.x + 0.5) * px, y = (c.z + 0.5) * px;
    g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = tColor(c.type); g.fill();
    g.lineWidth = 1.5; g.strokeStyle = "#fff"; g.stroke();
  }
}
$("zmap").addEventListener("mousemove", (e) => {
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const h = zoneHit.find((k) => x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.w);
  const tip = $("tip");
  if (!h) { tip.style.display = "none"; return; }
  const z = h.z;
  tip.innerHTML = `<b>${z.rank}위 ${esc(z.name)}</b><br>점수 ${z.score} · 열섬 ${z.heat}<br>제안 ${z.proposals} · 신고 ${z.reports} · 공감 ${z.likes}`;
  tip.style.display = "block";
  tip.style.left = Math.min(x + 12, r.width - 190) + "px"; tip.style.top = y + 12 + "px";
});
$("zmap").addEventListener("mouseleave", () => ($("tip").style.display = "none"));

function drawQuadrant(pr) {
  const q = pr.filter((z) => z.built > 0.02).map((z) => ({ ...z, demand: z.proposals + z.reports + z.likes / 2 }));
  const svg = $("quad");
  if (!q.length) { svg.innerHTML = ""; return; }
  const L = 38, R = 390, T = 14, B = 262;
  const dmax = Math.max(1, ...q.map((z) => z.demand)) * 1.1;
  const sx = (v) => L + (v / 100) * (R - L), sy = (v) => B - (v / dmax) * (B - T);
  const sorted = q.map((z) => z.demand).sort((a, b) => a - b);
  const ym = Math.max(1, sorted[Math.floor(sorted.length * 0.75)] || 1);
  let h = `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="currentColor" opacity=".3"/><line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="currentColor" opacity=".3"/>
    <line x1="${sx(70)}" y1="${T}" x2="${sx(70)}" y2="${B}" stroke="#adb5bd" stroke-dasharray="3 3"/>
    <line x1="${L}" y1="${sy(ym)}" x2="${R}" y2="${sy(ym)}" stroke="#adb5bd" stroke-dasharray="3 3"/>
    <text x="${R}" y="${T + 10}" text-anchor="end" style="fill:#e03131;font-size:12px;font-weight:700">우선 개선</text>
    <text x="${(L + R) / 2}" y="292" text-anchor="middle">열섬 지수 (구역 평균)</text>
    <text x="10" y="${(T + B) / 2}" transform="rotate(-90 10 ${(T + B) / 2})" text-anchor="middle">시민 요구</text>`;
  for (const v of [0, 25, 50, 75, 100]) h += `<text x="${sx(v)}" y="${B + 12}" text-anchor="middle">${v}</text>`;
  for (const z of q) {
    const r = 4 + Math.min(10, Math.max(0, z.score) / 10);
    h += `<circle cx="${sx(z.heat)}" cy="${sy(z.demand)}" r="${r}" fill="${heatCss(z.heat, 0.8)}" stroke="#fff" stroke-width="1"><title>${esc(z.name)} · 열섬 ${z.heat} · 요구 ${z.demand.toFixed(1)}</title></circle>`;
  }
  svg.innerHTML = h;
}


// ---------------------------------------------------------------- 네이버 지도 (키가 있을 때만)
let naverKey = "", nmap = null, nShapes = [], nInfo = null, mapMode = "grid", naverReady = false;

function loadNaver() {
  return new Promise((resolve, reject) => {
    if (window.naver?.maps) return resolve();
    window.navermap_authFailure = () => naverFail();
    const sc = document.createElement("script");
    sc.src = "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + encodeURIComponent(naverKey);
    sc.onload = () => (window.naver?.maps ? resolve() : reject());
    sc.onerror = reject;
    document.head.appendChild(sc);
  });
}
function naverFail() {
  naverReady = false; setMapMode("grid"); $("mapmode").hidden = true; $("nmap-err").hidden = false;
}
function setMapMode(m) {
  mapMode = m;
  $("nmap").hidden = m !== "naver"; $("gridwrap").hidden = m !== "grid";
  document.querySelectorAll("#mapmode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === m)));
  redrawMap();
}
$("mapmode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMapMode(b.dataset.m); });

async function initNaver() {
  const c = await safe(get("/api/config"));
  naverKey = c?.naver_key || "";
  if (!naverKey) return;
  try { await loadNaver(); } catch { return naverFail(); }
  naverReady = true; $("mapmode").hidden = false; setMapMode("naver");
}

function drawNaver(pr, complaints) {
  const N = naver.maps, m = state.meta;
  if (!pr.length) return;
  const lat0 = pr.reduce((a, z) => a + z.lat, 0) / pr.length, lng0 = pr.reduce((a, z) => a + z.lng, 0) / pr.length;
  if (!nmap) {
    nmap = new N.Map("nmap", { center: new N.LatLng(lat0, lng0), zoom: 14, zoomControl: true,
      zoomControlOptions: { position: N.Position.RIGHT_CENTER }, mapTypeControl: true,
      mapTypeControlOptions: { position: N.Position.TOP_RIGHT } });
    nInfo = new N.InfoWindow({ borderWidth: 0, backgroundColor: "transparent", disableAnchor: true });
  } else N.Event.trigger(nmap, "resize");
  nShapes.forEach((o) => o.setMap(null)); nShapes = [];
  const half = ((m?.zone_size || 40) * (m?.cell || 5)) / 2;
  const dLat = half / 111320, dLng = half / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const medal = ["🥇", "🥈", "🥉"];
  for (const z of pr) {
    const top = z.rank <= 3, col = `rgb(${heatRGB(z.heat).join(",")})`;
    const demand = z.proposals + z.reports + z.likes / 2;
    const rect = new N.Rectangle({ map: nmap,
      bounds: new N.LatLngBounds(new N.LatLng(z.lat - dLat, z.lng - dLng), new N.LatLng(z.lat + dLat, z.lng + dLng)),
      fillColor: col, fillOpacity: top ? 0.5 : 0.3, strokeColor: top ? "#1c1c1c" : col, strokeOpacity: top ? 0.9 : 0.6,
      strokeWeight: top ? 3 : Math.min(0.5 + demand, 4), clickable: true });
    N.Event.addListener(rect, "click", (e) => {
      nInfo.setContent(`<div style="padding:8px 10px;background:#fff;color:#212529;border-radius:8px;box-shadow:0 2px 8px #0003;font-size:13px;line-height:1.5"><b>${z.rank}위 ${esc(z.name)}</b><br>점수 ${z.score} · 열섬 ${z.heat}<br>제안 ${z.proposals} · 신고 ${z.reports} · 공감 ${z.likes}</div>`);
      nInfo.open(nmap, e.coord);
    });
    nShapes.push(rect);
    if (top) nShapes.push(new N.Marker({ map: nmap, position: new N.LatLng(z.lat, z.lng),
      icon: { content: `<div style="transform:translate(-50%,-50%);white-space:nowrap;padding:3px 8px;border-radius:12px;background:#fff;color:#212529;border:2px solid ${col};font-weight:700;font-size:12px;box-shadow:0 1px 4px #0003">${medal[z.rank - 1]} ${esc(z.name)}</div>` } }));
  }
  for (const c of complaints) {
    const dot = new N.Circle({ map: nmap, center: new N.LatLng(c.lat, c.lng), radius: 7, fillColor: tColor(c.type), fillOpacity: 1,
      strokeColor: "#fff", strokeWeight: 1.5, clickable: true });
    N.Event.addListener(dot, "click", (e) => {
      nInfo.setContent(`<div style="padding:8px 10px;background:#fff;color:#212529;border-radius:8px;box-shadow:0 2px 8px #0003;font-size:13px;max-width:220px">${esc(tLabel(c.type))}<br>${esc(c.text)}<br>공감 ${c.likes}</div>`);
      nInfo.open(nmap, e.coord);
    });
    nShapes.push(dot);
  }
}

function redrawMap() {
  if (mapMode === "naver" && naverReady) { try { drawNaver(state.prio, state.complaints); } catch { naverFail(); } }
  else drawZoneMap(state.prio, state.complaints);
}

// ---------------------------------------------------------------- 민원
function filtered() { return state.filter.size ? state.complaints.filter((c) => state.filter.has(c.type)) : state.complaints; }

function renderChips() {
  $("chips").innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-t="${t.code}" aria-pressed="${state.filter.has(t.code)}">${t.icon} ${esc(t.label)}</button>`).join("");
}
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  const t = b.dataset.t; state.filter.has(t) ? state.filter.delete(t) : state.filter.add(t);
  renderChips(); renderComplaints();
});

function renderComplaints() {
  const df = filtered(), zn = Object.fromEntries(state.prio.map((z) => [z.zone, z.name]));
  if (!df.length) {
    $("kpis").innerHTML = ""; $("bytype").innerHTML = `<p class="cap">${state.complaints.length ? "선택한 유형의 민원이 없어요." : "아직 접수된 민원이 없어요. 시민 페이지에서 첫 민원을 등록해 보세요."}</p>`;
    $("topzones").innerHTML = ""; $("list").innerHTML = ""; return;
  }
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const cnt = (k) => df.reduce((m, c) => ((m[k(c)] = (m[k(c)] || 0) + 1), m), {});
  const byType = Object.entries(cnt((c) => c.type)).sort((a, b) => b[1] - a[1]);
  const byZone = Object.entries(cnt((c) => c.zone)).sort((a, b) => b[1] - a[1]);
  const k = (label, val, sub) => `<div class="card m"><span>${label}</span><b>${esc(val)}</b><em>${esc(sub || "")}</em></div>`;
  $("kpis").innerHTML = k("전체 민원", df.length + "건") + k("오늘 접수", df.filter((c) => c.created_at.slice(0, 10) === today).length + "건") +
    k("최다 요청", tLabel(byType[0][0]), byType[0][1] + "건") +
    k("최다 구역", (zn[byZone[0][0]] || byZone[0][0]).replace(" 주변", ""), byZone[0][1] + "건") +
    k("AI 긴급 판정", df.filter((c) => c.ai_urgency === 3).length + "건");

  const max = byType[0][1];
  $("bytype").innerHTML = byType.map(([t, n]) => `<div class="row"><span>${esc(tLabel(t))}</span><div class="bar" style="width:${(n / max) * 100}%;background:${tColor(t)}"></div><span class="n">${n}</span></div>`).join("");

  const zrows = byZone.map(([z, n]) => {
    const zs = df.filter((c) => c.zone === z);
    const likes = zs.reduce((s, c) => s + c.likes, 0);
    const top = Object.entries(zs.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0];
    return { z, n, likes, top };
  }).sort((a, b) => b.n - a.n || b.likes - a.likes).slice(0, 5);
  $("topzones").innerHTML = `<tr><th>구역</th><th>건수</th><th>공감</th><th>주요 요청</th></tr>` +
    zrows.map((r) => `<tr><td>${esc(zn[r.z] || r.z)}</td><td>${r.n}</td><td>${r.likes}</td><td>${esc(tLabel(r.top))}</td></tr>`).join("");

  const head = ["번호", "유형", "구역", "내용", "공감", "AI 긴급도", "접수 시각"];
  const rows = [...df].sort((a, b) => b.likes - a.likes || b.id - a.id)
    .map((c) => [c.id, tLabel(c.type), c.zone, c.text, c.likes, URGENCY[c.ai_urgency] || "", c.created_at.replace("T", " ").slice(0, 19)]);
  $("list").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>` +
    rows.slice(0, 300).map((r) => `<tr>${r.map((c, i) => `<td${i === 3 ? ' class="wrap"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("");
  $("dl-list").onclick = () => download(`grid_민원_${stamp()}.csv`, csv([head, ...rows]));
  $("updated").textContent = `마지막 갱신 ${new Date().toLocaleTimeString("ko-KR")}` + (rows.length > 300 ? ` · 화면에는 300건까지, CSV는 전체 ${rows.length}건` : "");
}

// ---------------------------------------------------------------- AI 텍스트 (느리므로 따로, 5분 캐시)
let aiAt = 0;
async function loadAI() {
  if (Date.now() - aiAt < 300000) return;
  aiAt = Date.now();
  const [p, s] = await Promise.all([safe(get("/api/ai/policy")), safe(get("/api/ai/summary"))]);
  if (p) {
    // AI가 # 머리글을 쓰면 너무 커지므로 굵은 글씨로 낮추고, **굵게**만 허용 (나머지는 이스케이프)
    $("policy").innerHTML = esc(p.text.replace(/^#{1,6}\s*(.+?)\s*#*$/gm, "**$1**")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    $("policy-cap").textContent = (p.ai ? "AI 분석 (Amazon Bedrock)" : "규칙 기반 제안 (AI 미연결)") + ` · ${p.generated_at}`;
  } else { $("policy").textContent = "정책 제안을 불러오지 못했어요."; aiAt = 0; }
  if (s) {
    $("summary").textContent = s.summary;
    $("summary-cap").textContent = (s.ai ? "AI 요약" : "통계 기반 요약 (AI 미연결)") + ` · ${s.generated_at}`;
  } else { $("summary").textContent = "요약을 불러오지 못했어요."; aiAt = 0; }
}

// ---------------------------------------------------------------- 갱신 루프
async function refresh() {
  const st = $("status");
  try {
    const [complaints, prio, env] = await Promise.all([get("/api/complaints?limit=2000"), get("/api/priority?limit=300"), safe(get("/api/env"))]);
    if (!state.meta) state.meta = await safe(get("/api/meta"));
    state.complaints = complaints; state.prio = prio;
    renderEnv(env); renderTop3(prio); renderPrioTable(prio); redrawMap(); drawQuadrant(prio); renderComplaints();
    st.className = "status ok"; st.textContent = "● 실시간 · 10초마다 갱신";
    loadAI();
  } catch (e) {
    st.className = "status err"; st.textContent = "● 백엔드에 연결할 수 없어요";
  }
}
renderChips();
refresh().then(initNaver);
setInterval(refresh, REFRESH_MS);
addEventListener("resize", () => state.prio.length && mapMode === "grid" && drawZoneMap(state.prio, state.complaints));
