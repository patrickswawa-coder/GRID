// GRID 공무원 대시보드 (Streamlit 대시보드를 대체). 빌드 도구 없음. 데이터는 API로만 가져온다.
import { TYPE_BY_CODE, TYPES } from "../js/types.js";
import { loadMap } from "../js/map.js";
import { computeHeat, meanHeat, heatLevel } from "../js/heat.js";

const API = window.GRID_API || "";
const REFRESH_MS = 10000;
const URGENCY = { 3: "높음", 2: "보통", 1: "낮음" };
const C = { ink: "#17324a", mute: "#5d7183", line: "#d6e2ea", fix: "#0b8f84", report: "#7a6ad8", heat: "#e5482d" };
const FONT = '"Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const isReport = (code) => TYPE_BY_CODE[code]?.group === "report";
const HEAT_STOPS = [[0, [47, 158, 68]], [35, [148, 216, 45]], [55, [252, 216, 60]], [70, [252, 160, 30]], [85, [240, 80, 40]], [100, [190, 25, 45]]];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tLabel = (c) => { const t = TYPE_BY_CODE[c]; return t ? `${t.icon} ${t.label}` : c; };

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
async function getAdm(path) {
  const r = await fetch(API + path, { cache: "no-store", headers: { "X-Admin-Token": admin.token } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const STATUS = { received: "접수", working: "처리중", done: "처리 완료" };
let state = { complaints: [], flagged: [], prio: [], meta: null, map: null, heat: null, env: null, hot: null, labels: [], filter: new Set(), sfilter: "" };

// ---------------------------------------------------------------- 관리자 (로그인·상태 변경·삭제)
const admin = { required: false, token: (() => { try { return sessionStorage.getItem("grid-admin") || ""; } catch { return ""; } })() };
const canAdmin = () => !admin.required || !!admin.token;
function setToken(t) { admin.token = t; try { t ? sessionStorage.setItem("grid-admin", t) : sessionStorage.removeItem("grid-admin"); } catch {} updateAdminUI(); }
function updateAdminUI() {
  $("btn-login").hidden = !admin.required;
  $("btn-login").querySelector("span").textContent = admin.token ? "로그아웃" : "관리자 로그인";
  $("btn-backup").hidden = !canAdmin();
  renderComplaints();
}
async function initAdmin() {
  const a = await safe(get("/api/admin/auth"));
  admin.required = !!a?.required;
  if (admin.required && admin.token) { // 저장된 토큰이 아직 유효한지
    const r = await fetch(API + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: admin.token }) });
    if (!r.ok) setToken("");
  }
  updateAdminUI();
}
$("btn-login").onclick = async () => {
  if (admin.token) return setToken("");
  const pw = prompt("관리자 비밀번호");
  if (!pw) return;
  const r = await fetch(API + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
  r.ok ? setToken(pw) : alert("비밀번호가 맞지 않아요.");
};
async function act(path, method, body) {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", "X-Admin-Token": admin.token }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { setToken(""); alert("관리자 로그인이 필요해요. 위의 '관리자 로그인'을 눌러 주세요."); throw new Error("401"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { alert(data.detail || "처리하지 못했어요."); throw new Error(String(r.status)); }
  return data;
}
$("btn-backup").onclick = async () => {
  const r = await fetch(API + "/api/admin/backup", { headers: { "X-Admin-Token": admin.token } });
  if (!r.ok) return alert("백업에 실패했어요.");
  const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob());
  a.download = `grid-backup-${stamp()}.db`; a.click(); URL.revokeObjectURL(a.href);
};

