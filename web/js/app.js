// 시민용 화면: 지도 탭 → 유형 선택 → 의견 입력 → 등록, 다른 민원 보기·공감
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { loadMap, buildScene, heightAt, cellToLatLng, zoneOf } from "./map.js";
import { makeMarker } from "./markers.js";
import { loadLabels } from "./labels.js";
import { computeHeat, paintHeat, heatLevel, zoneHeat, scoreAt, buildMods, meanHeat, heatRGB } from "./heat.js";
import { TYPES, TYPE_BY_CODE, FIX_TYPES, REPORT_TYPES } from "./types.js";

const API = window.GRID_API || ""; // 같은 서버면 빈 문자열
const POLL_MS = 8000;
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- 3D 기본
const canvas = $("#view");
const MOBILE = matchMedia("(pointer: coarse)").matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// 화질: 기본은 기기 해상도의 최대 2배 (아이폰 3배 화면도 2배면 충분히 선명). ?hd 면 기기 최대, ?low 면 1배
const QS = new URLSearchParams(location.search);
const MAX_DPR = QS.has("hd") ? devicePixelRatio : QS.has("low") ? 1 : Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(MAX_DPR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = skyTexture();
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x7a8f6a, 1.45));
const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 2048 : 4096, MOBILE ? 2048 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

function skyTexture() {
  const cv = document.createElement("canvas");
  cv.width = 2; cv.height = 256;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#7fb8e6");
  grad.addColorStop(0.6, "#c4e2f5");
  grad.addColorStop(1, "#eaf4f8");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 해는 남서쪽 하늘. 지도 전체를 덮도록 그림자 범위 설정
function placeSun(W, D) {
  const cx = W / 2, cz = D / 2, R = Math.max(W, D) * 0.75;
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx - R * 0.55, R * 1.1, cz + R * 0.45);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -R;
  cam.right = cam.top = R;
  cam.near = 1;
  cam.far = R * 4;
  cam.updateProjectionMatrix();
}

const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = 1.3;
controls.minDistance = 6;
controls.zoomToCursor = true;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- 상태
let map, world, labels, heat, heatOn = false;
let simOn = false, heatSim = null, baseAvg = 0, lastEnv = null;
const hiddenTypes = new Set();
const markers = new Map(); // id → { obj, data }
const markerRoot = new THREE.Group();
scene.add(markerRoot);
let lastId = 0;
let selected = null; // { x, z }
let chosenType = null;
let ghost = null;
let focusTo = null; // 카메라가 이동할 목표 지점
const perf = { n: 0, t0: 0, done: false }; // 성능 측정

const cursor = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.06, 1.06, 1.06).translate(0, 0.53, 0)),
  new THREE.LineBasicMaterial({ color: 0xffd43b, depthTest: false })
);
cursor.renderOrder = 20;
cursor.visible = false;
scene.add(cursor);

// 개선 제안의 영향 범위(정사각형) 미리보기
const footprint = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x40c057, transparent: true, opacity: 0.35, depthWrite: false })
);
footprint.renderOrder = 4;
footprint.visible = false;
scene.add(footprint);

