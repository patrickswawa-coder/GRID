// 시민용 화면: 지도 탭 → 유형 선택 → 의견 입력 → 등록, 다른 민원 보기·공감
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { loadMap, buildScene, heightAt, cellToLatLng, latLngToCell, zoneOf } from "./map.js";
import { makeMarker } from "./markers.js";
import { loadLabels } from "./labels.js";
import { computeHeat, paintHeat, heatLevel, zoneHeat, scoreAt, buildMods, meanHeat, heatRGB } from "./heat.js";
import { TYPES, TYPE_BY_CODE, FIX_TYPES, REPORT_TYPES } from "./types.js";
import { expandCells, expandAll, isMulti, pathLength, MAX_CELLS, MAX_POINTS } from "./shape.js";

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
let drawing = null; // 자유 그리기 중인 손가락 { id, sx, sy, start, moved, capped } (#32)
let simOn = false, heatSim = null, baseAvg = 0, lastEnv = null;
const hiddenTypes = new Set();
const markers = new Map(); // id → { obj, data }
const markerRoot = new THREE.Group();
scene.add(markerRoot);
let lastId = 0;
let selected = null; // { x, z }
let chosenType = null;
let ghost = null;
let shape = "one"; // 놓는 방식: one(한 곳) / path(자유 그리기) / area(네모)
let endCell = null; // 네모의 반대 모서리 { x, z }
let pathPts = []; // 자유 그리기로 지나간 칸 [[x, z], ...] (첫 점 = 시작점)
let focusTo = null; // 카메라가 이동할 목표 지점
const perf = { n: 0, t0: 0, done: false }; // 성능 측정

// 선택한 칸 표시: 열섬 색(초록~빨강)과 겹치지 않는 하늘색 — 테두리 상자 + 바닥 고리 + 위로 솟은 빛기둥
const CURSOR_COLOR = 0x22c3ff;
const cursor = new THREE.Group();
const cursorBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.08, 1.08, 1.08).translate(0, 0.54, 0)),
  new THREE.LineBasicMaterial({ color: CURSOR_COLOR, depthTest: false })
);
const cursorRing = new THREE.Mesh(
  new THREE.RingGeometry(1.1, 1.6, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: CURSOR_COLOR, transparent: true, opacity: 0.9, depthTest: false })
);
cursorRing.position.y = 0.05;
const cursorBeam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.18, 0.18, 14, 12, 1, true).translate(0, 7, 0),
  new THREE.MeshBasicMaterial({ color: CURSOR_COLOR, transparent: true, opacity: 0.45, depthWrite: false })
);
// 멀리서도 보이는 핀 (화면에서 항상 같은 크기)
const cursorPin = (() => {
  const cv = document.createElement("canvas"); cv.width = 128; cv.height = 160;
  const g = cv.getContext("2d");
  g.fillStyle = "#22c3ff"; g.strokeStyle = "#fff"; g.lineWidth = 10;
  g.beginPath(); g.arc(64, 58, 48, Math.PI * 0.82, Math.PI * 2.18); g.lineTo(64, 150); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#fff"; g.beginPath(); g.arc(64, 58, 18, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  sp.material.sizeAttenuation = false;
  sp.center.set(0.5, 0); // 핀 끝이 바닥을 가리키게
  sp.scale.set(0.04, 0.05, 1);
  return sp;
})();
for (const o of [cursorBox, cursorRing, cursorBeam, cursorPin]) { o.renderOrder = 20; cursor.add(o); }
cursor.visible = false;
scene.add(cursor);

// 줄의 끝점·네모의 반대 모서리 표시 (빨간 테두리 상자)
const endCursor = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.08, 1.08, 1.08).translate(0, 0.54, 0)),
  new THREE.LineBasicMaterial({ color: 0xff6b6b, depthTest: false })
);
endCursor.renderOrder = 20;
endCursor.visible = false;
scene.add(endCursor);
// 네모 영역 미리보기 (바닥에 깔리는 반투명 사각형)
const areaBox = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x339af0, transparent: true, opacity: 0.22, depthWrite: false })
);
areaBox.renderOrder = 4;
areaBox.visible = false;
scene.add(areaBox);

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
  // 주제(환경데이터 시각화)상 열섬 지도는 기본으로 켠다. 재방문·QR 진입도 같게. ?noheat 이면 끈 채로 시작
  if (!QS.has("noheat")) setHeat(true, true);
  else syncView();
  loadEnv();
  setInterval(loadEnv, 10 * 60 * 1000);
  const { width: W, depth: D } = map.meta;
  $("#place").textContent = map.meta.name;
  homeView();
  controls.maxDistance = Math.max(W, D) * 1.3;
  camera.far = Math.max(W, D) * 4;
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0xd6ebf5, Math.max(W, D) * 0.9, Math.max(W, D) * 2.2);
  placeSun(W, D);
  buildTypeButtons();
  await poll();
  setInterval(poll, POLL_MS);
  $("#loading").remove();
  if (SPOT_Q && enterSpot()) return; // 거리 QR: 안내 없이 바로 그 자리로
  let seen = false;
  try { seen = localStorage.getItem("grid-intro") === "1"; } catch {}
  if (!seen && !new URLSearchParams(location.search).has("demo")) $("#intro").hidden = false;
  else toast("바꾸고 싶은 곳을 눌러 주세요", 3500);
}

// ---------------------------------------------------------------- 거리 QR 위치 모드
// QR 주소: ?at=위도,경도&name=장소이름  (또는 ?x=칸&z=칸&name=…). data/make_qr.py --spots 로 만든다.
// 들어오면 안내창 없이 그 자리로 가까이 가서 '지금 계신 곳' 핀과 [이곳에 의견 남기기] 카드를 보여준다.
const SPOT_Q = (() => {
  const name = (QS.get("name") || "").trim().slice(0, 30);
  const at = QS.get("at");
  if (at) {
    const [la, ln] = at.split(",").map(Number);
    if (Number.isFinite(la) && Number.isFinite(ln)) return { lat: la, lng: ln, name };
  }
  if (QS.has("x") && QS.has("z")) {
    const x = Number(QS.get("x")), z = Number(QS.get("z"));
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z, name };
  }
  return null;
})();
let spot = null;