// ---------------------------------------------------------------- QR
function setQr() {
  const u = $("qrurl").value.trim();
  $("qrwarn").hidden = !/localhost|127\.0\.0\.1/.test(u);
  if (/^https?:\/\//.test(u)) $("qrimg").src = API + "/api/qr?url=" + encodeURIComponent(u);
}
$("btn-qr").onclick = () => { if (!$("qrurl").value) $("qrurl").value = location.origin + "/"; setQr(); $("qrdlg").showModal(); };
$("qrurl").oninput = setQr;
$("qrclose").onclick = () => $("qrdlg").close();
$("qrprint").onclick = () => print();

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

// ---------------------------------------------------------------- 한눈에 보기
function renderKpis(env) {
  const w = env?.weather || {}, a = env?.air || {}, all = state.complaints;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const k = (label, val, unit, sub, cls = "") => `<div class="kpi ${cls}"><span>${label}</span><b>${val}${unit ? `<small>${unit}</small>` : ""}</b><em>${esc(sub || "")}</em></div>`;
  const avg = state.heat ? Math.round(meanHeat(state.heat)) : null;
  const hot = state.heat ? (state.heat.value.reduce((n, v) => n + (v >= 70), 0) * ((state.map.meta.cell || 5) ** 2)) / 10000 : null;
  const done = all.filter((c) => c.status === "done").length;
  $("kpis").innerHTML =
    k("무실동 평균 열섬 지수", avg ?? "-", "", avg != null ? `${heatLevel(avg).text} · 0 시원함 ~ 100 뜨거움` : "", "heat") +
    k("열섬 지수 70 이상 면적", hot != null ? hot.toFixed(1) : "-", "ha", "여름철 열이 많이 쌓이는 곳") +
    k("시민 제안·신고", all.length, "건", `오늘 ${all.filter((c) => c.created_at.slice(0, 10) === today).length}건 접수`) +
    k("처리 완료", all.length ? Math.round((done / all.length) * 100) : 0, "%", `${done}건 완료 · ${all.filter((c) => c.status === "working").length}건 처리중`) +
    k("지금 기온", w.temp != null ? w.temp.toFixed(1) : "-", w.temp != null ? "°C" : "", w.humidity != null ? `습도 ${Math.round(w.humidity)}%` : "실시간 데이터 연결 전") +
    k("초미세먼지", a.pm25 != null ? Math.round(a.pm25) : "-", a.pm25 != null ? "㎍/㎥" : "", a.pm25_grade || a.grade || "실시간 데이터 연결 전");
  $("env-note").textContent = (w.temp != null || a.pm25 != null)
    ? `열섬 지수: 브이월드 건물·지적도 + Landsat 위성 지표온도 보정 · 기온: 기상청 초단기실황 · 대기질: 에어코리아 ${a.station || ""} 측정소 ${env.updated_at || ""}`
    : "열섬 지수: 브이월드 건물·지적도 + Landsat 위성 지표온도 보정 · 실시간 기온·대기질은 서버에 공공데이터 키를 넣으면 표시돼요.";
}

// ---------------------------------------------------------------- 우선 개선 구역
function renderTop5(pr) {
  const top = pr.filter((z) => z.rank <= 5);
  if (!top.length) { $("top5").innerHTML = `<li class="rank-empty">구역 데이터를 불러오는 중이에요.</li>`; return; }
  $("top5").innerHTML = top.map((z) => {
    const want = z.top_type ? tLabel(z.top_type) : "아직 제안 없음";
    return `<li data-zone="${esc(z.zone)}" class="${state.hot === z.zone ? "on" : ""}">
      <span class="no">${z.rank}</span><span class="nm">${esc(z.name)}</span>
      <span class="hv"><b style="background:${heatCss(z.heat)}">${Math.round(z.heat)}</b><span>${z.delta > 0 ? `실현 시 −${z.delta.toFixed(1)}` : "열섬 지수"}</span></span>
      <span class="meta">제안 <b>${z.proposals}</b> · 신고 <b>${z.reports}</b> · 공감 <b>${z.likes}</b> · ${esc(want)}</span></li>`;
  }).join("");
}
function setHot(zone) {
  if (state.hot === zone) return;
  state.hot = zone;
  document.querySelectorAll("#top5 li").forEach((li) => li.classList.toggle("on", li.dataset.zone === zone));
  if (mapMode === "grid") drawZoneMap(state.prio, state.complaints);
}
$("top5").addEventListener("mouseover", (e) => { const li = e.target.closest("li[data-zone]"); if (li) setHot(li.dataset.zone); });
$("top5").addEventListener("mouseleave", () => setHot(null));

function renderPrioTable(pr) {
  const head = ["순위", "구역", "점수", "열섬 평균", "실현 시 평균", "열섬(상위10%)", "제안", "신고", "공감"];
  const rows = pr.slice(0, 15).map((z) => [z.rank, z.name, z.score, z.heat, z.heat_after, z.heat_p90, z.proposals, z.reports, z.likes]);
  $("prio-tbl").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i >= 2 ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("");
  $("dl-prio").onclick = () => download(`grid_우선개선구역_${stamp()}.csv`, csv([head, ...rows]));
}

// 열섬 지도: 5m 칸마다 열섬 색(시민 화면과 같은 계산) + 건물 자리 + 우선 구역 테두리 + 제안·신고 점
let heatImg = null, mapGeo = null;
function buildHeatImage() {
  const { width: W, depth: D } = state.map.meta, v = state.heat.value, H = state.map.heights;
  heatImg = document.createElement("canvas"); heatImg.width = W; heatImg.height = D;
  const g = heatImg.getContext("2d"), im = g.createImageData(W, D);
  for (let i = 0; i < W * D; i++) {
    const [r, gg, b] = heatRGB(v[i]), k = H[i] ? 0.8 : 1; // 건물 자리는 조금 어둡게 → 동네 모양이 보인다
    im.data[i * 4] = r * k; im.data[i * 4 + 1] = gg * k; im.data[i * 4 + 2] = b * k; im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
}
function drawZoneMap(pr, complaints) {
  const cv = $("zmap"), m = state.map?.meta || state.meta;
  if (!m) return;
  const W = cv.clientWidth || 560, sc = W / m.width, H = Math.round(m.depth * sc);
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px"; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  mapGeo = { sc, W, H };
  const s = m.zone_size || 40, zs = s * sc;
  const zxy = (z) => [(z.zone.charCodeAt(0) - 65) * zs, (parseInt(z.zone.slice(1), 10) - 1) * zs];
  if (heatImg) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(heatImg, 0, 0, W, H); }
  else for (const z of pr) { const [x, y] = zxy(z); g.fillStyle = heatCss(z.heat, 0.9); g.fillRect(x, y, zs, zs); } // 지도 파일을 못 읽었을 때: 구역 평균색
  // 제안·신고 점
  for (const c of complaints) {
    const x = (c.x + 0.5) * sc, y = (c.z + 0.5) * sc;
    g.globalAlpha = c.status === "done" ? 0.45 : 1;
    g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fillStyle = isReport(c.type) ? C.report : C.fix; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = "#fff"; g.stroke(); g.globalAlpha = 1;
  }
  // 주요 장소 이름 (방향을 잡기 쉽게)
  g.font = `600 11.5px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  const used = [];
  for (const l of state.labels) {
    const tw = g.measureText(l.name).width / 2 + 4;
    const x = Math.max(tw, Math.min(W - tw, (l.x + 0.5) * sc)), y = Math.max(12, Math.min(H - 10, (l.z + 0.5) * sc));
    if (used.some((u) => Math.abs(u.x - x) < u.tw + tw && Math.abs(u.y - y) < 16)) continue; // 겹치면 덜 중요한 이름은 생략
    used.push({ x, y, tw });
    g.lineWidth = 3.5; g.strokeStyle = "rgba(255,255,255,.92)"; g.strokeText(l.name, x, y);
    g.fillStyle = C.ink; g.fillText(l.name, x, y);
  }
  // 우선 구역 5곳: 테두리 + 순위
  g.font = `700 11px "Galmuri11", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const z of pr.filter((q) => q.rank <= 5 || q.zone === state.hot).sort((a, b) => b.rank - a.rank)) {
    const [x, y] = zxy(z), on = z.zone === state.hot;
    const w = Math.min(zs, W - x), h = Math.min(zs, H - y);
    g.lineWidth = on ? 6 : 4; g.strokeStyle = "#fff"; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.lineWidth = on ? 3 : 2; g.strokeStyle = C.ink; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    if (z.rank <= 5) {
      g.fillStyle = C.ink; g.beginPath(); g.roundRect(x - 1, y - 1, 20, 20, 5); g.fill();
      g.fillStyle = "#fff"; g.fillText(z.rank, x + 9, y + 9.5);
    }
  }
}
function zoneAt(cx, cz) {
  const s = state.meta?.zone_size || 40;
  const code = String.fromCharCode(65 + Math.floor(cx / s)) + (Math.floor(cz / s) + 1);
  return state.prio.find((z) => z.zone === code);
}
$("zmap").addEventListener("mousemove", (e) => {
  const tip = $("tip");
  if (!mapGeo) return;
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const cx = Math.floor(x / mapGeo.sc), cz = Math.floor(y / mapGeo.sc), m = state.map?.meta;
  const z = zoneAt(cx, cz);
  if (!z) { tip.style.display = "none"; setHot(null); return; }
  const here = m && state.heat && cx >= 0 && cz >= 0 && cx < m.width && cz < m.depth ? Math.round(state.heat.value[cz * m.width + cx]) : null;
  tip.innerHTML = `<b>${esc(z.name)}</b>${z.rank <= 15 ? ` <i>${z.rank}위</i>` : ""}<br>` +
    (here != null ? `이 지점 열섬 지수 ${here} <i>· 구역 평균 ${Math.round(z.heat)}</i><br>` : `구역 평균 열섬 지수 ${Math.round(z.heat)}<br>`) +
    `제안 ${z.proposals} · 신고 ${z.reports} · 공감 ${z.likes}`;
  tip.style.display = "block";
  tip.style.left = Math.max(0, Math.min(x + 14, r.width - tip.offsetWidth - 4)) + "px";
  tip.style.top = (y + 16 + tip.offsetHeight > r.height ? y - tip.offsetHeight - 10 : y + 16) + "px";
  setHot(z.zone);
});
$("zmap").addEventListener("mouseleave", () => { $("tip").style.display = "none"; setHot(null); });