// ---------------------------------------------------------------- 시작
async function start() {
  try {
    map = await loadMap("data/voxels.json");
  } catch (e) {
    toast(e.message, 6000);
    return;
  }
  world = buildScene(map);
  scene.add(world.group);
  labels = await loadLabels("data/labels.json");
  scene.add(labels.group);
  heat = computeHeat(map);
  baseAvg = meanHeat(heat);
  const zh = Object.entries(zoneHeat(map, heat)).sort((p, q) => q[1] - p[1]);
  $("#heatAvg").textContent = Math.round(baseAvg);
  $("#heatTop").textContent = `${nearestLabel(zh[0][0])} (${zh[0][1]})`;
  if (new URLSearchParams(location.search).has("heat")) setHeat(true);
  loadEnv();
  setInterval(loadEnv, 10 * 60 * 1000);
  const { width: W, depth: D } = map.meta;
  $("#place").textContent = map.meta.name;
  controls.target.set(W / 2, 0, D / 2);
  camera.position.set(W / 2 + W * 0.35, Math.max(W, D) * 0.45, D / 2 + D * 0.55);
  controls.maxDistance = Math.max(W, D) * 1.3;
  camera.far = Math.max(W, D) * 4;
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0xd6ebf5, Math.max(W, D) * 0.9, Math.max(W, D) * 2.2);
  placeSun(W, D);
  buildTypeButtons();
  await poll();
  setInterval(poll, POLL_MS);
  $("#loading").remove();
  let seen = false;
  try { seen = localStorage.getItem("grid-intro") === "1"; } catch {}
  if (!seen && !new URLSearchParams(location.search).has("demo")) $("#intro").hidden = false;
  else toast("바꾸고 싶은 위치를 눌러 주세요 👆", 3500);
}

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  if (map) {
    // 지도 밖으로 너무 나가지 않게
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, 0, map.meta.width), cz = THREE.MathUtils.clamp(t.z, 0, map.meta.depth);
    if (cx !== t.x || cz !== t.z) {
      camera.position.x += cx - t.x;
      camera.position.z += cz - t.z;
      t.set(cx, 0, cz);
    }
  }
  if (focusTo) {
    // 선택한 칸으로 카메라를 부드럽게 이동
    const d = focusTo.clone().sub(controls.target).multiplyScalar(0.15);
    controls.target.add(d);
    camera.position.add(d);
    if (d.lengthSq() < 1e-4) focusTo = null;
  }
  const s = 1 + 0.08 * Math.sin(performance.now() / 180);
  cursor.scale.set(s, 1, s);
  for (const { obj } of markers.values()) {
    if (obj.userData.drop > 0) {
      obj.userData.drop = Math.max(0, obj.userData.drop - 0.6);
      obj.position.y = obj.userData.baseY + obj.userData.drop;
    }
  }
  if (labels) labels.update(camera, innerHeight, innerWidth);
  updateProbe();
  renderer.render(scene, camera);
  checkPerf();
}
loop();

// 느린 기기 대응: 처음 1초(셰이더 준비 등)는 건너뛰고 그다음 60프레임을 잰다.
// 느리면 한 단계씩만 낮춘다: ① 그림자 끄기 → ② 해상도 1.5배 → ③ 1배. (예전처럼 바로 1배로 떨어뜨리지 않음)
function checkPerf() {
  if (perf.done || !map) return;
  const now = performance.now();
  perf.n++;
  if (perf.n === 60) { perf.t0 = now; return; }  // 워밍업 60프레임 무시
  if (perf.n < 120) return;
  const ms = (now - perf.t0) / 60;
  perf.n = 0;
  const step = perf.step || 0;
  if (QS.has("low") && step === 0) return lower(0, ms);
  if (ms <= 34 || QS.has("hd")) { perf.done = true; return; }   // 30fps 이상이면 그대로
  if (!lower(step, ms)) perf.done = true;
}
function lower(step, ms) {
  perf.step = step + 1;
  if (step === 0) {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  } else if (step === 1 && renderer.getPixelRatio() > 1.5) {
    renderer.setPixelRatio(1.5); resize();
  } else if (step <= 2 && renderer.getPixelRatio() > 1) {
    renderer.setPixelRatio(1); resize();
  } else return false;
  console.log(`[GRID] 화질 ${perf.step}단계 낮춤 (프레임 ${ms.toFixed(0)}ms)`);
  return true;
}

// ---------------------------------------------------------------- 서버 통신
async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail?.[0]?.msg || data.detail || `서버 오류 (${res.status})`);
  return data;
}

async function poll() {
  try {
    const list = await api(`/api/complaints?since_id=${lastId}`);
    for (const c of list) addMarker(c, false);
    if (list.length) onProposalsChanged();
    $("#count").textContent = markers.size;
    $("#offline").hidden = true;
  } catch {
    $("#offline").hidden = false;
  }
}

function addMarker(c, animate) {
  if (markers.has(c.id)) return;
  const obj = makeMarker(c.type);
  const baseY = heightAt(map, c.x, c.z);
  obj.position.set(c.x + 0.5, baseY, c.z + 0.5);
  obj.userData = { ...obj.userData, id: c.id, baseY, drop: animate ? 25 : 0 };
  obj.visible = !hiddenTypes.has(c.type);
  markerRoot.add(obj);
  markers.set(c.id, { obj, data: c });
  lastId = Math.max(lastId, c.id);
}