// QR이 건물 위를 가리키면 가장 가까운 길·인도 칸으로 (가로수·그늘막은 땅에 놓아야 효과가 있음)
function snapToStreet(x, z) {
  const { width: W, depth: D } = map.meta;
  let best = null, bd = Infinity;
  for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
    const xx = x + dx, zz = z + dz;
    if (xx < 0 || zz < 0 || xx >= W || zz >= D || heightAt(map, xx, zz) > 0) continue;
    const g = map.ground[zz * W + xx];
    const d = dx * dx + dz * dz + (g === 1 || g === 2 ? 0 : 40); // 길(1)·인도(2) 우선
    if (d < bd) { bd = d; best = [xx, zz]; }
  }
  return best || [x, z];
}

function enterSpot() {
  const m = map.meta;
  let x, z;
  if (SPOT_Q.lat != null) {
    ({ x, z } = latLngToCell(m, SPOT_Q.lat, SPOT_Q.lng)); // 정확한 TM 변환 (geo.js)
  } else {
    x = Math.floor(SPOT_Q.x); z = Math.floor(SPOT_Q.z);
  }
  if (x < 0 || z < 0 || x >= m.width || z >= m.depth) {
    toast("QR 위치가 지도 밖이에요. 바꾸고 싶은 곳을 눌러 주세요", 4000);
    return false;
  }
  [x, z] = snapToStreet(x, z);
  spot = { x, z, name: SPOT_Q.name || nearestLabel(zoneOf(m, x, z)).replace(/ 주변$/, " 근처") };
  flySpot();
  showSpotCard();
  return true;
}

const SPOT_PUSH = Number(QS.get("push")) || 12; // 가장자리 지점: 시점을 안쪽으로 미는 칸 수 (?push= 로 시험)
function flySpot() {
  focusTo = null;
  const { width: W, depth: D } = map.meta;
  const px = spot.x + 0.5, pz = spot.z + 0.5;
  // 기본: 남동쪽에서 바라봄 (주변 골목까지 보이게)
  let ux = 55 / 105, uz = 90 / 105, tx = px, tz = pz;
  // 지도 가장자리 근처(예: 북쪽 끝의 시외버스터미널)면 기본 방향으로는 화면 위쪽이 지도 밖 하늘이 된다.
  // → 가까운 경계선과 '수직으로' 지도 안쪽을 바라보게 돌린다 (가운데 방향으로 보면 경계선이 대각선으로 화면을 가로지름).
  //   그리고 핀이 아래 카드 바로 위에 오도록 시점을 안쪽으로 밀어, 카메라 쪽(지도 밖) 띠는 카드에 가려지게 한다.
  const EDGE = 110;
  let ox = 0, oz = 0;
  if (pz < EDGE) oz -= (EDGE - pz) / EDGE;          // 북쪽 경계 → 바깥(북)에서 남쪽을 봄
  if (D - pz < EDGE) oz += (EDGE - (D - pz)) / EDGE; // 남쪽
  if (px < EDGE) ox -= (EDGE - px) / EDGE;          // 서쪽
  if (W - px < EDGE) ox += (EDGE - (W - px)) / EDGE; // 동쪽
  if (ox || oz) {
    const L = Math.hypot(ox, oz);
    ux = ox / L; uz = oz / L;
    tx = px - ux * SPOT_PUSH; tz = pz - uz * SPOT_PUSH;
  }
  controls.target.set(tx, 0, tz);
  camera.position.set(tx + ux * 105, 85, tz + uz * 105);
}

function showSpotCard() {
  if (!spot) return;
  const v = Math.round(heat.value[spot.z * map.meta.width + spot.x]);
  const lv = heatLevel(v), dT = tempOffset(v);
  $("#spotName").textContent = spot.name;
  $("#spotHeat").innerHTML = `🌡️ 이곳 열섬 지수 <b style="color:${lv.color}">${v} ${lv.text}</b><br>` +
    `여름 한낮엔 보통 지역보다 약 ${dT >= 0 ? "+" : "−"}${Math.abs(dT).toFixed(1)}°C <small>(추정)</small>`;
  $("#spotCard").hidden = false;
  document.body.classList.add("spot-open");
}
function hideSpotCard() {
  $("#spotCard").hidden = true;
  document.body.classList.remove("spot-open");
}
let spotFlow = false;
$("#spotGo").onclick = () => {
  hideSpotCard(); spotFlow = true; selectCell(spot.x, spot.z);
  setPeek(false); // 이미 '의견 남기기'를 눌렀으니 접힌 상태가 아니라 바로 펼쳐서
};
$("#spotLook").onclick = () => { hideSpotCard(); toast("바꾸고 싶은 곳을 눌러 주세요 👆", 3000); };

// ---------------------------------------------------------------- 내 위치 (GPS)
// 브라우저는 HTTPS(또는 localhost)에서만 위치를 알려준다 → http 에서는 버튼을 숨김.
// 찾은 위치는 QR 위치 모드와 똑같이 '지금 계신 곳' 카드로 보여준다.
if (window.isSecureContext && navigator.geolocation) $("#tool-gps").hidden = false;
$("#tool-gps").onclick = () => {
  if (!map) return;
  toast("지금 계신 곳을 찾는 중이에요… 📍", 4000);
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude, accuracy } = pos.coords;
    let { x, z } = latLngToCell(map.meta, latitude, longitude);
    if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) {
      toast("지금은 무실동 지도 밖에 계세요. 지도를 눌러 원하는 곳을 골라 주세요", 4500);
      return;
    }
    [x, z] = snapToStreet(x, z);
    const acc = Math.round(accuracy || 0);
    spot = { x, z, name: "내 위치 근처" + (acc ? ` (오차 약 ${acc}m)` : "") };
    closeSheet();
    flySpot();
    showSpotCard();
  }, (err) => {
    toast(err.code === 1 ? "위치 권한을 허용해야 내 위치를 볼 수 있어요" : "위치를 찾지 못했어요. 지도를 눌러 골라 주세요", 4000);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
};

// 핀은 화면 좌표로 따라다니게 (3D 아이콘보다 멀리서도 잘 보임)
const pinV = new THREE.Vector3();
function updatePin() {
  const el = $("#herePin");
  if (!spot) return;
  pinV.set(spot.x + 0.5, heightAt(map, spot.x, spot.z) + 1, spot.z + 0.5).project(camera);
  const off = pinV.z > 1 || Math.abs(pinV.x) > 1.1 || Math.abs(pinV.y) > 1.1;
  el.hidden = off;
  if (!off) {
    el.style.left = ((pinV.x + 1) / 2) * innerWidth + "px";
    el.style.top = ((1 - pinV.y) / 2) * innerHeight + "px";
  }
}

