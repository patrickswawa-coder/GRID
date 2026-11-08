// 시민용 화면: 지도 탭 → 유형 선택 → 의견 입력 → 등록, 다른 민원 보기·공감
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { loadMap, buildScene, heightAt, cellToLatLng, zoneOf } from "./map.js";
import { makeMarker } from "./markers.js";
import { loadLabels } from "./labels.js";
import { computeHeat, paintHeat, heatLevel, zoneHeat } from "./heat.js";
import { TYPES, TYPE_BY_CODE } from "./types.js";

const API = window.GRID_API || ""; // 같은 서버면 빈 문자열
const POLL_MS = 8000;
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- 3D 기본
const canvas = $("#view");
const MOBILE = matchMedia("(pointer: coarse)").matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
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
  const zh = Object.entries(zoneHeat(map, heat)).sort((p, q) => q[1] - p[1]);
  const avg = Math.round(heat.value.reduce((t, v) => t + v, 0) / heat.value.length);
  $("#heatAvg").textContent = avg;
  $("#heatTop").textContent = `${nearestLabel(zh[0][0])} (${zh[0][1]})`;
  if (new URLSearchParams(location.search).has("heat")) setHeat(true);
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
  toast("개선이 필요한 위치를 눌러 주세요 👆", 3500);
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
  renderer.render(scene, camera);
  checkPerf();
}
loop();

// 느린 기기면 그림자를 끄고 해상도를 낮춘다 (맵이 뜬 뒤 60프레임 평균으로 판단)
function checkPerf() {
  if (perf.done || !map) return;
  const now = performance.now();
  if (perf.n === 0) perf.t0 = now;
  if (++perf.n < 60) return;
  perf.done = true;
  const ms = (now - perf.t0) / 59;
  if (ms > 40 || new URLSearchParams(location.search).has("low")) {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
    renderer.setPixelRatio(1);
    resize();
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    console.log(`[GRID] 저사양 모드 (프레임 ${ms.toFixed(0)}ms)`);
  }
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
  const box = $("#types");
  for (const t of TYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "type";
    b.dataset.code = t.code;
    b.innerHTML = `<span class="ic">${t.icon}</span><span>${t.label}</span>`;
    b.onclick = () => chooseType(t.code);
    box.append(b);
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
  $("#text").placeholder = `${TYPE_BY_CODE[code].label} 관련 의견을 짧게 적어 주세요`;
  updateSubmit();
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
  liftView($("#sheet"));
  focusTo = new THREE.Vector3(selected.x + 0.5, 0, selected.z + 0.5);
}
function closeSheet() {
  $("#sheet").classList.remove("open");
  liftView(null);
  cursor.visible = false;
  if (ghost) markerRoot.remove(ghost);
  ghost = null;
  selected = null;
}
$("#cancel").onclick = closeSheet;

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected || !chosenType) return;
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
    toast(`등록됐어요! 구역 ${c.zone}에 ${TYPE_BY_CODE[c.type].label} 블록을 놓았어요 🎉`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = "민원 등록";
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
function setHeat(on) {
  heatOn = on;
  paintHeat(world, map, heat, on);
  $("#heatBtn").setAttribute("aria-pressed", String(on));
  $("#legend").hidden = !on;
  if (on) toast("빨간 곳일수록 여름철 열이 많이 쌓이는 곳이에요 🌡️", 3500);
}
$("#heatBtn").onclick = () => heat && setHeat(!heatOn);

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