// ---------------------------------------------------------------- 탭 처리 (드래그와 구분)
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
canvas.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now(), multi: !e.isPrimary };
});
canvas.addEventListener("pointerup", (e) => {
  if (!down || !map || !e.isPrimary) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved < 8 && performance.now() - down.t < 600) onTap(e.clientX, e.clientY);
  down = null;
});

function onTap(px, py) {
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);

  // 1) 기존 민원 아이콘을 눌렀는지 (스프라이트는 화면 크기 고정이라 화면 거리로 판정)
  let best = null, bestD = 28;
  const v = new THREE.Vector3();
  for (const { obj, data } of markers.values()) {
    if (!obj.visible) continue;
    obj.userData.sprite.getWorldPosition(v).project(camera);
    if (v.z > 1) continue;
    const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestD) { bestD = d; best = data; }
  }
  if (best) return showDetail(best);

  // 2) 건물/지면을 눌렀으면 그 칸 선택
  const hit = ray.intersectObjects([world.buildings, world.ground], false)[0];
  if (!hit) return;
  const p = hit.point.clone();
  const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
  // 건물 옆면을 누르면 그 벽 '앞' 칸(길 쪽)을 고른다
  if (hit.object === world.buildings && Math.abs(n.y) < 0.5) p.addScaledVector(n, 0.5);
  else p.addScaledVector(n, -0.01);
  const x = Math.floor(p.x), z = Math.floor(p.z);
  if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) return;
  selectCell(x, z);
}

// ---------------------------------------------------------------- 등록 시트
function buildTypeButtons() {
  for (const [box, list] of [[$("#types-fix"), FIX_TYPES], [$("#types-report"), REPORT_TYPES]]) {
    for (const t of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "type";
      b.dataset.code = t.code;
      b.title = t.desc || t.label;
      b.innerHTML = `<span class="ic">${t.icon}</span><span>${t.label}</span>`;
      b.onclick = () => chooseType(t.code);
      box.append(b);
    }
  }
}

function selectCell(x, z) {
  selected = { x, z };
  const y = heightAt(map, x, z);
  cursor.position.set(x + 0.5, y, z + 0.5);
  cursor.visible = true;
  $("#zone").textContent = `구역 ${zoneOf(map.meta, x, z)}`;
  $("#heatInfo").innerHTML = heatHTML(x, z);
  closeDetail();
  openSheet();
  if (chosenType) chooseType(chosenType);
}

function chooseType(code) {
  chosenType = code;
  document.querySelectorAll(".type").forEach((b) => b.classList.toggle("on", b.dataset.code === code));
  if (ghost) markerRoot.remove(ghost);
  ghost = makeMarker(code, { ghost: true });
  ghost.position.set(selected.x + 0.5, heightAt(map, selected.x, selected.z), selected.z + 0.5);
  markerRoot.add(ghost);
  const t = TYPE_BY_CODE[code];
  $("#text").placeholder = t.group === "fix" ? `왜 여기에 ${t.label}이(가) 필요한지 짧게 적어 주세요` : `${t.label} 상황을 짧게 적어 주세요`;
  showEffect(t);
  updateSubmit();
}

// 놓기 전에 "이 블록 하나로 주변 지수가 얼마나 내려가는지" 계산해 보여준다
function showEffect(t) {
  const el = $("#effectInfo");
  el.className = "effect-info";
  footprint.visible = false;
  if (!t.effect || !selected) { el.innerHTML = ""; return; }
  const { x, z } = selected;
  const onRoof = heightAt(map, x, z) > 0;
  if (t.roofOnly && !onRoof) {
    el.classList.add("warn");
    el.innerHTML = "🏠 옥상녹화는 <b>건물 옥상</b>을 눌러야 효과가 있어요";
    return;
  }
  const before = scoreAt(map, x, z);
  const after = scoreAt(map, x, z, buildMods(map, [{ type: t.code, x, z }], TYPE_BY_CODE));
  const d = Math.round(before) - Math.round(after);
  const m = (t.effect.size * (map.meta.cell || 5));
  el.innerHTML = `${t.icon} ${t.desc} · 약 ${m}m×${m}m<br>놓으면 이 주변 열섬 지수 <b>${Math.round(before)} → ${Math.round(after)}</b> (${d > 0 ? "−" + d : "변화 거의 없음"})`;
  const sz = t.effect.size;
  footprint.scale.set(sz, 1, sz);
  footprint.position.set(x + 0.5, (t.roofOnly ? heightAt(map, x, z) : 0) + 0.06, z + 0.5);
  footprint.visible = true;
}