// 카메라가 멀어지면 near 도 같이 밀어 깊이 정밀도를 지킨다 (최대 축소 때 얇은 판들이 깜빡이지 않게)
let lastNear = camera.near;
function fitNear() {
  const near = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.01, 0.5, 20);
  if (Math.abs(near - lastNear) / lastNear > 0.05) {
    camera.near = lastNear = near;
    camera.updateProjectionMatrix();
  }
}

// 멀리서는 나무 한 그루가 화면 2픽셀보다 작아져, 움직일 때마다 점들이 지글거린다 → 그때는 나무를 그리지 않는다.
// (바닥이 이미 초록이라 숲은 그대로 숲으로 보인다. 경계에서 깜빡이지 않게 켜는 거리와 끄는 거리를 다르게)
function fitDetail() {
  if (!world?.trees) return;
  const px = innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360)) / camera.position.distanceTo(controls.target);
  if (world.trees.visible ? px < 2 : px > 2.4) world.trees.visible = !world.trees.visible;
}

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  fitNear();
  fitDetail();
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
  if (cursor.visible) {
    // 멀리 볼수록 고리·빛기둥을 키워 화면에서 비슷한 크기로 보이게
    const k = Math.max(1, camera.position.distanceTo(cursor.position) / 40);
    const s = k * (1 + 0.18 * Math.sin(performance.now() / 220));
    cursorRing.scale.set(s, 1, s);
    const kb = Math.max(1, camera.position.distanceTo(cursor.position) / 120); // 빛기둥은 덜 키움
    cursorBeam.scale.set(k * 0.6, kb, k * 0.6);
    cursorPin.position.y = 14 * kb;
  }
  if (endCursor.visible) {
    const k = Math.max(1, camera.position.distanceTo(endCursor.position) / 40);
    const s = k * (1 + 0.12 * Math.sin(performance.now() / 220));
    endCursor.scale.set(s, 1, s);
  }
  for (const { obj } of markers.values()) {
    if (obj.userData.drop > 0) {
      obj.userData.drop = Math.max(0, obj.userData.drop - 0.6);
      obj.position.y = obj.userData.baseY + obj.userData.drop;
    }
  }
  if (labels) labels.update(camera, innerHeight, innerWidth);
  if (spot) updatePin();
  if (!drawing) syncDrawControls();
  updateProbe();
  renderer.render(scene, camera);
  checkPerf();
}
requestAnimationFrame(loop); // 바로 부르지 않음: 아래쪽 let(drawing 등)이 다 준비된 뒤 첫 프레임

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
function clientId() {
  try {
    let id = localStorage.getItem("grid-client");
    if (!id) { id = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()); localStorage.setItem("grid-client", id); }
    return id;
  } catch { return ""; }
}
const STATUS_LABEL = { received: "접수", working: "처리중", done: "처리 완료" };
function myIds() { try { return JSON.parse(localStorage.getItem("grid-mine") || "[]"); } catch { return []; } }
function rememberMine(id) { try { localStorage.setItem("grid-mine", JSON.stringify([...myIds(), id].slice(-200))); } catch {} }

async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: { "Content-Type": "application/json", "X-Client-Id": clientId() }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail?.[0]?.msg || data.detail || `서버 오류 (${res.status})`);
  return data;
}

async function poll() {
  try {
    const list = await api(`/api/complaints?since_id=${lastId}`);
    for (const c of list) addMarker(c, false);
    const changed = await syncState().catch((e) => { console.warn("[GRID] sync 실패", e); return false; }); // 상태·공감 변경, 삭제 반영
    if (list.length || changed) onProposalsChanged();
    $("#count").textContent = markers.size;
    $("#offline").hidden = true;
  } catch {
    $("#offline").hidden = false;
  }
}

// 공무원이 상태를 바꾸거나 민원을 지우면 열려 있는 지도에도 반영한다 (새 글은 위 since_id 로 받음)
async function syncState() {
  const rows = await api("/api/complaints/sync");
  const alive = new Set(rows.map((r) => r.id));
  let changed = false;
  for (const [id, m] of [...markers]) {
    if (alive.has(id)) continue;
    if (detailId === id) closeDetail();
    markerRoot.remove(m.obj); markers.delete(id); changed = true;
  }
  for (const r of rows) {
    const m = markers.get(r.id);
    if (!m) continue;
    const was = m.data.status;
    Object.assign(m.data, { status: r.status, likes: r.likes, reply: r.reply });
    if (was && was !== r.status && myIds().includes(r.id)) toast(`내 제안이 '${STATUS_LABEL[r.status] || r.status}'(으)로 바뀌었어요 🔔`, 4500);
    if (detailId === r.id) paintDetailStatus(m.data);
  }
  return changed;
}

// 줄·네모 제안은 칸마다 모형을 놓고 하나로 묶는다 (아이콘은 첫 칸에만)
function makeGroupMarker(c, ghostMode = false) {
  const cells = expandCells(c);
  const g = new THREE.Group();
  const along = c.shape === "line" || c.shape === "path"; // 모형 줄 방향을 길 방향으로
  cells.forEach((p, i) => {
    const m = makeMarker(c.type, { ghost: ghostMode });
    if (i > 0) m.remove(m.userData.sprite);
    m.position.set(p.x + 0.5, heightAt(map, p.x, p.z), p.z + 0.5);
    if (along && cells.length > 1) {
      const a = cells[Math.max(0, i - 1)], b = cells[Math.min(cells.length - 1, i + 1)];
      m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    }
    g.add(m);
    if (i === 0) g.userData.sprite = m.userData.sprite;
  });
  g.userData.cells = cells.length;
  return g;
}