// 차트 공통 (ECharts)
const charts = {};
function chart(id) {
  if (!window.echarts) return null;
  return (charts[id] ||= echarts.init($(id), null, { renderer: "svg" }));
}
function emptyChart(id, msg) {
  if (charts[id]) { charts[id].dispose(); delete charts[id]; }
  $(id).innerHTML = `<div class="chart-empty">${msg}</div>`;
}
const TIP = { backgroundColor: C.ink, borderWidth: 0, padding: [8, 11], textStyle: { color: "#fff", fontFamily: FONT, fontSize: 12.5 }, extraCssText: "border-radius:10px;box-shadow:0 6px 18px rgba(23,50,74,.3)" };
const AXIS = { axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: { color: C.mute, fontFamily: FONT, fontSize: 11.5 },
  splitLine: { lineStyle: { color: "#e9f0f4" } }, nameTextStyle: { color: C.mute, fontFamily: FONT, fontSize: 12 } };

// 열섬 × 시민 요구: 시가지 구역만. 순위 5위까지는 진하게 + 이름
function drawQuadrant(pr) {
  const q = pr.filter((z) => z.built > 0.02).map((z) => ({ ...z, demand: z.proposals + z.reports + z.likes / 2 }));
  if (!q.length) return emptyChart("quad", "구역 데이터를 불러오는 중이에요.");
  if ($("quad").querySelector(".chart-empty")) $("quad").innerHTML = "";
  const ch = chart("quad"); if (!ch) return;
  const pt = (z) => ({ value: [z.heat, z.demand], z });
  // 이름표가 서로 겹치지 않게: 오른쪽 끝 점들은 위·아래로, 나머지는 왼쪽·오른쪽으로 번갈아
  const top = q.filter((z) => z.rank <= 5).sort((a, b) => a.heat - b.heat);
  let nEdge = 0, nMid = 0;
  const topPts = top.map((z) => ({ ...pt(z), label: { position: z.heat > 78 ? (nEdge++ % 2 ? "bottom" : "top") : (nMid++ % 2 ? "right" : "left") } }));
  ch.setOption({
    animation: false, textStyle: { fontFamily: FONT },
    grid: { left: 44, right: 44, top: 16, bottom: 44 },
    tooltip: { ...TIP, trigger: "item", formatter: (p) => { const z = p.data.z; return `<b>${esc(z.name)}</b>${z.rank <= 15 ? ` ${z.rank}위` : ""}<br>열섬 지수 ${Math.round(z.heat)}<br>제안 ${z.proposals} · 신고 ${z.reports} · 공감 ${z.likes}`; } },
    xAxis: { ...AXIS, type: "value", min: 0, max: 100, name: "구역 평균 열섬 지수", nameLocation: "middle", nameGap: 28 },
    yAxis: { ...AXIS, type: "value", min: 0, minInterval: 1, name: "시민 요구", nameLocation: "middle", nameGap: 28, axisLine: { show: false } },
    series: [
      { type: "scatter", symbolSize: 9, itemStyle: { color: "#9db0be", opacity: 0.75, borderColor: "#fff", borderWidth: 1 }, data: q.filter((z) => z.rank > 5).map(pt),
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: "#b5c2cc", type: [4, 4], width: 1 }, data: [{ xAxis: 70 }] } },
      { type: "scatter", symbolSize: 14, itemStyle: { color: C.heat, borderColor: "#fff", borderWidth: 2 }, data: topPts,
        label: { show: true, formatter: (p) => `${p.data.z.rank}. ${p.data.z.name.replace(" 주변", "")}`, distance: 7, color: C.ink, fontFamily: FONT, fontSize: 12, fontWeight: 600,
          textBorderColor: "#fff", textBorderWidth: 3 } },
    ],
  }, true);
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
  naverReady = true; $("mapmode").hidden = false; // 기본은 열섬 지도, 네이버 지도는 눌러서 전환
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
  const medal = ["1위", "2위", "3위"];
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
    const dot = new N.Circle({ map: nmap, center: new N.LatLng(c.lat, c.lng), radius: 7, fillColor: isReport(c.type) ? C.report : C.fix, fillOpacity: 1,
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
// 장난·부적절 거르기: moderation 'review'(자동으로 걸림)·'hidden'(관리자가 숨김)은 시민 지도·통계에서 빠진다.
// 관리자 화면에서도 기본 목록·차트에서는 빼고, '확인 필요' 칩을 눌렀을 때만 따로 보여준다.
const isPublic = (c) => !c.moderation || c.moderation === "ok";
const MOD = { review: "확인 필요", hidden: "숨김" };
function filtered() {
  if (state.sfilter === "review") return state.flagged;
  return state.complaints.filter((c) => (!state.filter.size || state.filter.has(c.type)) && (!state.sfilter || c.status === state.sfilter));
}
function renderSChips() {
  const pub = state.complaints, nHid = state.flagged.length;
  const n = (k) => pub.filter((c) => !k || c.status === k).length;
  $("schips").innerHTML = [["", "전체"], ...Object.entries(STATUS)].map(([k, l]) =>
    `<button type="button" class="chip" data-s="${k}" aria-pressed="${state.sfilter === k}">${l} ${n(k)}</button>`).join("") +
    (nHid ? `<button type="button" class="chip chip-review" data-s="review" aria-pressed="${state.sfilter === "review"}">확인 필요 ${nHid}</button>` : "");
}
$("schips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  state.sfilter = b.dataset.s; renderComplaints();
});

function renderChips() {
  $("chips").innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-t="${t.code}" aria-pressed="${state.filter.has(t.code)}">${t.icon} ${esc(t.label)}</button>`).join("");
}
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  const t = b.dataset.t; state.filter.has(t) ? state.filter.delete(t) : state.filter.add(t);
  renderChips(); renderComplaints();
});

function renderComplaints() {
  renderSChips();
  const all = state.complaints, df = filtered(), zn = Object.fromEntries(state.prio.map((z) => [z.zone, z.name]));
  // 처리 현황 (전체 기준)
  const nS = (k) => all.filter((c) => c.status === k).length;
  $("progress").innerHTML = all.length
    ? `<div class="prog" role="img" aria-label="처리 현황">${Object.keys(STATUS).map((k) => `<i class="${k}" style="flex:${nS(k)}" title="${STATUS[k]} ${nS(k)}건"></i>`).join("")}</div>
       <div class="prog-key">${Object.entries(STATUS).map(([k, l]) => `<span><i class="${k}"></i>${l} <b>${nS(k)}</b></span>`).join("")}</div>`
    : `<p class="cap">아직 접수된 제안이 없어요.</p>`;

  if (!df.length) {
    emptyChart("bytype", all.length ? "선택한 조건에 맞는 제안이 없어요." : "아직 접수된 제안이 없어요.<br>시민 지도에서 첫 제안을 등록해 보세요.");
    $("topzones").innerHTML = ""; $("list").innerHTML = `<tr><td class="list-empty">${all.length ? "선택한 조건에 맞는 제안이 없어요." : "아직 접수된 제안이 없어요."}</td></tr>`;
    $("updated").textContent = ""; return;
  }
  const cnt = (k) => df.reduce((m, c) => ((m[k(c)] = (m[k(c)] || 0) + 1), m), {});
  const byType = Object.entries(cnt((c) => c.type)).sort((a, b) => b[1] - a[1]);
  const byZone = Object.entries(cnt((c) => c.zone)).sort((a, b) => b[1] - a[1]);

  if ($("bytype").querySelector(".chart-empty")) $("bytype").innerHTML = ""; // 빈 안내를 지운 뒤에 차트를 만든다
  const ch = chart("bytype");
  if (ch) {
    const rows = [...byType].reverse();
    ch.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      grid: { left: 8, right: 34, top: 6, bottom: 6, containLabel: true },
      tooltip: { ...TIP, trigger: "item", formatter: (p) => `<b>${esc(tLabel(p.name))}</b><br>${isReport(p.name) ? "불편 신고" : "개선 제안"} ${p.value}건` },
      xAxis: { type: "value", show: false },
      yAxis: { type: "category", data: rows.map(([t]) => t), axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.ink, fontFamily: FONT, fontSize: 12.5, formatter: (t) => tLabel(t) } },
      series: [{ type: "bar", barWidth: 14, barCategoryGap: "40%",
        data: rows.map(([t, n]) => ({ value: n, itemStyle: { color: isReport(t) ? C.report : C.fix, borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: "right", color: C.ink, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 } }],
    }, true);
  }

  const zrows = byZone.map(([z, n]) => {
    const zs = df.filter((c) => c.zone === z);
    const likes = zs.reduce((s, c) => s + c.likes, 0);
    const top = Object.entries(zs.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0];
    return { z, n, likes, top };
  }).sort((a, b) => b.n - a.n || b.likes - a.likes).slice(0, 4);
  $("topzones").innerHTML = `<tr><th>구역</th><th class="num">건수</th><th class="num">공감</th><th>주요 요청</th></tr>` +
    zrows.map((r) => `<tr><td>${esc((zn[r.z] || r.z).replace(" 주변", ""))}</td><td class="num">${r.n}</td><td class="num">${r.likes}</td><td>${esc(tLabel(r.top))}</td></tr>`).join("");

  const head = ["번호", "유형", "구역", "내용", "공감", "AI 긴급도", "상태", "접수 시각", "답변"];
  const sorted = [...df].sort((a, b) => b.likes - a.likes || b.id - a.id);
  const csvRows = sorted.map((c) => [c.id, tLabel(c.type), zn[c.zone] || c.zone, c.text, c.likes, URGENCY[c.ai_urgency] || "", STATUS[c.status] || c.status, c.created_at.replace("T", " ").slice(0, 19), c.reply || ""]);
  const adm = canAdmin();
  const opts = (cur) => Object.entries(STATUS).map(([k, l]) => `<option value="${k}"${k === cur ? " selected" : ""}>${l}</option>`).join("");
  const modHtml = (c) => isPublic(c) ? "" : `<span class="mod">${MOD[c.moderation] || c.moderation}${c.mod_reason ? ` · ${esc(c.mod_reason)}` : ""}</span>`;
  const rowHtml = (c) => `<tr data-id="${c.id}"${isPublic(c) ? "" : ` class="is-hidden"`}><td class="num">${c.id}</td><td>${esc(tLabel(c.type))}</td><td>${esc((zn[c.zone] || c.zone).replace(" 주변", ""))}</td>
    <td class="wrap">${modHtml(c)}${esc(c.text)}${c.reply ? `<span class="reply">${esc(c.reply)}</span>` : ""}</td><td class="num">${c.likes}</td>
    <td>${URGENCY[c.ai_urgency] ? `<span class="urg u${c.ai_urgency}">${URGENCY[c.ai_urgency]}</span>` : ""}</td>
    <td>${adm ? `<select class="st" aria-label="처리 상태">${opts(c.status)}</select>` : `<span class="badge ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>`}</td>
    <td>${esc(c.created_at.replace("T", " ").slice(5, 16))}</td>
    <td>${adm ? `<button class="mini" data-a="reply" type="button">답변</button>${isPublic(c)
      ? `<button class="mini" data-a="hide" type="button" title="시민 지도·통계에서 숨겨요 (삭제 아님)">숨기기</button>`
      : `<button class="mini ok" data-a="show" type="button" title="문제없으면 다시 공개해요">보이기</button>`}<button class="mini del" data-a="del" type="button">삭제</button>` : ""}</td></tr>`;
  const shown = ["번호", "유형", "구역", "내용", "공감", "AI 긴급도", "상태", "접수", adm ? "관리" : ""];
  $("list").innerHTML = `<tr>${shown.map((h, i) => `<th class="${i === 0 || i === 4 ? "num" : ""}">${h}</th>`).join("")}</tr>` + sorted.slice(0, 300).map(rowHtml).join("");
  const rows = csvRows;
  $("dl-list").onclick = () => download(`grid_민원_${stamp()}.csv`, csv([head, ...rows]));
  $("updated").textContent = `공감 많은 순 · 마지막 갱신 ${new Date().toLocaleTimeString("ko-KR")}` + (rows.length > 300 ? ` · 화면에는 300건까지, CSV는 전체 ${rows.length}건` : "");
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
    $("policy-cap").textContent = p.ai ? "AI 분석 · Amazon Bedrock" : "규칙 기반";
  } else { $("policy").textContent = "정책 제안을 불러오지 못했어요."; aiAt = 0; }
  if (s) {
    $("summary").textContent = s.summary;
    $("summary-cap").textContent = s.ai ? "AI" : "통계 기반";
  } else { $("summary").textContent = "요약을 불러오지 못했어요."; aiAt = 0; }
}

$("list").addEventListener("change", async (e) => {
  const sel = e.target.closest("select.st"); if (!sel) return;
  const id = +sel.closest("tr").dataset.id;
  try { await act(`/api/complaints/${id}`, "PATCH", { status: sel.value }); } catch {}
  sel.blur(); refresh();
});
$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-a]"); if (!btn) return;
  const id = +btn.closest("tr").dataset.id, c = [...state.complaints, ...state.flagged].find((x) => x.id === id);
  try {
    if (btn.dataset.a === "hide" || btn.dataset.a === "show") {
      await act(`/api/complaints/${id}`, "PATCH", { moderation: btn.dataset.a === "hide" ? "hidden" : "ok" });
    } else if (btn.dataset.a === "del") {
      if (!confirm(`#${id} 민원을 삭제할까요?\n"${c?.text ?? ""}"\n삭제하면 되돌릴 수 없어요.`)) return;
      await act(`/api/complaints/${id}`, "DELETE");
    } else {
      const r = prompt("시민에게 보여줄 처리 안내 (300자까지, 비우면 삭제)", c?.reply || "");
      if (r === null) return;
      await act(`/api/complaints/${id}`, "PATCH", { reply: r });
    }
  } catch { return; }
  refresh();
});

