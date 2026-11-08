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
  tree: (g, gh) => {
    part(g, 0x7a4b28, [0.2, 0.9, 0.2], [0, 0, 0], gh);
    part(g, 0x3c9a3f, [0.95, 0.8, 0.95], [0, 0.85, 0], gh);
    part(g, 0x4fb34f, [0.55, 0.45, 0.55], [0, 1.6, 0], gh);
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