function addMarker(c, animate) {
  if (markers.has(c.id)) return;
  const multi = isMulti(c);
  const obj = multi ? makeGroupMarker(c) : makeMarker(c.type);
  const baseY = multi ? 0 : heightAt(map, c.x, c.z);
  if (multi) obj.position.set(0, 0, 0);
  else obj.position.set(c.x + 0.5, baseY, c.z + 0.5);
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

  // 0) 자유 그리기·네모로 놓는 중이면: 길은 그 칸까지 잇고, 네모는 반대쪽 모서리
  if (selected && chosenType && shape !== "one") {
    const c = pickCell();
    if (c) setEnd(c.x, c.z);
    return;
  }

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
  const c = pickCell();
  // 이미 선택한 곳(파란 기둥·핀 또는 같은 칸)을 한 번 더 누르면 선택 해제.
  // 한 곳 놓기일 때만 — 줄·네모는 위 0)에서 두 번째 누름이 끝점으로 처리된다.
  // (시트가 올라오면 카메라가 움직여서 같은 칸도 화면 위치가 달라지므로, 칸 비교와 화면 위 기둥 터치를 둘 다 본다)
  if (selected && shape === "one" && (hitsCursor(px, py) || (c && c.x === selected.x && c.z === selected.z))) {
    // 의견을 이미 쓴 상태면 실수로 글이 날아가지 않게 한 번 물어본다
    if ($("#text").value.trim() && !confirm("선택을 풀까요? 쓰던 의견은 지워져요.")) return;
    $("#text").value = "";
    closeSheet();
    toast("선택을 취소했어요");
    return;
  }
  if (c) selectCell(c.x, c.z);
}

// 화면에서 (px,py)가 선택 표시(파란 핀·기둥 아래쪽 바닥)를 눌렀는지
function hitsCursor(px, py) {
  if (!cursor.visible) return false;
  const v = new THREE.Vector3();
  for (const [pos, r] of [[cursorPin.getWorldPosition(v), 32], [cursor.position.clone(), 26]]) {
    const q = pos.clone().project(camera);
    if (q.z > 1) continue;
    if (Math.hypot((q.x + 1) / 2 * innerWidth - px, (1 - q.y) / 2 * innerHeight - py) < r) return true;
  }
  return false;
}

// 화면에서 누른 곳(ray)의 칸
function pickCell() {
  const hit = ray.intersectObjects([world.buildings, world.ground], false)[0];
  if (!hit) return null;
  const p = hit.point.clone();
  const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
  // 건물 옆면을 누르면 그 벽 '앞' 칸(길 쪽)을 고른다
  if (hit.object === world.buildings && Math.abs(n.y) < 0.5) p.addScaledVector(n, 0.5);
  else p.addScaledVector(n, -0.01);
  const x = Math.floor(p.x), z = Math.floor(p.z);
  if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) return null;
  return { x, z };
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

// 시작 칸 표시만 바꾼다 (시트 열기 없이) — 탭 선택과 드래그 그리기가 같이 씀
function setStart(x, z) {
  selected = { x, z };
  const y = heightAt(map, x, z);
  cursor.position.set(x + 0.5, y, z + 0.5);
  cursor.visible = true;
  const zc = zoneOf(map.meta, x, z);
  $("#zone").textContent = spot && spot.x === x && spot.z === z ? spot.name : nearestLabel(zc);
  $("#zone").title = `구역 ${zc}`;
  $("#heatInfo").innerHTML = heatHTML(x, z);
}

function selectCell(x, z) {
  setStart(x, z);
  closeDetail();
  // 처음 누르면 작게(접힌 상태)만 올라오고, 이미 펼쳐서 쓰던 중이면 펼친 채로 유지
  openSheet(!$("#sheet").classList.contains("open") || $("#sheet").classList.contains("peek"));
  if (chosenType) chooseType(chosenType);
}

function chooseType(code) {
  chosenType = code;
  document.querySelectorAll(".type").forEach((b) => b.classList.toggle("on", b.dataset.code === code));
  const t = TYPE_BY_CODE[code];
  $("#shapeBox").hidden = t.group !== "fix";
  if (t.group !== "fix") setShape("one", true);
  $("#text").placeholder = "(선택) 한 줄 의견 — 비워도 등록돼요";
  buildChips(t);
  refreshPreview();
}

// ---------------------------------------------------------------- 여러 칸에 놓기 (자유 그리기·네모)
// shape "path": 손가락이 지나간 길(pathPts)을 따라 블록 / "area": 시작점~endCell 네모 안을 채움
function draft() {
  const d = { type: chosenType, x: selected.x, z: selected.z };
  if (shape === "path" && pathPts.length >= 2) Object.assign(d, { shape, points: pathPts });
  if (shape === "area" && endCell) Object.assign(d, { shape, x2: endCell.x, z2: endCell.z });
  return d;
}
function multiReady() {
  return shape === "path" ? pathPts.length >= 2 : shape === "area" ? !!endCell : true;
}
function setShape(s, quiet = false) {
  shape = s;
  endCell = null;
  pathPts = [];
  document.querySelectorAll("#shapeBox .seg button").forEach((b) => b.classList.toggle("on", b.dataset.shape === s));
  if (!quiet) {
    refreshPreview();
    if (s === "one") { setPeekHint(null); setPeek(false); }
    else {
      toast(s === "path" ? "손가락으로 길을 따라 끌어서 그려 주세요 ✍️" : "손가락으로 대각선으로 끌어서 네모를 그려 주세요 ✍️", 3500);
      closeSheetPeek();
    }
  }
}
document.querySelectorAll("#shapeBox .seg button").forEach((b) => { b.onclick = () => setShape(b.dataset.shape); });

// 길에 점 하나를 더한다. 블록이 너무 많아지면 더하지 않고 false
function addPathPoint(c) {
  const last = pathPts[pathPts.length - 1];
  if (last && last[0] === c.x && last[1] === c.z) return true;
  const next = pathPts.length ? [...pathPts, [c.x, c.z]] : [[selected.x, selected.z], [c.x, c.z]];
  if (next.length > MAX_POINTS) return false;
  if (next.length >= 2 && expandCells({ type: chosenType, x: next[0][0], z: next[0][1], shape: "path", points: next }).length > MAX_CELLS) return false;
  pathPts = next;
  return true;
}
// 그리기를 마치면 시트를 펼쳐 효과·의견 입력을 보여준다
function finishDraw() {
  setPeekHint(null);
  setPeek(false);
  refreshPreview();
}
// 끌지 않고 지도를 짧게 누른 경우: 자유 그리기는 그 칸까지 곧게 잇고, 네모는 반대쪽 모서리로
function setEnd(x, z) {
  if (shape === "path") {
    if (!addPathPoint({ x, z })) { toast(`한 번에 ${MAX_CELLS}곳까지예요`); return; }
  } else {
    endCell = { x, z };
  }
  finishDraw();
}
// 그리는 동안은 시트를 접어(#29 의 접기 기능) 지도를 넓게 보여주고, 접힌 곳 안내 문구를 바꾼다
const PEEK_HINT = $(".peek-hint")?.textContent || "";
function setPeekHint(text) {
  const el = $(".peek-hint");
  if (el) el.textContent = text || PEEK_HINT;
}
function closeSheetPeek() {
  setPeekHint(shape === "path" ? "✍️ 끌어서 길 그리기 · 두 손가락으로 지도 이동" : "✍️ 끌어서 네모 그리기 · 두 손가락으로 지도 이동");
  setPeek(true);
}

