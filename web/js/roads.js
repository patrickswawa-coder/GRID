// 도로 표시 — 큰길의 노란 중앙선과 흰 가장자리선을 "매끄러운 선"으로 그린다.
// 5m 칸(계단) 그대로 그리면 대각선 길이 톱니처럼 보여서:
//  1) 차도 칸을 가늘게 깎아 뼈대(1칸 굵기 중심선)를 만들고 (Zhang-Suen thinning)
//  2) 뼈대를 선(polyline)으로 따라간 뒤 곧게 펴고(Douglas-Peucker) 모서리를 둥글린다(Chaikin)
//  3) 교차로 부근은 선을 끊는다 (실제 도로처럼)
//  4) 가장자리선은 중앙선을 길 폭(차도 밖까지 거리)만큼 양옆으로 평행 이동해 만든다
// 결과는 얇은 사각형 조각들(InstancedMesh 하나). 열섬을 켜면 app.js 가 숨긴다.
import * as THREE from "three";

const ROAD = 1, WATER = 4;
const MIN_HALF = 3;   // 차도 밖까지 3칸 이상 = 폭 25m 이상 큰길만
const MIN_LEN = 10;   // 10칸(50m)보다 짧은 선은 버림
const DP_TOL = 1.2;   // 곧게 펴는 정도(칸)

export function computeRoadLines(map) {
  const { width: W, depth: D } = map.meta;
  const N = W * D;
  const road = new Uint8Array(N);
  for (let i = 0; i < N; i++) road[i] = map.ground[i] === ROAD && !(map.heights[i] > 0) ? 1 : 0;

  // 차도 칸마다 차도 밖까지 거리(4방향, 칸)
  const dist = new Int16Array(N).fill(-1);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (!road[i]) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], x = i % W, z = (i / W) | 0;
    if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = dist[i] + 1; q[qt++] = i - 1; }
    if (x < W - 1 && dist[i + 1] < 0) { dist[i + 1] = dist[i] + 1; q[qt++] = i + 1; }
    if (z > 0 && dist[i - W] < 0) { dist[i - W] = dist[i] + 1; q[qt++] = i - W; }
    if (z < D - 1 && dist[i + W] < 0) { dist[i + W] = dist[i] + 1; q[qt++] = i + W; }
  }
  for (let i = 0; i < N; i++) if (dist[i] < 0) dist[i] = MIN_HALF;

  // 0) 가장자리 톱니를 줄이려고 3×3 다수결로 두 번 다듬음 (뼈대에 잔가지가 덜 생김)
  let sk = road.slice();
  for (let r = 0; r < 2; r++) {
    const o = new Uint8Array(N);
    for (let z = 1; z < D - 1; z++) for (let x = 1; x < W - 1; x++) {
      const i = z * W + x;
      const s = sk[i - W - 1] + sk[i - W] + sk[i - W + 1] + sk[i - 1] + sk[i] + sk[i + 1] + sk[i + W - 1] + sk[i + W] + sk[i + W + 1];
      o[i] = s >= 5 ? 1 : 0;
    }
    sk = o;
  }
  // 1) 뼈대: Zhang-Suen thinning
  const nb = (i, x, z) => [
    z > 0 ? sk[i - W] : 0, z > 0 && x < W - 1 ? sk[i - W + 1] : 0, x < W - 1 ? sk[i + 1] : 0,
    z < D - 1 && x < W - 1 ? sk[i + W + 1] : 0, z < D - 1 ? sk[i + W] : 0, z < D - 1 && x > 0 ? sk[i + W - 1] : 0,
    x > 0 ? sk[i - 1] : 0, z > 0 && x > 0 ? sk[i - W - 1] : 0,
  ]; // P2..P9 (북부터 시계방향)
  for (let changed = true, iter = 0; changed && iter < 60; iter++) {
    changed = false;
    for (const step of [0, 1]) {
      const del = [];
      for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
        const i = z * W + x;
        if (!sk[i]) continue;
        const p = nb(i, x, z);
        const B = p.reduce((a, b) => a + b, 0);
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        del.push(i);
      }
      if (del.length) changed = true;
      for (const i of del) sk[i] = 0;
    }
  }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nbrs = (i) => {
    const x = i % W, z = (i / W) | 0, out = [];
    for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < W && nz < D && sk[nz * W + nx]) out.push(nz * W + nx);
    }
    return out;
  };
  // 잔가지 쳐내기: 끝점에서 교차점까지 SPUR 칸보다 짧은 가지는 지움 (세 번 반복)
  const SPUR = 10;
  for (let round = 0; round < 3; round++) {
    const ends = [];
    for (let i = 0; i < N; i++) if (sk[i] && nbrs(i).length === 1) ends.push(i);
    for (const e of ends) {
      const path = [e];
      let prev = -1, cur = e;
      while (path.length <= SPUR) {
        const n = nbrs(cur).filter((j) => j !== prev);
        if (n.length !== 1) break; // 교차점이나 끝
        prev = cur; cur = n[0];
        if (nbrs(cur).length >= 3) { path.push(-1); break; }
        path.push(cur);
      }
      if (path[path.length - 1] === -1 && path.length <= SPUR + 1) for (const i of path) if (i >= 0) sk[i] = 0;
    }
  }
  // 큰길 뼈대만
  for (let i = 0; i < N; i++) if (sk[i] && dist[i] < MIN_HALF) sk[i] = 0;

  // 2) 뼈대를 선으로 따라가기. 교차점 = 주위 8칸을 한 바퀴 돌 때 끊김이 3번 이상 (계단 모서리는 교차점 아님)
  const cross = (i) => {
    const p = nb(i, i % W, (i / W) | 0);
    let A = 0;
    for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
    return A;
  };
  const deg = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (sk[i]) deg[i] = nbrs(i).length;
  const isJ = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (sk[i] && cross(i) >= 3) isJ[i] = 1;
  const junction = (i) => isJ[i] === 1;
  const isNode = (i) => junction(i) || deg[i] === 1;
  const seen = new Uint8Array(N);
  const chains = [];
  const xy = (i) => [i % W, (i / W) | 0];
  const walk = (start, first) => {
    const path = [start];
    let prev = start, cur = first;
    while (true) {
      path.push(cur);
      if (isNode(cur) && cur !== start) break;
      seen[cur] = 1;
      const cand = nbrs(cur).filter((j) => j !== prev && j !== start && !seen[j]);
      const node = cand.find((j) => isNode(j));
      if (node !== undefined && cand.every((j) => isNode(j) || nbrs(j).includes(node))) { path.push(node); break; }
      const free = cand.filter((j) => !isNode(j));
      if (!free.length) { if (node !== undefined) path.push(node); break; }
      const [px, pz] = xy(prev);
      free.sort((u, v) => { const [ux, uz] = xy(u), [vx, vz] = xy(v); return Math.hypot(vx - px, vz - pz) - Math.hypot(ux - px, uz - pz); });
      prev = cur; cur = free[0];
    }
    return path;
  };
  for (let i = 0; i < N; i++) {
    if (!sk[i] || !isNode(i)) continue;
    for (const j of nbrs(i)) if (!seen[j] && !isNode(j)) chains.push(walk(i, j));
  }
  for (let i = 0; i < N; i++) if (sk[i] && !seen[i] && !isNode(i)) { const n = nbrs(i).filter((j) => !seen[j]); if (n.length) { seen[i] = 1; chains.push(walk(i, n[0])); } } // 고리

  // 3) 교차로 부근 끊기 + 곧게 펴기 + 둥글리기
  const lines = [];
  for (const c of chains) {
    let pts = c.map((i) => ({ x: (i % W) + 0.5, z: ((i / W) | 0) + 0.5, h: dist[i] }));
    // 교차점 쪽 끝은 그 길 폭만큼 잘라냄
    const trim = (arr) => {
      const end = c[0];
      if (!junction(end)) return arr;
      const r = dist[end] + 1;
      let k = 0;
      while (k < arr.length - 1 && Math.hypot(arr[k].x - arr[0].x, arr[k].z - arr[0].z) < r) k++;
      return arr.slice(k);
    };
    pts = trim(pts);
    if (junction(c[c.length - 1])) {
      const e = pts[pts.length - 1], r = dist[c[c.length - 1]] + 1;
      let k = pts.length - 1;
      while (k > 0 && Math.hypot(pts[k].x - e.x, pts[k].z - e.z) < r) k--;
      pts = pts.slice(0, k + 1);
    }
    if (pts.length < MIN_LEN) continue;
    if (pts.reduce((t, p) => t + p.h, 0) / pts.length > 7) continue; // 길이 아니라 넓은 포장 덩어리(나들목·주차장)
    pts = chaikin(chaikin(douglasPeucker(pts, DP_TOL)));
    lines.push(pts);
  }
  return lines;
}

