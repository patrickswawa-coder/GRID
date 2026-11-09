// 여러 칸에 한 번에 놓는 제안(줄·네모) → 블록이 놓일 칸 목록
// backend/heatmodel.py 의 expand_cells() 와 **같은 계산**. 한쪽을 고치면 다른 쪽도 같이 고칠 것.
//
// 제안 하나: { type, x, z, x2?, z2?, shape? }
//   shape 없음      → 한 칸 [(x, z)]
//   shape "line"   → (x,z) ~ (x2,z2) 직선 위에 STEP 칸 간격
//   shape "area"   → 두 모서리로 만든 네모 안을 STEP 칸 간격 격자로

// 블록 사이 간격(칸, 1칸=5m). 모형 크기와 영향 범위를 보고 정함
export const STEP = { tree: 3, shade: 3, coolfog: 4, pocketpark: 4, greenroof: 3, coolpave: 3 };
export const MAX_CELLS = 30; // 제안 하나에 놓을 수 있는 최대 블록 수 (서버도 같은 값)
export const SHAPES = ["line", "area"];

const rnd = (v) => Math.floor(v + 0.5); // Python 쪽과 반올림을 맞추기 위해 Math.round 대신

export function isMulti(c) {
  return SHAPES.includes(c.shape) && c.x2 != null && c.z2 != null;
}

export function expandCells(c) {
  if (!isMulti(c)) return [{ x: c.x, z: c.z }];
  const step = STEP[c.type] || 3;
  const out = [];
  if (c.shape === "line") {
    const dx = c.x2 - c.x, dz = c.z2 - c.z;
    const n = Math.max(1, rnd(Math.hypot(dx, dz) / step));
    const seen = new Set();
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
  for (const z of axis(c.z, c.z2)) for (const x of axis(c.x, c.x2)) out.push({ x, z });
  return out;
}

/** 제안 목록 → 시뮬레이션용 [{type, x, z}] (줄·네모는 칸마다 펼침) */
export function expandAll(list) {
  return list.flatMap((c) => expandCells(c).map((p) => ({ type: c.type, x: p.x, z: p.z })));
}