// ---------------------------------------------------------------- 손가락으로 그리기
// 자유 그리기·네모를 고르고 시트가 접혀 있는 동안: 한 손가락(마우스 왼쪽) 끌기 = 그리기, 두 손가락(마우스 오른쪽) = 지도 이동
const DEFAULT_ONE = controls.touches.ONE, DEFAULT_LEFT = controls.mouseButtons.LEFT;
// drawing 은 위 '상태'에서 선언 (loop()가 첫 프레임부터 읽어서 여기서 선언하면 시작 직후 오류)
let drawRaf = 0;
function drawMode() {
  return !!(selected && chosenType && shape !== "one" && $("#sheet").classList.contains("peek"));
}
function syncDrawControls() {
  const d = drawMode();
  controls.touches.ONE = d ? -1 : DEFAULT_ONE;
  controls.mouseButtons.LEFT = d ? -1 : DEFAULT_LEFT;
  canvas.style.cursor = d ? "crosshair" : "";
}
function cellAt(px, py) {
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return pickCell();
}
function schedulePreview() {
  if (!drawRaf) drawRaf = requestAnimationFrame(() => { drawRaf = 0; refreshPreview(); });
}
canvas.addEventListener("pointerdown", (e) => {
  syncDrawControls();
  if (drawing && e.pointerId !== drawing.id) { // 두 번째 손가락 → 그리던 것 취소, 지도 조작
    drawing = null; pathPts = []; endCell = null; refreshPreview(); return;
  }
  if (!drawMode() || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
  const start = cellAt(e.clientX, e.clientY);
  if (start) drawing = { id: e.pointerId, sx: e.clientX, sy: e.clientY, start, moved: false, capped: false };
});
canvas.addEventListener("pointermove", (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  if (!drawing.moved && Math.hypot(e.clientX - drawing.sx, e.clientY - drawing.sy) < 8) return;
  if (!drawing.moved) { // 끌기 시작: 누른 곳이 새 시작점
    drawing.moved = true;
    setStart(drawing.start.x, drawing.start.z);
    pathPts = [[drawing.start.x, drawing.start.z]];
    endCell = null;
  }
  const c = cellAt(e.clientX, e.clientY);
  if (!c) return;
  if (shape === "area") endCell = c;
  else if (!drawing.capped && !addPathPoint(c)) {
    drawing.capped = true;
    toast(`한 번에 ${MAX_CELLS}곳까지예요. 여기서 멈출게요`);
  }
  schedulePreview();
});
const endDraw = (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  const d = drawing;
  drawing = null;
  if (!d.moved) return; // 짧게 누른 건 탭 처리 쪽에서
  if (multiReady()) finishDraw();
  else { toast("조금 더 길게 그려 주세요 ✍️"); refreshPreview(); }
};
canvas.addEventListener("pointerup", endDraw);
canvas.addEventListener("pointercancel", endDraw);

// 그린 길 미리보기 선 (지형 위에 뜨게)
const pathLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffd43b, depthTest: false, transparent: true, opacity: 0.95 })
);
pathLine.renderOrder = 21;
pathLine.visible = false;
scene.add(pathLine);
function drawPathLine() {
  if (shape !== "path" || pathPts.length < 2) { pathLine.visible = false; return; }
  const arr = new Float32Array(pathPts.length * 3);
  pathPts.forEach(([x, z], i) => arr.set([x + 0.5, heightAt(map, x, z) + 0.3, z + 0.5], i * 3));
  pathLine.geometry.dispose();
  pathLine.geometry = new THREE.BufferGeometry();
  pathLine.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  pathLine.visible = true;
}

// 미리보기(반투명 블록·끝 표시·네모·길)와 효과 문구를 지금 상태로 다시 그린다
function refreshPreview() {
  if (ghost) markerRoot.remove(ghost);
  ghost = null;
  endCursor.visible = false;
  areaBox.visible = false;
  drawPathLine();
  if (!selected || !chosenType) return;
  const d = draft();
  if (isMulti(d)) {
    ghost = makeGroupMarker(d, true);
    const end = shape === "path" ? { x: pathPts[pathPts.length - 1][0], z: pathPts[pathPts.length - 1][1] } : endCell;
    endCursor.position.set(end.x + 0.5, heightAt(map, end.x, end.z), end.z + 0.5);
    endCursor.visible = true;
    if (shape === "area") {
      const x0 = Math.min(d.x, d.x2), x1 = Math.max(d.x, d.x2) + 1, z0 = Math.min(d.z, d.z2), z1 = Math.max(d.z, d.z2) + 1;
      areaBox.scale.set(x1 - x0, 1, z1 - z0);
      areaBox.position.set((x0 + x1) / 2, 0.08, (z0 + z1) / 2);
      areaBox.visible = true;
    }
  } else {
    ghost = makeMarker(chosenType, { ghost: true });
    ghost.position.set(selected.x + 0.5, heightAt(map, selected.x, selected.z), selected.z + 0.5);
  }
  markerRoot.add(ghost);
  showEffect(TYPE_BY_CODE[chosenType]);
  updateSubmit();
}
function multiTooBig() {
  return selected && chosenType && shape !== "one" && multiReady() && expandCells(draft()).length > MAX_CELLS;
}

// 놓기 전에 "이 블록 하나로 주변 지수가 얼마나 내려가는지" 계산해 보여준다
function showEffect(t) {
  const el = $("#effectInfo");
  el.className = "effect-info";
  footprint.visible = false;
  if (!t.effect || !selected) { el.innerHTML = ""; return; }
  if (shape !== "one") return showMultiEffect(t, el);
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
  const hint = d > 0 ? ""
    : before < 45 ? "<br><small>이곳은 이미 시원한 편이에요. 빨간 곳에 놓으면 효과가 커요</small>"
    : before >= 99 ? "<br><small>지수가 가장 높은 구간이라 블록 하나로는 숫자가 그대로예요. 이런 곳일수록 제안이 여러 개 모여야 해요</small>"
    : "";
  el.innerHTML = `${t.icon} ${t.desc} · 약 ${m}m×${m}m<br>놓으면 이 주변 열섬 지수 <b>${Math.round(before)} → ${Math.round(after)}</b> (${d > 0 ? "−" + d : "변화 거의 없음"})${hint}`;
  const sz = t.effect.size;
  footprint.scale.set(sz, 1, sz);
  footprint.position.set(x + 0.5, (t.roofOnly ? heightAt(map, x, z) : 0) + 0.06, z + 0.5);
  footprint.visible = true;
}

