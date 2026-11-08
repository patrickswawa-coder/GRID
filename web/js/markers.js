// 민원 유형별 작은 복셀 모형 + 머리 위 아이콘
import * as THREE from "three";
import { TYPE_BY_CODE } from "./types.js";

const box = new THREE.BoxGeometry(1, 1, 1);
const matCache = new Map();
function mat(color, ghost = false) {
  const key = color + (ghost ? "g" : "");
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshLambertMaterial({ color, transparent: ghost, opacity: ghost ? 0.55 : 1 }));
  }
  return matCache.get(key);
}
function part(g, color, [w, h, d], [x, y, z], ghost) {
  const m = new THREE.Mesh(box, mat(color, ghost));
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  g.add(m);
}

// 각 모형은 칸 하나(1x1) 안에 들어가는 크기. y=0이 바닥.
const MODELS = {
  streetlight: (g, gh) => {
    part(g, 0x3b3f45, [0.14, 2.4, 0.14], [0, 0, 0], gh);
    part(g, 0x3b3f45, [0.5, 0.1, 0.12], [0.2, 2.3, 0], gh);
    part(g, 0xffe066, [0.3, 0.18, 0.3], [0.4, 2.12, 0], gh);
  },
  bench: (g, gh) => {
    part(g, 0x8a5a33, [0.9, 0.1, 0.36], [0, 0.32, 0], gh);
    part(g, 0x8a5a33, [0.9, 0.36, 0.08], [0, 0.42, -0.16], gh);
    part(g, 0x444444, [0.08, 0.32, 0.3], [-0.38, 0, 0], gh);
    part(g, 0x444444, [0.08, 0.32, 0.3], [0.38, 0, 0], gh);
  },
  trash: (g, gh) => {
    part(g, 0x2f7d4a, [0.45, 0.7, 0.45], [0, 0, 0], gh);
    part(g, 0x245c37, [0.5, 0.08, 0.5], [0, 0.7, 0], gh);
  },
  // ---- 개선 제안: 사업 규모가 보이도록 칸 여러 개 크기
  tree: (g, gh) => {
    for (const dx of [-1.2, 0, 1.2]) {
      part(g, 0x7a4b28, [0.2, 0.9, 0.2], [dx, 0, 0], gh);
      part(g, 0x3c9a3f, [0.95, 0.8, 0.95], [dx, 0.85, 0], gh);
      part(g, 0x4fb34f, [0.55, 0.45, 0.55], [dx, 1.6, 0], gh);
    }
  },
  pocketpark: (g, gh) => {
    part(g, 0x69db7c, [3.2, 0.08, 3.2], [0, 0, 0], gh);
    for (const [dx, dz, s] of [[-0.9, -0.9, 0.9], [0.8, -0.6, 1.1], [-0.5, 0.9, 0.8], [1, 1, 0.7]]) {
      part(g, 0x7a4b28, [0.18, 0.6, 0.18], [dx, 0.08, dz], gh);
      part(g, 0x2f9e44, [s, s * 0.8, s], [dx, 0.6, dz], gh);
    }
    part(g, 0x8a5a33, [0.8, 0.1, 0.3], [0.2, 0.3, 0.2], gh); // 벤치
  },
  shade: (g, gh) => {
    for (const [dx, dz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) part(g, 0xdee2e6, [0.1, 1.6, 0.1], [dx, 0, dz], gh);
    part(g, 0x339af0, [2.2, 0.12, 2.2], [0, 1.6, 0], gh);
    part(g, 0x74c0fc, [1.4, 0.12, 1.4], [0, 1.72, 0], gh);
  },
  coolfog: (g, gh) => {
    part(g, 0xadb5bd, [0.14, 2.2, 0.14], [0, 0, 0], gh);
    part(g, 0xadb5bd, [2.2, 0.1, 0.1], [0, 2.1, 0], gh);
    for (const [dx, y, s] of [[-0.9, 1.5, 0.7], [0.9, 1.4, 0.8], [0, 1.2, 0.9], [-0.5, 0.8, 0.6], [0.6, 0.7, 0.7]]) {
      part(g, 0xd0ebff, [s, s * 0.7, s], [dx, y, 0], true); // 물안개는 항상 반투명
    }
  },
  greenroof: (g, gh) => {
    part(g, 0x82c91e, [2.6, 0.12, 2.6], [0, 0, 0], gh);
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, 0.6], [-0.4, 0.8], [0.7, -0.7]]) part(g, 0x5c940d, [0.5, 0.35, 0.5], [dx, 0.12, dz], gh);
  },
  coolpave: (g, gh) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      part(g, (i + j) % 2 ? 0xced4da : 0xe9ecef, [0.95, 0.06, 0.95], [i, 0, j], gh);
    }
    part(g, 0x74c0fc, [0.5, 0.07, 0.5], [0, 0, 0], gh); // 물이 스미는 표시
  },
  // ---- 환경 불편 신고
  odor: (g, gh) => {
    for (const [dx, y, s] of [[0, 0.4, 0.8], [0.3, 1.0, 0.6], [-0.2, 1.5, 0.5]]) part(g, 0xb197fc, [s, s, s], [dx, y, 0], true);
  },
  noise: (g, gh) => {
    part(g, 0x495057, [0.6, 0.8, 0.5], [0, 0, 0], gh);
    part(g, 0x212529, [0.4, 0.4, 0.05], [0, 0.2, 0.26], gh);
    for (const [r, y] of [[0.7, 1.1], [1.0, 1.4]]) part(g, 0xff922b, [r, 0.08, 0.08], [0, y, 0.3], gh);
  },
  walkway: (g, gh) => {
    part(g, 0xf1e3c2, [1, 0.08, 1], [0, 0, 0], gh);
    for (const x of [-0.3, 0, 0.3]) part(g, 0xffffff, [0.14, 0.1, 0.8], [x, 0.0, 0], gh);
  },
  other: (g, gh) => {
    part(g, 0x666666, [0.1, 1.4, 0.1], [0, 0, 0], gh);
    part(g, 0xe8590c, [0.7, 0.6, 0.1], [0, 1.2, 0], gh);
  },
};

const iconCache = new Map();
function iconTexture(icon, color) {
  if (iconCache.has(icon)) return iconCache.get(icon);
  const s = 128, cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = "64px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(icon, s / 2, s / 2 + 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(icon, t);
  return t;
}

/** 민원 마커 생성. ghost=true 는 등록 전 미리보기(반투명) */
export function makeMarker(type, { ghost = false } = {}) {
  const t = TYPE_BY_CODE[type] || TYPE_BY_CODE.other;
  const g = new THREE.Group();
  (MODELS[type] || MODELS.other)(g, ghost);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: iconTexture(t.icon, t.color), depthTest: false, transparent: true })
  );
  sprite.position.y = 3.2;
  sprite.scale.set(0.045, 0.045, 1);
  sprite.material.sizeAttenuation = false; // 멀리서도 같은 크기로 보이게
  sprite.renderOrder = 10;
  g.add(sprite);
  g.userData.sprite = sprite;
  return g;
}