// ---------------------------------------------------------------- 갱신 루프
async function refresh() {
  const st = $("status");
  try {
    // 관리자로 로그인했으면 숨김·확인 필요 민원까지 받는다 (토큰이 틀리면 서버가 공개 민원만 준다)
    const list = canAdmin() ? getAdm("/api/complaints?limit=2000&all=1") : get("/api/complaints?limit=2000");
    const [complaints, prio, env] = await Promise.all([list, get("/api/priority?limit=300"), safe(get("/api/env"))]);
    if (!state.meta) state.meta = await safe(get("/api/meta"));
    // 지도·KPI·차트는 공개 민원만, 숨김·확인 필요는 따로 (목록의 '확인 필요' 칩)
    state.complaints = complaints.filter(isPublic); state.flagged = complaints.filter((c) => !isPublic(c));
    if (!state.flagged.length && state.sfilter === "review") state.sfilter = "";
    state.prio = prio; state.env = env;
    renderKpis(env); renderTop5(prio); renderPrioTable(prio); redrawMap(); drawQuadrant(prio);
    if (!document.activeElement?.matches?.("select.st")) renderComplaints(); else renderSChips();
    st.className = "status ok"; st.textContent = "실시간 · 10초마다 갱신";
    loadAI();
  } catch (e) {
    st.className = "status err"; st.textContent = "서버에 연결할 수 없어요";
  }
}
// ---------------------------------------------------------------- 근거: 위성 표면온도 비교
// web/data/lst_compare.json (data/export_lst.py 로 만듦). 없으면 docs/HEAT.md 에 적힌 보정 결과로 숫자·막대만 보여준다.
const LST_FALLBACK = {
  scenes: ["2023-06-17", "2024-06-03", "2024-06-11", "2024-08-14", "2025-06-22"], r100: 0.88, slope10: 1.3, points: null,
  types: [{ name: "저층 건물", dT: 4.1 }, { name: "중층 건물", dT: 4.5 }, { name: "고층 건물(40m+)", dT: 2.8 }, { name: "차도", dT: 2.6 },
          { name: "인도·대지", dT: 3.3 }, { name: "공원·숲", dT: -3.3 }, { name: "잔디·밭", dT: 0.1 }, { name: "하천", dT: 0.4 }],
};
async function initLst() {
  const d = (await safe(fetch("../data/lst_compare.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())))) || LST_FALLBACK;
  $("lst-r").textContent = d.r100.toFixed(2);
  $("lst-k").textContent = `${d.slope10.toFixed(1)}°C`;
  $("lst-n").textContent = `${d.scenes.length}장면`;
  $("lst-dates").textContent = `Landsat 여름 장면 (${d.scenes[0].slice(0, 4)}~${d.scenes.at(-1).slice(0, 4)})`;
  $("lst-dates").title = d.scenes.join(", ");
  $("lst-src").textContent = "Landsat 8·9";

  if (!d.points?.length) emptyChart("lst-scatter", "구역별 비교 그림은 위성 자료를 받으면 표시돼요.<br>(서버에서 data/export_lst.py 실행)");
  else {
    const ch = chart("lst-scatter");
    const line = [0, 100].map((x) => [x, d.intercept + (d.slope10 / 10) * x]);
    ch?.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      grid: { left: 50, right: 16, top: 16, bottom: 44 },
      tooltip: { ...TIP, trigger: "item", formatter: (p) => p.seriesIndex ? "" : `열섬 지수 ${p.value[0]}<br>위성 표면온도 ${p.value[1] >= 0 ? "+" : ""}${p.value[1].toFixed(1)}°C` },
      xAxis: { ...AXIS, type: "value", min: 0, max: 100, name: "열섬 지수 (100m 구역 평균)", nameLocation: "middle", nameGap: 28 },
      yAxis: { ...AXIS, type: "value", name: "위성 표면온도, 동네 평균 대비 (°C)", nameLocation: "middle", nameGap: 34, axisLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: (v) => (v > 0 ? "+" : "") + v } },
      series: [
        { type: "scatter", symbolSize: 6, itemStyle: { color: C.ink, opacity: 0.35 }, data: d.points },
        { type: "line", data: line, symbol: "none", silent: true, lineStyle: { color: C.heat, width: 2 },
          endLabel: { show: true, formatter: `r = ${d.r100.toFixed(2)}`, color: C.heat, fontFamily: FONT, fontWeight: 700, fontSize: 12.5, offset: [-60, -12] } },
      ],
    }, true);
  }

  const rows = [...d.types].sort((a, b) => a.dT - b.dT);
  const lim = Math.ceil(Math.max(...rows.map((t) => Math.abs(t.dT))) + 1);
  chart("lst-types")?.setOption({
    animation: false, textStyle: { fontFamily: FONT },
    grid: { left: 8, right: 8, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...TIP, trigger: "item", formatter: (p) => `<b>${esc(p.name)}</b><br>무실동 평균보다 ${p.value >= 0 ? "+" : ""}${p.value.toFixed(1)}°C` },
    xAxis: { type: "value", min: -lim, max: lim, show: false },
    yAxis: { type: "category", data: rows.map((t) => t.name), axisLine: { onZero: false, show: false }, axisTick: { show: false },
      axisLabel: { color: C.ink, fontFamily: FONT, fontSize: 12.5 } },
    series: [{ type: "bar", barWidth: 12,
      data: rows.map((t) => ({ value: t.dT, itemStyle: { color: t.dT >= 0 ? C.heat : C.fix, borderRadius: t.dT >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] },
        label: { position: t.dT >= 0 ? "right" : "left" } })),
      label: { show: true, color: C.ink, fontFamily: FONT, fontSize: 12, fontWeight: 600, formatter: (p) => `${p.value >= 0 ? "+" : ""}${p.value.toFixed(1)}°C` } }],
  }, true);
}

// 5m 열섬 지도: 시민 화면과 같은 지도 파일·같은 계산을 쓴다 (못 읽으면 구역 평균색으로 대신 그림)
async function initHeat() {
  try {
    state.map = await loadMap("../data/voxels.json");
    state.heat = computeHeat(state.map);
    buildHeatImage();
    const ls = await safe(fetch("../data/labels.json").then((r) => r.json()));
    state.labels = (Array.isArray(ls) ? ls : []).filter((l) => l.rank < 10);
    if (state.prio.length) { redrawMap(); renderKpis(state.env); }
  } catch (e) { console.warn("[GRID] 열섬 지도를 만들지 못했어요", e); }
}
renderChips();
initAdmin().then(refresh).then(initNaver);
initHeat();
initLst();
setInterval(refresh, REFRESH_MS);
addEventListener("resize", () => {
  if (state.prio.length && mapMode === "grid") drawZoneMap(state.prio, state.complaints);
  Object.values(charts).forEach((c) => c.resize());
});