// 자유 그리기·네모: 블록 수와, 놓이는 칸들의 평균 지수가 얼마나 내려가는지
function showMultiEffect(t, el) {
  const hint = $("#shapeHint");
  hint.hidden = true;
  if (!multiReady()) {
    el.innerHTML = shape === "path"
      ? `${t.icon} 지도에서 손가락으로 <b>길을 따라 끌어서</b> 그려 주세요 ✍️<br><small>짧게 누르면 그 칸까지 곧게 이어져요 · 두 손가락으로 지도 이동</small>`
      : `${t.icon} 지도에서 손가락으로 <b>대각선으로 끌어서</b> 네모를 그려 주세요 ✍️<br><small>두 손가락으로 지도 이동</small>`;
    return;
  }
  const cells = expandCells(draft());
  if (cells.length > MAX_CELLS) {
    hint.hidden = false;
    hint.textContent = `블록이 ${cells.length}개라 너무 많아요. ${MAX_CELLS}개 이하가 되게 범위를 줄여 주세요.`;
    el.innerHTML = "";
    return;
  }
  const mods = buildMods(map, expandAll([draft()]), TYPE_BY_CODE);
  let b = 0, a = 0;
  for (const p of cells) { b += scoreAt(map, p.x, p.z); a += scoreAt(map, p.x, p.z, mods); }
  b /= cells.length; a /= cells.length;
  const d = Math.round(b) - Math.round(a);
  const cell = map.meta.cell || 5;
  const what = shape === "path"
    ? `그린 길 약 ${Math.round(pathLength(pathPts) * cell)}m에 ${t.label} <b>${cells.length}곳</b>`
    : `가로 ${(Math.abs(endCell.x - selected.x) + 1) * cell}m × 세로 ${(Math.abs(endCell.z - selected.z) + 1) * cell}m 네모에 ${t.label} <b>${cells.length}곳</b>`;
  const more = shape === "path" ? "지도를 누르면 그 칸까지 길이 이어져요 · " : "";
  el.innerHTML = `${t.icon} ${what}<br>놓으면 이 구간 열섬 지수 평균 <b>${Math.round(b)} → ${Math.round(a)}</b> (${d > 0 ? "−" + d : "변화 거의 없음"})<br><small>${more}다시 그리려면 위 버튼을 한 번 더 눌러 주세요 · 제안 1건으로 등록돼요</small>`;
}

function updateSubmit() {
  $("#submit").disabled = !(selected && chosenType) || !multiReady() || multiTooBig(); // 글은 선택 (비우면 유형 이름으로 등록)
}

// 빠른 문구: 거리에서 글쓰기 없이 한 번에 고를 수 있게
const QUICK = {
  fix: ["여름에 너무 더워요", "그늘이 없어요", "아이들이 많이 다녀요"],
  trash: ["자주 쌓여 있어요", "냄새가 나요"], odor: ["매연이 심해요", "하수구 냄새가 나요"],
  noise: ["밤에 시끄러워요", "공사 소음이 심해요"], other: ["위험해 보여요", "고쳐 주세요"],
};
function buildChips(t) {
  const list = t.group === "fix" ? [t.example, ...QUICK.fix].filter(Boolean) : QUICK[t.code] || QUICK.other;
  const box = $("#chips");
  box.innerHTML = "";
  for (const q of [...new Set(list)].slice(0, 4)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip-q"; b.textContent = q;
    b.onclick = () => {
      $("#text").value = $("#text").value.trim() === q ? "" : q;
      box.querySelectorAll(".chip-q").forEach((c) => c.classList.toggle("on", c.textContent === $("#text").value));
      updateSubmit();
    };
    box.append(b);
  }
}
$("#text").addEventListener("input", updateSubmit);

// 아래 시트가 화면을 가리는 만큼 3D 화면 중심을 위로 올린다
function liftView(sheetEl) {
  let h = sheetEl ? sheetEl.getBoundingClientRect().height : 0;
  if (sheetEl && sheetEl.classList.contains("peek")) h = peekHeight();
  if (h) camera.setViewOffset(innerWidth, innerHeight, 0, h / 2, innerWidth, innerHeight);
  else camera.clearViewOffset();
}
function closeReportIfNarrow() {
  if (innerWidth < 1100 && $("#report").classList.contains("open")) $("#tool-report").click();
}
// 접힌 상태에서 보일 높이 = 손잡이 ~ "눌러서 제안하기" 까지
function peekHeight() {
  const top = $("#sheet-top");
  return top.offsetTop + top.offsetHeight + 4;
}
function setPeek(peek) {
  const sh = $("#sheet");
  sh.classList.toggle("peek", peek);
  sh.style.setProperty("--peek", peekHeight() + "px");
  sh.scrollTop = 0;
  liftView(sh);
}
function openSheet(peek = true) {
  closeReportIfNarrow();
  const sh = $("#sheet");
  sh.classList.add("open");
  document.body.classList.add("sheet-open");
  setPeek(peek);
  focusTo = new THREE.Vector3(selected.x + 0.5, 0, selected.z + 0.5);
}