function updateSubmit() {
  $("#submit").disabled = !(selected && chosenType && $("#text").value.trim());
}
$("#text").addEventListener("input", updateSubmit);

// 아래 시트가 화면을 가리는 만큼 3D 화면 중심을 위로 올린다
function liftView(sheetEl) {
  const h = sheetEl ? sheetEl.getBoundingClientRect().height : 0;
  if (h) camera.setViewOffset(innerWidth, innerHeight, 0, h / 2, innerWidth, innerHeight);
  else camera.clearViewOffset();
}
function openSheet() {
  $("#sheet").classList.add("open");
  document.body.classList.add("sheet-open");
  liftView($("#sheet"));
  focusTo = new THREE.Vector3(selected.x + 0.5, 0, selected.z + 0.5);
}
function closeSheet() {
  $("#sheet").classList.remove("open");
  document.body.classList.remove("sheet-open");
  liftView(null);
  cursor.visible = false;
  footprint.visible = false;
  $("#effectInfo").innerHTML = "";
  if (ghost) markerRoot.remove(ghost);
  ghost = null;
  selected = null;
}
$("#cancel").onclick = closeSheet;

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected || !chosenType) return;
  if (TYPE_BY_CODE[chosenType].roofOnly && heightAt(map, selected.x, selected.z) === 0) {
    toast("옥상녹화는 건물 옥상을 눌러 주세요 🏠");
    return;
  }
  const btn = $("#submit");
  btn.disabled = true;
  btn.textContent = "등록 중…";
  const { x, z } = selected;
  try {
    const c = await api("/api/complaints", {
      method: "POST",
      body: JSON.stringify({
        x, z, ...cellToLatLng(map.meta, x, z), zone: zoneOf(map.meta, x, z),
        type: chosenType, text: $("#text").value.trim(),
      }),
    });
    addMarker(c, true);
    $("#count").textContent = markers.size;
    $("#text").value = "";
    closeSheet();
    onProposalsChanged();
    toast(`등록됐어요! ${TYPE_BY_CODE[c.type].icon} ${TYPE_BY_CODE[c.type].label} 블록을 놓았어요 🎉`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = "제안 등록";
    updateSubmit();
  }
});

// ---------------------------------------------------------------- 상세 카드
let detailId = null;
function showDetail(c) {
  closeSheet();
  detailId = c.id;
  const t = TYPE_BY_CODE[c.type] || TYPE_BY_CODE.other;
  $("#d-type").textContent = `${t.icon} ${t.label}`;
  $("#d-zone").textContent = `구역 ${c.zone}`;
  $("#d-heat").innerHTML = heatHTML(c.x, c.z);
  $("#d-text").textContent = c.text;
  $("#d-time").textContent = new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  $("#d-like").textContent = `👍 공감 ${c.likes}`;
  $("#d-like").disabled = likedIds().includes(c.id);
  $("#detail").classList.add("open");
}
function closeDetail() {
  $("#detail").classList.remove("open");
  detailId = null;
}
$("#d-close").onclick = closeDetail;
$("#d-like").onclick = async () => {
  if (detailId == null) return;
  try {
    const c = await api(`/api/complaints/${detailId}/like`, { method: "POST" });
    markers.get(c.id).data = c;
    try { localStorage.setItem("grid-liked", JSON.stringify([...likedIds(), c.id])); } catch {}
    showDetail(c);
  } catch (err) {
    toast(err.message);
  }
};
function likedIds() {
  try { return JSON.parse(localStorage.getItem("grid-liked") || "[]"); } catch { return []; }
}

// ---------------------------------------------------------------- 열섬 레이어
function setHeat(on, quiet = false) {
  heatOn = on;
  if (!on && simOn) setSim(false, true);
  paintHeat(world, map, simOn ? heatSim : heat, on);
  $("#tool-heat").setAttribute("aria-pressed", String(on));
  $("#legend").hidden = !on;
  if (on && !quiet) toast("빨간 곳일수록 여름철 열이 많이 쌓이는 곳이에요 🌡️", 3500);
}
$("#tool-heat").onclick = () => heat && setHeat(!heatOn);

