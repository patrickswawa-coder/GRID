// 여러 칸에 한 번에 놓는 제안(자유 그리기·네모·줄) → 블록이 놓일 칸 목록
// backend/heatmodel.py 의 expand_cells() 와 **같은 계산**. 한쪽을 고치면 다른 쪽도 같이 고칠 것.
// (두 언어의 결과가 똑같도록 hypot 대신 sqrt, Math.round 대신 floor(v + 0.5) 를 쓴다)
//
// 제안 하나: { type, x, z, x2?, z2?, shape?, points? }
//   shape 없음      → 한 칸 [(x, z)]
//   shape "path"   → 손가락으로 그린 길 points [[x,z], ...] 을 따라 STEP 칸 간격
//   shape "area"   → 두 모서리 (x,z)·(x2,z2) 로 만든 네모 안을 STEP 칸 간격 격자로
//   shape "line"   → (x,z) ~ (x2,z2) 직선 위에 STEP 칸 간격 (예전 방식, 저장된 제안 표시용)

// 블록 사이 간격(칸, 1칸=5m). 모형 크기와 영향 범위를 보고 정함
export const STEP = { tree: 3, shade: 3, coolfog: 4, pocketpark: 4, greenroof: 3, coolpave: 3 };
export const MAX_CELLS = 50; // 제안 하나에 놓을 수 있는 최대 블록 수 (서버도 같은 값)
export const MAX_POINTS = 300; // 그린 길의 점 수 상한 (서버도 같은 값)
export const SHAPES = ["line", "area", "path"];

const rnd = (v) => Math.floor(v + 0.5);
const len = (dx, dz) => Math.sqrt(dx * dx + dz * dz);

export function isMulti(c) {
  if (c.shape === "path") return Array.isArray(c.points) && c.points.length >= 2;
  return (c.shape === "line" || c.shape === "area") && c.x2 != null && c.z2 != null;
}

/** 그린 길의 길이(칸) */
export function pathLength(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += len(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return L;
}

/** 길을 따라 0, step, 2·step … 지점마다 한 칸. 끝이 step 의 절반 이상 남으면 끝점도 */
function alongPath(points, step) {
  const total = pathLength(points);
  const targets = [];
  for (let t = 0; t <= total + 1e-9; t += step) targets.push(t);
  if (total - targets[targets.length - 1] >= step / 2) targets.push(total);
  const out = [], seen = new Set();
  let seg = 1, segStart = 0;
  for (const t of targets) {
    let ax, az, dx, dz, L;
    for (;;) {
      ax = points[seg - 1][0]; az = points[seg - 1][1];
      dx = points[seg][0] - ax; dz = points[seg][1] - az;
      L = len(dx, dz);
      if (t <= segStart + L + 1e-9 || seg === points.length - 1) break;
      segStart += L; seg++;
    }
    const f = L > 0 ? Math.min(1, (t - segStart) / L) : 0;
    const x = rnd(ax + dx * f), z = rnd(az + dz * f);
    const k = x + "," + z;
    if (!seen.has(k)) { seen.add(k); out.push({ x, z }); }
  }
  return out;
}

export function expandCells(c) {
  if (!isMulti(c)) return [{ x: c.x, z: c.z }];
  const step = STEP[c.type] || 3;
  if (c.shape === "path") return alongPath(c.points, step);
  if (c.shape === "line") {
    const dx = c.x2 - c.x, dz = c.z2 - c.z;
    const n = Math.max(1, rnd(len(dx, dz) / step));
    const out = [], seen = new Set();
    for (let i = 0; i <= n; i++) {
      const x = rnd(c.x + (dx * i) / n), z = rnd(c.z + (dz * i) / n);
      const k = x + "," + z;
      if (!seen.has(k)) { seen.add(k); out.push({ x, z }); }
    }
    return out;
  }
  const axis = (a, b) => {
    const lo = Math.min(a, b), span = Math.abs(b - a);
    const n = Math.floor(span / step) + 1;
    const off = Math.floor((span - (n - 1) * step) / 2);
    return Array.from({ length: n }, (_, i) => lo + off + i * step);
  };
  const out = [];
  for (const z of axis(c.z, c.z2)) for (const x of axis(c.x, c.x2)) out.push({ x, z });
  return out;
}

/** 제안 목록 → 시뮬레이션용 [{type, x, z}] (여러 칸 제안은 칸마다 펼침) */
export function expandAll(list) {
  return list.flatMap((c) => expandCells(c).map((p) => ({ type: c.type, x: p.x, z: p.z })));
}