// 손잡이·제목 영역: 누르면 펼치기/접기, 위로 끌면 펼치기, 아래로 끌면 접기(접힌 상태면 닫기)
(() => {
  const top = $("#sheet-top"), sh = $("#sheet");
  let y0 = null, moved = 0;
  top.addEventListener("pointerdown", (e) => { y0 = e.clientY; moved = 0; top.setPointerCapture(e.pointerId); });
  top.addEventListener("pointermove", (e) => {
    if (y0 == null) return;
    moved = e.clientY - y0;
    if (Math.abs(moved) > 4) {
      sh.classList.add("dragging");
      const base = sh.classList.contains("peek") ? sh.offsetHeight - peekHeight() : 0;
      sh.style.transform = `translateY(${Math.max(0, base + moved)}px)`;
    }
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    sh.classList.remove("dragging");
    sh.style.transform = "";
    const peek = sh.classList.contains("peek");
    if (Math.abs(moved) <= 6) setPeek(!peek);          // 탭
    else if (moved < -30) setPeek(false);              // 위로 끌기 → 펼치기
    else if (moved > 30) peek ? closeSheet() : setPeek(true); // 아래로 끌기 → 접기 / 닫기
  };
  top.addEventListener("pointerup", end);
  top.addEventListener("pointercancel", end);
  top.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPeek(!sh.classList.contains("peek")); } });
})();
function closeSheet() {
  $("#sheet").classList.remove("open", "peek");
  document.body.classList.remove("sheet-open");
  liftView(null);
  cursor.visible = false;
  footprint.visible = false;
  $("#effectInfo").innerHTML = "";
  if (ghost) markerRoot.remove(ghost);
  ghost = null;
  selected = null;
  endCursor.visible = false;
  areaBox.visible = false;
  setShape("one", true);
  pathLine.visible = false;
  setPeekHint(null);
  $("#shapeHint").hidden = true;
}
$("#cancel").onclick = () => {
  closeSheet();
  if (spotFlow) { spotFlow = false; showSpotCard(); } // QR로 왔다가 취소하면 카드로 돌아감
};

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected || !chosenType) return;
  if (shape === "one" && TYPE_BY_CODE[chosenType].roofOnly && heightAt(map, selected.x, selected.z) === 0) {
    toast("옥상녹화는 건물 옥상을 눌러 주세요 🏠");
    return;
  }
  const btn = $("#submit");
  btn.disabled = true;
  btn.textContent = "등록 중…";
  const { x, z } = selected;
  const extra = shape === "path" && pathPts.length >= 2 ? { shape, points: pathPts }
    : shape === "area" && endCell ? { shape, x2: endCell.x, z2: endCell.z } : {};
  try {
    const c = await api("/api/complaints", {
      method: "POST",
      body: JSON.stringify({
        x, z, ...cellToLatLng(map.meta, x, z), zone: zoneOf(map.meta, x, z),
        type: chosenType, text: $("#text").value.trim(), ...extra,
      }),
    });
    addMarker(c, true);
    rememberMine(c.id);
    $("#count").textContent = markers.size;
    $("#text").value = "";
    closeSheet();
    onProposalsChanged();
    const n = expandCells(c).length, where = n > 1 ? n + "곳에 " : "";
    toast(spotFlow ? `등록됐어요! ${TYPE_BY_CODE[c.type].icon} ${where}지자체 대시보드에 바로 반영돼요 🎉`
                   : `등록됐어요! ${TYPE_BY_CODE[c.type].icon} ${TYPE_BY_CODE[c.type].label} 블록을 ${where}놓았어요 🎉`, 3500);
    spotFlow = false;
    $("#chips").innerHTML = "";
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
  closeReportIfNarrow();
  closeSheet();
  detailId = c.id;
  const t = TYPE_BY_CODE[c.type] || TYPE_BY_CODE.other;
  const n = expandCells(c).length;
  $("#d-type").textContent = `${t.icon} ${t.label}${n > 1 ? ` · ${n}곳` : ""}`;
  $("#d-zone").textContent = nearestLabel(c.zone);
  $("#d-zone").title = `구역 ${c.zone}`;
  $("#d-heat").innerHTML = heatHTML(c.x, c.z);
  $("#d-text").textContent = c.text;
  $("#d-time").textContent = new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  paintDetailStatus(c);
  $("#detail").classList.add("open");
}
function paintDetailStatus(c) {
  const st = c.status || "received";
  const b = $("#d-status");
  b.className = `badge ${st}`; b.textContent = STATUS_LABEL[st] || st;
  $("#d-reply").hidden = !c.reply;
  $("#d-reply").textContent = c.reply ? `💬 담당자 안내: ${c.reply}` : "";
  $("#d-like").textContent = `👍 공감 ${c.likes}`;
  $("#d-like").disabled = likedIds().includes(c.id);
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
  $("#legend").hidden = !on;
  syncView();
  if (on && !quiet) toast("빨간 곳일수록 여름철 열이 많이 쌓이는 곳이에요", 3500);
}
// 아래 보기 전환: 지도 | 열섬 | 제안 반영 후 — 셋 중 하나만 켜진다
function syncView() {
  $("#view-plain").setAttribute("aria-pressed", String(!heatOn));
  $("#tool-heat").setAttribute("aria-pressed", String(heatOn && !simOn));
  $("#tool-sim").setAttribute("aria-pressed", String(simOn));
}
$("#view-plain").onclick = () => heat && heatOn && setHeat(false);
$("#tool-heat").onclick = () => {
  if (!heat) return;
  if (simOn) setSim(false, true);
  if (!heatOn) setHeat(true, true);
};
$("#legend").onclick = () => {
  const el = $("#legend"), open = !el.classList.contains("expanded");
  el.classList.toggle("expanded", open);
  el.setAttribute("aria-expanded", String(open));
};

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
  if (on) {
    heatSim = computeHeat(map, buildMods(map, expandAll(proposals()), TYPE_BY_CODE));
    if (!heatOn) setHeat(true, true);
    paintHeat(world, map, heatSim, true);
    const st = simStats(heat, heatSim);
    $("#heatAvg").innerHTML = `${Math.round(baseAvg)} · 제안 영향권 ${st.ha.toFixed(1)}ha <span style="color:#2f9e44">${Math.round(st.before)} → ${Math.round(st.after)}</span>`;
    if (!quiet) toast(proposals().length ? `시민 제안 ${proposals().length}건이 실현되면 영향권 ${st.ha.toFixed(1)}ha가 평균 ${Math.round(st.before)} → ${Math.round(st.after)}로 시원해져요` : "아직 개선 제안이 없어요. 지도를 눌러 첫 제안을 해 보세요", 5000);
  } else {
    heatSim = null;
    $("#heatAvg").textContent = Math.round(baseAvg);
    if (heatOn) paintHeat(world, map, heat, true);
  }
  syncView();
  renderReport();
}
$("#tool-sim").onclick = () => heat && !simOn && setSim(true);
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
  if (spot) { flySpot(); showSpotCard(); return; } // QR로 왔으면 '처음 위치' = 지금 계신 곳
  homeView();
};

