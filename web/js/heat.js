// 열섬 위험 지수: 칸마다 주변(반경 R칸)의 포장면·건물·녹지·물 비율로 계산 → 0(시원)~100(뜨거움)
//
//   지수 = 0.45·포장면 + 0.20·건물덮개 + 0.15·건물높이 − 0.45·녹지 − 0.30·물   (주변 평균)
//
// 근거(발표용): 도시 지표면 온도는 불투수면(포장·지붕) 비율과 양(+)의 관계, 녹지(식생)·수면 비율과
// 음(−)의 관계가 일관되게 보고됨. 고층 밀집은 바람길을 막고 야간 복사냉각을 줄여 열을 가둔다.
// 가중치는 PoC용 단순 모델이며, 위성 지표온도(Landsat 등)로 보정하는 것이 다음 단계.
import * as THREE from "three";

const GRASS = 0, ROAD = 1, SIDEWALK = 2, PARK = 3, WATER = 4;
export const RADIUS = 10; // 10칸 = 50m 반경 평균

// 합 테이블(summed-area table)로 반경 평균을 빠르게
function boxMean(src, W, D, R) {
  const S = new Float64Array((W + 1) * (D + 1));
  for (let z = 0; z < D; z++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[z * W + x];
      S[(z + 1) * (W + 1) + x + 1] = S[z * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * D);
  for (let z = 0; z < D; z++) {
    const z0 = Math.max(0, z - R), z1 = Math.min(D, z + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const sum = S[z1 * (W + 1) + x1] - S[z0 * (W + 1) + x1] - S[z1 * (W + 1) + x0] + S[z0 * (W + 1) + x0];
      out[z * W + x] = sum / ((x1 - x0) * (z1 - z0));
    }
  }
  return out;
}

/** 칸 하나의 환경 특성 [포장면, 건물덮개, 건물높이, 녹지, 수면] — mods(시민 제안 효과)를 반영 */
function features(map, i, mods, out) {
  const t = map.ground[i], h = map.heights[i];
  let im = 0, b = 0, hh = 0, g = 0, w = 0;
  if (h > 0) { b = 1; hh = Math.min(h / 8, 1); im = 1; }
  else if (t === ROAD || t === SIDEWALK) im = 1;
  else if (t === PARK) g = 1;
  else if (t === GRASS) g = 0.6; // 밭·빈 풀밭: 녹지의 일부 효과
  else if (t === WATER) w = 1;
  if (mods) {
    const rc = mods.roofCut[i];
    if (rc && h > 0) { b *= 1 - rc * 0.5; hh *= 1 - rc * 0.5; im *= 1 - rc * 0.8; g = Math.max(g, rc * 0.7); }
    const ic = mods.impCut[i];
    if (ic && h === 0) im *= 1 - ic;
    const eg = mods.green[i];
    if (eg && h === 0) { g = Math.min(1, g + eg); im *= 1 - eg * 0.7; }
    const ew = mods.water[i];
    if (ew) w = Math.min(1, w + ew);
  }
  out[0] = im; out[1] = b; out[2] = hh; out[3] = g; out[4] = w;
}

const W8 = [0.45, 0.2, 0.15, -0.45, -0.3]; // 포장면, 건물덮개, 높이, 녹지(−), 수면(−)

/** mods: buildMods() 결과 또는 null. 반환: { value: Float32Array(0~100, 칸별) } */
export function computeHeat(map, mods = null) {
  const { width: W, depth: D } = map.meta;
  const N = W * D;
  const comb = new Float32Array(N); // 가중합을 먼저 만들고 한 번만 평균 (평균은 선형이라 결과 동일)
  const f = new Float32Array(5);
  for (let i = 0; i < N; i++) {
    features(map, i, mods, f);
    comb[i] = W8[0] * f[0] + W8[1] * f[1] + W8[2] * f[2] + W8[3] * f[3] + W8[4] * f[4];
  }
  const raw = boxMean(comb, W, D, RADIUS);
  // 고정 구간으로 0~100 변환 (시뮬레이션 전후 비교가 가능하도록 지도마다 다시 정규화하지 않음)
  // 시가지 값이 좁은 구간(0.15~0.55)에 몰려 있어서 그 구간을 넓게 펼친다
  const value = new Float32Array(N);
  for (let i = 0; i < N; i++) value[i] = toScore(raw[i]);
  return { value };
}

/** 한 칸의 지수만 빠르게 (미리보기용): 주변 반경 RADIUS 평균 */
export function scoreAt(map, x, z, mods = null) {
  const { width: W, depth: D } = map.meta;
  const f = new Float32Array(5);
  let sum = 0, n = 0;
  for (let zz = Math.max(0, z - RADIUS); zz <= Math.min(D - 1, z + RADIUS); zz++) {
    for (let xx = Math.max(0, x - RADIUS); xx <= Math.min(W - 1, x + RADIUS); xx++) {
      features(map, zz * W + xx, mods, f);
      sum += W8[0] * f[0] + W8[1] * f[1] + W8[2] * f[2] + W8[3] * f[3] + W8[4] * f[4];
      n++;
    }
  }
  return toScore(sum / n);
}

/** 시민 개선 제안 목록 [{type, x, z}] → 칸별 효과 배열 */
export function buildMods(map, proposals, typeByCode) {
  const { width: W, depth: D } = map.meta;
  const N = W * D;
  const mods = { green: new Float32Array(N), water: new Float32Array(N), impCut: new Float32Array(N), roofCut: new Float32Array(N), count: 0 };
  for (const p of proposals) {
    const e = typeByCode[p.type]?.effect;
    if (!e) continue;
    mods.count++;
    const r = Math.floor(e.size / 2);
    for (let z = Math.max(0, p.z - r); z <= Math.min(D - 1, p.z + r); z++) {
      for (let x = Math.max(0, p.x - r); x <= Math.min(W - 1, p.x + r); x++) {
        const i = z * W + x;
        if (e.green) mods.green[i] = Math.min(1, mods.green[i] + e.green);
        if (e.water) mods.water[i] = Math.min(1, mods.water[i] + e.water);
        if (e.impCut) mods.impCut[i] = Math.min(1, mods.impCut[i] + e.impCut);
        if (e.roofCut) mods.roofCut[i] = Math.min(1, mods.roofCut[i] + e.roofCut);
      }
    }
  }
  return mods;
}

/** 평균 지수 */
export function meanHeat(heat) {
  let t = 0;
  for (let i = 0; i < heat.value.length; i++) t += heat.value[i];
  return t / heat.value.length;
}

const ANCHORS = [[-0.45, 0], [0.15, 40], [0.42, 70], [0.56, 100]];
function toScore(r) {
  if (r <= ANCHORS[0][0]) return 0;
  for (let k = 1; k < ANCHORS.length; k++) {
    const [r0, v0] = ANCHORS[k - 1], [r1, v1] = ANCHORS[k];
    if (r <= r1) return v0 + ((r - r0) / (r1 - r0)) * (v1 - v0);
  }
  return 100;
}

export function heatLevel(v) {
  if (v >= 85) return { text: "매우 높음", color: "#e03131" };
  if (v >= 70) return { text: "높음", color: "#f76707" };
  if (v >= 45) return { text: "보통", color: "#f59f00" };
  return { text: "낮음", color: "#2f9e44" };
}

// 0~100 → 초록·노랑·주황·빨강
const STOPS = [
  [0, [47, 158, 68]], [35, [148, 216, 45]], [55, [252, 216, 60]], [70, [252, 160, 30]], [85, [240, 80, 40]], [100, [190, 25, 45]],
];
export function heatRGB(v) {
  for (let k = 1; k < STOPS.length; k++) {
    if (v <= STOPS[k][0]) {
      const [a, ca] = STOPS[k - 1], [b, cb] = STOPS[k];
      const t = (v - a) / (b - a);
      return ca.map((c, j) => Math.round(c + (cb[j] - c) * t));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** 지면·지붕 색을 열섬 색으로 바꾸거나(on) 원래대로(off) */
export function paintHeat(world, map, heat, on) {
  const { width: W } = map.meta;
  const tex = world.groundTex.image.data, base = world.groundBase;
  if (!on) {
    tex.set(base);
  } else {
    for (let i = 0; i < heat.value.length; i++) {
      const [r, g, b] = heatRGB(heat.value[i]);
      const shade = base[i * 4] / 255 * 0.25 + 0.75; // 바닥 질감을 조금 남김
      tex[i * 4] = r * shade; tex[i * 4 + 1] = g * shade; tex[i * 4 + 2] = b * shade;
    }
  }
  world.groundTex.needsUpdate = true;

  const roof = world.buildings.geometry.getAttribute("aRoof");
  const b = map.buildings, c = new THREE.Color();
  for (let i = 0, k = 0; i < b.length; i += 4, k++) {
    if (!on) { roof.array.set(world.roofBase.subarray(k * 3, k * 3 + 3), k * 3); continue; }
    const [r, g, bl] = heatRGB(heat.value[b[i + 1] * W + b[i]]);
    c.setRGB(r / 255, g / 255, bl / 255, THREE.SRGBColorSpace).toArray(roof.array, k * 3);
  }
  roof.needsUpdate = true;
}

/** 구역(zone_size 칸)별 평균 지수 — 대시보드/설명용 */
export function zoneHeat(map, heat) {
  const { width: W, depth: D, zone_size: s = 40 } = map.meta;
  const acc = {};
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const key = String.fromCharCode(65 + Math.floor(x / s)) + (Math.floor(z / s) + 1);
    (acc[key] ||= [0, 0]);
    acc[key][0] += heat.value[z * W + x]; acc[key][1]++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, [sum, n]]) => [k, Math.round(sum / n)]));
}
