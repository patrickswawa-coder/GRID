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

/** extraGreen: 시뮬레이션용 (칸마다 추가 녹지 0~1). 반환: { value(0~100, 칸별), stats } */
export function computeHeat(map, extraGreen = null) {
  const { width: W, depth: D } = map.meta;
  const N = W * D;
  const imp = new Float32Array(N), bld = new Float32Array(N), hgt = new Float32Array(N);
  const grn = new Float32Array(N), wat = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = map.ground[i], h = map.heights[i];
    if (h > 0) { bld[i] = 1; hgt[i] = Math.min(h / 8, 1); imp[i] = 1; }
    else if (t === ROAD || t === SIDEWALK) imp[i] = 1;
    else if (t === PARK) grn[i] = 1;
    else if (t === GRASS) grn[i] = 0.6; // 밭·빈 풀밭: 녹지의 일부 효과
    else if (t === WATER) wat[i] = 1;
    if (extraGreen && extraGreen[i]) { grn[i] = Math.min(1, grn[i] + extraGreen[i]); imp[i] *= 1 - extraGreen[i] * 0.5; }
  }
  const [mi, mb, mh, mg, mw] = [imp, bld, hgt, grn, wat].map((a) => boxMean(a, W, D, RADIUS));
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) raw[i] = 0.45 * mi[i] + 0.2 * mb[i] + 0.15 * mh[i] - 0.45 * mg[i] - 0.3 * mw[i];
  // 고정 구간으로 0~100 변환 (시뮬레이션 전후 비교가 가능하도록 지도마다 다시 정규화하지 않음)
  // 시가지 값이 좁은 구간(0.15~0.55)에 몰려 있어서 그 구간을 넓게 펼친다
  const value = new Float32Array(N);
  for (let i = 0; i < N; i++) value[i] = toScore(raw[i]);
  return { value };
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