// 처음 화면: 지도 한가운데(무실동은 서쪽 절반이 숲)가 아니라 열이 많이 쌓이는 시가지를 중심으로.
// 지수 60 이상 칸의 무게중심을 보고, 지도 전체가 아니라 시가지가 화면을 채우도록 조금 가깝게.
let home = null;
function homeView() {
  const { width: W, depth: D } = map.meta;
  if (!home) {
    let sx = 0, sz = 0, n = 0;
    if (heat) {
      for (let z = 0; z < D; z += 2) for (let x = 0; x < W; x += 2) {
        const v = heat.value[z * W + x];
        if (v >= 60) { const w = v - 59; sx += x * w; sz += z * w; n += w; }
      }
    }
    home = n ? { x: sx / n, z: sz / n, k: 0.6 } : { x: W / 2, z: D / 2, k: 1 };
  }
  const M = Math.max(W, D) * home.k;
  controls.target.set(home.x, 0, home.z);
  camera.position.set(home.x + M * 0.35, M * 0.45, home.z + M * 0.55);
}
// 폰(터치): 도구 버튼을 누르면 설명을 1.5초 보여줌
for (const b of document.querySelectorAll(".tool[data-tip]")) {
  let t = 0;
  b.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    document.querySelectorAll(".tool.tip-show").forEach((o) => o.classList.remove("tip-show"));
    b.classList.add("tip-show");
    clearTimeout(t); t = setTimeout(() => b.classList.remove("tip-show"), 1500);
  });
}
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
    const sim = simOn ? heatSim : computeHeat(map, buildMods(map, expandAll(props), TYPE_BY_CODE));
    const st = simStats(heat, sim);
    $("#r-sim").innerHTML = `<div class="r-sim">개선 제안 <b>${props.length}건</b>이 모두 실현되면<br>
      영향권 <b>${st.ha.toFixed(1)}ha</b>의 평균 열섬 지수<br><span class="big">${Math.round(st.before)} → ${Math.round(st.after)}</span>
      <b style="color:#2f9e44">(−${Math.round(st.before - st.after)})</b><br>
      3점 이상 시원해지는 곳 <b>${st.bigHa.toFixed(1)}ha</b> · 무실동 전체 평균 ${baseAvg.toFixed(1)} → ${meanHeat(sim).toFixed(1)}</div>
      ${simOn ? "" : `<p class="hint">아래 '제안 반영 후'를 누르면 지도에서 볼 수 있어요</p>`}`;
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
let mouse = null, probeAt = 0, probeOff = false; // probeOff: 지도 밖(하늘)을 가리키는 중
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const probeHit = new THREE.Vector3();
canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") mouse = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerleave", () => { mouse = null; });

// 열섬 지수 → 주변 평균 대비 추정 기온 차이 (PoC 가정: 지수 0점 −3°C ~ 100점 +3°C, 도시 열섬 강도 문헌값 수준)
const tempOffset = (v) => (v - 50) * 0.06;

function updateProbe() {
  const el = $("#probe"), ch = $("#crosshair");
  const show = heatOn && map && (!HOVER || mouse);
  // 매 프레임 '보이기'로 되돌리지 않게 지도 밖 상태를 기억 (안 그러면 하늘 쪽에서 깜빡임)
  el.hidden = !show || probeOff;
  ch.hidden = !(heatOn && map && !HOVER);
  if (!show) return;
  // 카드 위치는 매 프레임 마우스를 따라감 (수치 계산만 아래에서 띄엄띄엄 — 건물 2만여 개 광선 검사가 무거움)
  if (HOVER) { el.style.left = mouse.x + "px"; el.style.top = mouse.y + "px"; }
  const now = performance.now();
  if (now - probeAt < (HOVER ? 80 : 90)) return;
  probeAt = now;
  const px = HOVER ? mouse.x : innerWidth / 2, py = HOVER ? mouse.y : innerHeight / 2;
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // PC는 건물까지 정확히 (마우스 아래 건물), 폰은 가벼운 지면 계산
  const hit = HOVER ? ray.intersectObject(world.buildings, false)[0] : null;
  if (hit) probeHit.copy(hit.point).addScaledVector(hit.face.normal, -0.01);
  else if (!ray.ray.intersectPlane(groundPlane, probeHit)) { probeOff = el.hidden = true; return; }
  const x = Math.floor(probeHit.x), z = Math.floor(probeHit.z);
  if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) { probeOff = el.hidden = true; return; }
  probeOff = el.hidden = false;
  const h = simOn && heatSim ? heatSim : heat;
  const v = Math.round(h.value[z * map.meta.width + x]);
  const lv = heatLevel(v);
  // 지수는 '여름철 열이 쌓이는 정도'라서 지금 기온(겨울엔 10°C 등)에 더하지 않고, 여름 한낮 기준 차이만 보여준다
  const dT = tempOffset(v);
  const tLine = `<small>여름 한낮엔 보통 지역보다 약 ${dT >= 0 ? "+" : "−"}${Math.abs(dT).toFixed(1)}°C <span class="muted">(추정)</span></small>`;
  let sim = "";
  if (simOn && heatSim) {
    const d = Math.round(heat.value[z * map.meta.width + x]) - v;
    if (d > 0) sim = `<br><small style="color:#2f9e44">시민 제안으로 −${d}점</small>`;
  }
  el.style.borderLeftColor = lv.color;
  el.innerHTML = `🌡️ <span class="v" style="color:${lv.color}">${v}</span><span class="lv" style="color:${lv.color}">${lv.text}</span><br>${tLine}${sim}`;
  el.classList.toggle("center", !HOVER);
}

// ---------------------------------------------------------------- 실시간 기온·대기질 (에어코리아·기상청)
const AIR_COLOR = { 좋음: "#1c7ed6", 보통: "#2f9e44", 나쁨: "#f76707", 매우나쁨: "#e03131" };
async function loadEnv() {
  try {
    const d = await api("/api/env");
    lastEnv = d;
    renderReport();
    const w = d.weather, a = d.air;
    const parts = [];
    if (w && w.temp != null) parts.push(`지금 <b>${w.temp.toFixed(1)}°C</b>`);
    if (a && a.pm25 != null) {
      const g = a.pm25_grade || a.grade || "";
      parts.push(`<span class="env-dot" style="background:${AIR_COLOR[g] || "#868e96"}"></span>초미세먼지 ${g || a.pm25}`);
    }
    const src = [w && "기상청", a && `에어코리아 ${a.station}`].filter(Boolean).join(", ");
    $("#envNow").innerHTML = parts.length ? parts.join("<i class=\"sep\"></i>") : "시민이 함께 만드는 시원한 동네";
    $("#envNow").title = src ? `실시간 출처: ${src}` : "";
  } catch {
    $("#envNow").textContent = "시민이 함께 만드는 시원한 동네";
  }
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