// ---------------------------------------------------------------- 시민 제안 효과 시뮬레이션
// 영향권(지수가 0.5 이상 내려간 칸)만 따로 평균 — 동네 전체 평균은 면적이 커서 변화가 묻힌다
function simStats(base, sim) {
  let n = 0, b = 0, a = 0, big = 0;
  for (let i = 0; i < base.value.length; i++) {
    const d = base.value[i] - sim.value[i];
    if (d >= 0.5) { n++; b += base.value[i]; a += sim.value[i]; if (d >= 3) big++; }
  }
  const cellHa = (map.meta.cell || 5) ** 2 / 10000;
  return { ha: n * cellHa, before: n ? b / n : 0, after: n ? a / n : 0, bigHa: big * cellHa };
}
function proposals() {
  return [...markers.values()].map((m) => m.data).filter((c) => TYPE_BY_CODE[c.type]?.effect);
}
function setSim(on, quiet = false) {
  simOn = on;
  $("#tool-sim").setAttribute("aria-pressed", String(on));
  if (on) {
    heatSim = computeHeat(map, buildMods(map, proposals(), TYPE_BY_CODE));
    if (!heatOn) setHeat(true, true);
    paintHeat(world, map, heatSim, true);
    const st = simStats(heat, heatSim);
    $("#heatAvg").innerHTML = `${Math.round(baseAvg)} · 제안 영향권 ${st.ha.toFixed(1)}ha <span style="color:#2f9e44">${Math.round(st.before)} → ${Math.round(st.after)}</span>`;
    if (!quiet) toast(`시민 제안 ${proposals().length}건이 실현되면 영향권 ${st.ha.toFixed(1)}ha가 평균 ${Math.round(st.before)} → ${Math.round(st.after)}로 시원해져요 ✨`, 5000);
  } else {
    heatSim = null;
    $("#heatAvg").textContent = Math.round(baseAvg);
    if (heatOn) paintHeat(world, map, heat, true);
  }
  renderReport();
}
$("#tool-sim").onclick = () => heat && setSim(!simOn);
function onProposalsChanged() {
  if (simOn) setSim(true, true);
  else renderReport();
}

// ---------------------------------------------------------------- 나머지 도구
$("#tool-labels").onclick = () => {
  if (!labels) return;
  labels.group.visible = !labels.group.visible;
  $("#tool-labels").setAttribute("aria-pressed", String(labels.group.visible));
};
$("#tool-home").onclick = () => {
  if (!map) return;
  const { width: W, depth: D } = map.meta;
  controls.target.set(W / 2, 0, D / 2);
  camera.position.set(W / 2 + W * 0.35, Math.max(W, D) * 0.45, D / 2 + D * 0.55);
};
$("#tool-help").onclick = () => { $("#intro").hidden = false; };
$("#intro-ok").onclick = () => {
  $("#intro").hidden = true;
  try { localStorage.setItem("grid-intro", "1"); } catch {}
  if (!heatOn) setHeat(true);
};
$("#tool-report").onclick = () => {
  const open = !$("#report").classList.contains("open");
  $("#report").classList.toggle("open", open);
  $("#tool-report").setAttribute("aria-pressed", String(open));
  if (open) renderReport();
};
$("#report-close").onclick = () => $("#tool-report").click();

// 카메라를 (x, z)로 옮기고 조금 가까이
function flyTo(x, z) {
  focusTo = new THREE.Vector3(x, 0, z);
  const dist = camera.position.distanceTo(controls.target);
  if (dist > 140) camera.position.lerp(controls.target, 1 - 140 / dist);
}

