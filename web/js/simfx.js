// '제안 반영 후' 연출: 지도가 서서히 식어 가는 애니메이션 + 숫자 카운트다운 + 제안 타임랩스용 도우미
// 바뀌는 칸만 다시 칠해서(전체 31만 칸 중 수천 칸) 폰에서도 매 프레임 부드럽게 돌아간다.
import * as THREE from "three";
import { heatRGB } from "./heat.js";

/** 두 열섬 결과(from → to) 사이에서 값이 바뀌는 칸과 그 위 건물 목록 */
export function diffCells(map, from, to, eps = 0.05) {
  const { width: W } = map.meta;
  const idx = [];
  for (let i = 0; i < from.value.length; i++) if (Math.abs(from.value[i] - to.value[i]) >= eps) idx.push(i);
  const changed = new Uint8Array(from.value.length);
  for (const i of idx) changed[i] = 1;
  const roofs = []; // [건물 번호, 칸 번호]
  const b = map.buildings;
  for (let k = 0, j = 0; j < b.length; j += 4, k++) {
    const i = b[j + 1] * W + b[j];
    if (changed[i]) roofs.push(k, i);
  }
  return { idx: Int32Array.from(idx), roofs: Int32Array.from(roofs) };
}

const COOL = [64, 200, 255]; // 시원해지는 칸이 잠깐 빛나는 색
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** t(0~1)만큼 from→to 로 섞어 바뀌는 칸만 칠함. glow(0~1) 만큼 시원해진 칸을 하늘색으로 빛나게 */
export function paintBlend(world, map, from, to, diff, t, glow = 0) {
  const tex = world.groundTex.image.data, base = world.groundBase;
  const e = ease(t);
  const mix = (i) => {
    const a = from.value[i], b = to.value[i];
    const v = a + (b - a) * e;
    let [r, g, bl] = heatRGB(v);
    const cool = Math.min(1, Math.max(0, (a - b) / 6)) * glow; // 많이 식은 곳일수록 더 빛남
    if (cool > 0) { r += (COOL[0] - r) * cool; g += (COOL[1] - g) * cool; bl += (COOL[2] - bl) * cool; }
    return [r, g, bl];
  };
  for (const i of diff.idx) {
    const [r, g, bl] = mix(i);
    const shade = base[i * 4] / 255 * 0.25 + 0.75;
    tex[i * 4] = r * shade; tex[i * 4 + 1] = g * shade; tex[i * 4 + 2] = bl * shade;
  }
  world.groundTex.needsUpdate = true;
  if (diff.roofs.length) {
    const roof = world.buildings.geometry.getAttribute("aRoof"), c = new THREE.Color();
    for (let j = 0; j < diff.roofs.length; j += 2) {
      const [r, g, bl] = mix(diff.roofs[j + 1]);
      c.setRGB(r / 255, g / 255, bl / 255, THREE.SRGBColorSpace).toArray(roof.array, diff.roofs[j] * 3);
    }
    roof.needsUpdate = true;
  }
}

/** ms 동안 from→to 로 식어 가는 애니메이션. 취소하려면 돌려받은 함수 호출 */
export function animateBlend(world, map, from, to, ms, { glowPeak = 1, onFrame, onDone } = {}) {
  const diff = diffCells(map, from, to);
  const t0 = performance.now();
  let stop = false, raf = 0;
  const step = () => {
    if (stop) return;
    const t = Math.min(1, (performance.now() - t0) / ms);
    paintBlend(world, map, from, to, diff, t, glowPeak * Math.sin(Math.PI * t));
    onFrame?.(ease(t));
    if (t < 1) raf = requestAnimationFrame(step);
    else { paintBlend(world, map, from, to, diff, 1, 0); onDone?.(); }
  };
  raf = requestAnimationFrame(step);
  return () => { stop = true; cancelAnimationFrame(raf); };
}

/** 영향권 통계. region(최종 영향권 칸 표시)을 주면 그 칸들로 평균 → 재생 중에도 숫자가 한 방향으로만 내려감 */
export function coolStats(map, base, sim, region = null) {
  let n = 0, b = 0, a = 0, cooled = 0, max = 0;
  for (let i = 0; i < base.value.length; i++) {
    const d = base.value[i] - sim.value[i];
    if (d >= 0.5) cooled++;
    if (d > max) max = d;
    if (region ? region[i] : d >= 0.5) { n++; b += base.value[i]; a += sim.value[i]; }
  }
  return { ha: cooled * (map.meta.cell || 5) ** 2 / 10000, before: n ? b / n : 0, after: n ? a / n : 0, max };
}
export function regionOf(base, sim) {
  const r = new Uint8Array(base.value.length);
  for (let i = 0; i < r.length; i++) if (base.value[i] - sim.value[i] >= 0.5) r[i] = 1;
  return r;
}

/** 퍼지는 고리 (제안이 놓일 때) — 렌더 루프에서 tickRipples 호출 */
const ripples = [];
const ringGeo = new THREE.RingGeometry(0.82, 1, 56).rotateX(-Math.PI / 2);
export function addRipple(scene, x, y, z, radius = 14, color = 0x40c8ff) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
  m.position.set(x, y + 0.4, z);
  m.renderOrder = 4;
  scene.add(m);
  ripples.push({ m, t0: performance.now(), radius, scene });
}
export function tickRipples() {
  const now = performance.now();
  for (let k = ripples.length - 1; k >= 0; k--) {
    const r = ripples[k], t = (now - r.t0) / 1100;
    if (t >= 1) { r.scene.remove(r.m); r.m.material.dispose(); ripples.splice(k, 1); continue; }
    const s = 1 + (r.radius - 1) * (1 - (1 - t) ** 3);
    r.m.scale.set(s, 1, s);
    r.m.material.opacity = 0.9 * (1 - t);
  }
}