function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  let best = 0, bi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * dz - (pts[i].z - a.z) * dx) / L;
    if (d > best) { best = d; bi = i; }
  }
  if (best <= tol) {
    // 길 폭(h)은 구간 평균으로
    const h = pts.reduce((s, p) => s + p.h, 0) / pts.length;
    return [{ ...a, h }, { ...b, h }];
  }
  const l = douglasPeucker(pts.slice(0, bi + 1), tol), r = douglasPeucker(pts.slice(bi), tol);
  return l.slice(0, -1).concat(r);
}

function chaikin(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], n = pts[i + 1];
    const mix = (t) => ({ x: p.x + (n.x - p.x) * t, z: p.z + (n.z - p.z) * t, h: p.h + (n.h - p.h) * t });
    if (i > 0) out.push(mix(0.25));
    if (i < pts.length - 2) out.push(mix(0.75));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 선 목록 → 얇은 사각형 조각들 (중앙선 노랑, 가장자리선 흰색) */
export function buildRoadMarkings(map) {
  const lines = computeRoadLines(map);
  const segs = []; // [x, z, len, width, angle, yellow]
  const CENTER_W = 0.24, EDGE_W = 0.18;
  const { width: W, depth: D } = map.meta;
  const isRoadAt = (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= W || iz >= D) return false;
    const i = iz * W + ix;
    return map.ground[i] === ROAD && !(map.heights[i] > 0);
  };
  for (const pts of lines) {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const ang = Math.atan2(dz, dx);
      const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      segs.push([cx, cz, len + CENTER_W, CENTER_W, ang, 1]);
      // 가장자리선: 길 폭(h칸, 차도 밖까지 거리)만큼 옆으로 — 차도 위에 있을 때만
      const off = (a.h + b.h) / 2 - 0.6;
      const nx = -dz / len, nz = dx / len;
      for (const s of [1, -1]) {
        const ex = cx + nx * off * s, ez = cz + nz * off * s;
        if (isRoadAt(ex, ez)) segs.push([ex, ez, len + EDGE_W, EDGE_W, ang, 0]);
      }
    }
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(segs.length, 1));
  const m = new THREE.Matrix4(), rot = new THREE.Matrix4(), col = new THREE.Color();
  segs.forEach(([x, z, len, w, ang, y], k) => {
    m.makeScale(len, 1, w);
    rot.makeRotationY(-ang);
    m.premultiply(rot).setPosition(x, 0.03, z);
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, col.setHex(y ? 0xf2c12e : 0xf1f3f5));
  });
  mesh.count = segs.length;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "road-markings";
  return mesh;
}