// ---------------------------------------------------------------- 동네 환경 리포트
function renderReport() {
  if (!map || !heat || !$("#report").classList.contains("open")) return;
  const W = map.meta.width, s = map.meta.zone_size || 40;
  // 지금 날씨·공기
  const w = lastEnv?.weather, a = lastEnv?.air;
  $("#r-env").innerHTML = (w || a)
    ? `${w?.temp != null ? `🌡️ 기온 <b>${w.temp.toFixed(1)}°C</b> · 습도 ${w.humidity ?? "-"}%<br>` : ""}${a?.pm25 != null ? `😷 초미세먼지 <b>${a.pm25}</b>㎍/㎥ (${a.pm25_grade || a.grade || "-"}) · 미세먼지 ${a.pm10 ?? "-"}<br>` : ""}<small class="hint">기상청 · 에어코리아 ${a?.station || ""}</small>`
    : "실시간 데이터 연결 전이에요";
  // 열섬 TOP3 (구역 평균)
  const h = simOn ? heatSim : heat;
  const zh = Object.entries(zoneHeat(map, h)).sort((p, q) => q[1] - p[1]).slice(0, 3);
  $("#r-hot").innerHTML = zh.map(([zone, v], i) => {
    const [r, g, b] = heatRGB(v);
    return `<li data-zone="${zone}"><span class="num">${i + 1}</span>${nearestLabel(zone)}<span class="score" style="background:rgb(${r},${g},${b})">${v}</span></li>`;
  }).join("");
  $("#r-hot").querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      const z = li.dataset.zone;
      const zx = z.charCodeAt(0) - 65, zz = parseInt(z.slice(1), 10) - 1;
      if (!heatOn) setHeat(true, true);
      flyTo(zx * s + s / 2, zz * s + s / 2);
      if (innerWidth < 600) $("#tool-report").click();
    };
  });
  // 시뮬레이션 요약
  const props = proposals();
  if (!props.length) {
    $("#r-sim").innerHTML = `<p class="r-sim">아직 개선 제안이 없어요. 지도를 눌러 첫 제안을 해 보세요!</p>`;
  } else {
    const sim = simOn ? heatSim : computeHeat(map, buildMods(map, props, TYPE_BY_CODE));
    const st = simStats(heat, sim);
    $("#r-sim").innerHTML = `<div class="r-sim">개선 제안 <b>${props.length}건</b>이 모두 실현되면<br>
      영향권 <b>${st.ha.toFixed(1)}ha</b>의 평균 열섬 지수<br><span class="big">${Math.round(st.before)} → ${Math.round(st.after)}</span>
      <b style="color:#2f9e44">(−${Math.round(st.before - st.after)})</b><br>
      3점 이상 시원해지는 곳 <b>${st.bigHa.toFixed(1)}ha</b> · 무실동 전체 평균 ${baseAvg.toFixed(1)} → ${meanHeat(sim).toFixed(1)}</div>
      ${simOn ? "" : `<p class="hint">✨ 제안 효과 버튼을 누르면 지도에서 볼 수 있어요</p>`}`;
  }
  // 유형별 개수 (누르면 숨기기)
  const counts = {};
  for (const { data } of markers.values()) counts[data.type] = (counts[data.type] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  $("#r-types").innerHTML = TYPES.map((t) => `<button type="button" class="r-type ${hiddenTypes.has(t.code) ? "off" : ""}" data-code="${t.code}">
      <span>${t.icon}</span><span>${t.label}</span><span class="rbar"><i style="width:${((counts[t.code] || 0) / max) * 100}%;background:${t.color}"></i></span><b>${counts[t.code] || 0}</b></button>`).join("");
  $("#r-types").querySelectorAll(".r-type").forEach((b) => {
    b.title = TYPE_BY_CODE[b.dataset.code].label;
    b.onclick = () => {
      const c = b.dataset.code;
      hiddenTypes.has(c) ? hiddenTypes.delete(c) : hiddenTypes.add(c);
      for (const { obj, data } of markers.values()) obj.visible = !hiddenTypes.has(data.type);
      renderReport();
    };
  });
}

// 구역 코드(H1) 대신 그 구역 안 가장 중요한 이름표로 부르기
function nearestLabel(zone) {
  const s = map.meta.zone_size || 40;
  const zx = zone.charCodeAt(0) - 65, zz = parseInt(zone.slice(1), 10) - 1;
  const cx = zx * s + s / 2, cz = zz * s + s / 2;
  let best = null, bd = Infinity;
  for (const l of labels?.items || []) {
    const d = Math.hypot(l.x - cx, l.z - cz);
    if (d < bd) { bd = d; best = l; }
  }
  return best && bd < s * 1.2 ? `${best.name} 주변` : `구역 ${zone}`;
}

function heatHTML(x, z) {
  if (!heat) return "";
  const v = Math.round(heat.value[z * map.meta.width + x]);
  const lv = heatLevel(v);
  return `🌡️ 이 주변 열섬 지수 <b>${v}</b><span class="heat-badge" style="background:${lv.color}">${lv.text}</span>`;
}

// ---------------------------------------------------------------- 실시간 열섬 지수 읽기
// PC: 마우스가 가리키는 곳 / 폰(터치): 화면 가운데 십자. 열섬 지도가 켜져 있을 때만.
const HOVER = matchMedia("(hover: hover) and (pointer: fine)").matches;
let mouse = null, probeAt = 0;
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const probeHit = new THREE.Vector3();
canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") mouse = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerleave", () => { mouse = null; });

// 열섬 지수 → 주변 평균 대비 추정 기온 차이 (PoC 가정: 지수 0점 −3°C ~ 100점 +3°C, 도시 열섬 강도 문헌값 수준)
const tempOffset = (v) => (v - 50) * 0.06;

function updateProbe() {
  const el = $("#probe"), ch = $("#crosshair");
  const show = heatOn && map && (!HOVER || mouse);
  el.hidden = !show;
  ch.hidden = !(heatOn && map && !HOVER);
  if (!show) return;
  const now = performance.now();
  if (now - probeAt < (HOVER ? 120 : 90)) return;
  probeAt = now;
  const px = HOVER ? mouse.x : innerWidth / 2, py = HOVER ? mouse.y : innerHeight / 2;
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // PC는 건물까지 정확히 (마우스 아래 건물), 폰은 가벼운 지면 계산
  const hit = HOVER ? ray.intersectObject(world.buildings, false)[0] : null;
  if (hit) probeHit.copy(hit.point).addScaledVector(hit.face.normal, -0.01);
  else if (!ray.ray.intersectPlane(groundPlane, probeHit)) { el.hidden = true; return; }
  const x = Math.floor(probeHit.x), z = Math.floor(probeHit.z);
  if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) { el.hidden = true; return; }
  const h = simOn && heatSim ? heatSim : heat;
  const v = Math.round(h.value[z * map.meta.width + x]);
  const lv = heatLevel(v);
  const base = lastEnv?.weather?.temp;
  const dT = tempOffset(v);
  const tLine = base != null
    ? `이곳 추정 <b>${(base + dT).toFixed(1)}°C</b> <small>(기상청 ${base.toFixed(1)}°C ${dT >= 0 ? "+" : ""}${dT.toFixed(1)})</small>`
    : `<small>동네 평균보다 약 ${dT >= 0 ? "+" : ""}${dT.toFixed(1)}°C (추정)</small>`;
  let sim = "";
  if (simOn && heatSim) {
    const d = Math.round(heat.value[z * map.meta.width + x]) - v;
    if (d > 0) sim = `<br><small style="color:#2f9e44">시민 제안으로 −${d}점</small>`;
  }
  el.style.borderLeftColor = lv.color;
  el.innerHTML = `🌡️ <span class="v" style="color:${lv.color}">${v}</span><span class="lv" style="color:${lv.color}">${lv.text}</span><br>${tLine}${sim}`;
  el.classList.toggle("center", !HOVER);
  if (HOVER) { el.style.left = px + "px"; el.style.top = py + "px"; }
}

// ---------------------------------------------------------------- 실시간 기온·대기질 (에어코리아·기상청)
const AIR_COLOR = { 좋음: "#1c7ed6", 보통: "#2f9e44", 나쁨: "#f76707", 매우나쁨: "#e03131" };
async function loadEnv() {
  try {
    const d = await api("/api/env");
    lastEnv = d;
    renderReport();
    const w = d.weather, a = d.air;
    if (!w && !a) return;
    const parts = [];
    if (w && w.temp != null) parts.push(`🌡️ <b>${w.temp.toFixed(1)}°C</b> <small>습도 ${w.humidity ?? "-"}%</small>`);
    if (a && a.pm25 != null) {
      const g = a.pm25_grade || a.grade || "";
      parts.push(`<span class="env-dot" style="background:${AIR_COLOR[g] || "#868e96"}"></span>초미세먼지 <b>${a.pm25}</b> <small>${g}</small>`);
    }
    const src = [w && "기상청", a && `에어코리아 ${a.station}`].filter(Boolean).join(" · ");
    $("#envNow").innerHTML = `${parts.join("<br>")}<br><small>지금 무실동 · ${src}</small>`;
    $("#envNow").hidden = false;
  } catch {}
}

// ---------------------------------------------------------------- 토스트
let toastTimer;
function toast(msg, ms = 2800) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

start();
