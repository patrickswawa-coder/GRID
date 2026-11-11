// 큰 건물·아파트·학교 이름표 — 지도 앱처럼: 반투명 흰 알약 + 종류별 색 점 + 굵은 글씨 (이모지 없음)
// 멀리서는 중요한 곳(rank 낮은 순) 몇 개만, 가까이 갈수록 더 보여준다. 겹치면 덜 중요한 것을 숨긴다.
import * as THREE from "three";

const COLOR = { apt: "#4f6a8f", school: "#d9822b", public: "#7048b8", transit: "#e8590c", shop: "#6c757d", park: "#2f9e44" };
const MOBILE = innerWidth < 500;
const PX = MOBILE ? 24 : 28; // 이름표(알약) 화면 높이(px)
const BASE_N = MOBILE ? 7 : 12; // 처음 위치에서 보이는 최대 개수
const FONT = "-apple-system, BlinkMacSystemFont, 'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

function pill(ctx, x, y, w, h) { // roundRect 없는 옛 브라우저 대비
  const r = h / 2;
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h); ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath();
}

function makeTexture(text, kind) {
  // 화면에 그려질 크기 × 화면 배율 × 1.5 로 그려서 살짝만 줄여 씀 → 계단(픽셀) 없이 매끈
  const R = Math.min(devicePixelRatio || 1, 2) * 1.5;
  const H = Math.round(PX * R), FS = Math.round(H * 0.5), M = Math.round(3 * R); // M: 그림자 여백
  const DOT = Math.round(H * 0.16), PADL = Math.round(H * 0.32), GAP = Math.round(H * 0.2), PADR = Math.round(H * 0.38);
  const font = `700 ${FS}px ${FONT}`;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = PADL + DOT * 2 + GAP + tw + PADR;
  cv.width = w + M * 2; cv.height = H + M * 2;
  // 반투명 흰 알약 + 옅은 그림자
  ctx.save();
  ctx.shadowColor = "rgba(23,50,74,0.18)"; ctx.shadowBlur = 3 * R; ctx.shadowOffsetY = 1 * R;
  ctx.beginPath(); pill(ctx, M, M, w, H);
  ctx.fillStyle = "rgba(255,255,255,0.74)"; ctx.fill();
  ctx.restore();
  ctx.lineWidth = Math.max(1, R * 0.6); ctx.strokeStyle = "rgba(23,50,74,0.10)"; ctx.stroke();
  // 점 (종류별 색)
  const cx = M + PADL + DOT, cy = M + H / 2;
  ctx.beginPath(); ctx.arc(cx, cy, DOT, 0, Math.PI * 2);
  ctx.fillStyle = COLOR[kind] || "#495057"; ctx.fill();
  // 굵은 글씨
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#17324a";
  ctx.fillText(text, cx + DOT + GAP, cy + R * 0.5);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return { t, aspect: cv.width / cv.height, anchor: cx / cv.width, scaleH: cv.height / H };
}

const isMinor = (d) => d.kind === "shop" || (d.kind === "park" && /어린이공원|소공원/.test(d.name));

export async function loadLabels(url, refY = 160) {
  let list = [];
  try {
    const r = await fetch(url);
    if (r.ok) list = await r.json();
  } catch {}
  list = list.slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const group = new THREE.Group();
  const items = list.map((l) => {
    const { t, aspect, anchor, scaleH } = makeTexture(l.name, l.kind);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, opacity: 0.96 }));
    s.material.sizeAttenuation = false;
    s.center.set(anchor, 0.5); // 점이 건물 위에 오도록
    s.position.set(l.x + 0.5, l.h + 1.5, l.z + 0.5);
    s.renderOrder = 5;
    s.userData = { ...l, aspect, anchor, scaleH };
    group.add(s);
    return s;
  });

  const v = new THREE.Vector3();
  let last = 0;
  function update(camera, viewH, viewW, force = false) {
    const now = performance.now();
    if (!force && now - last < 150) return;
    last = now;
    const k = PX / (viewH * 0.5 * camera.projectionMatrix.elements[5]);
    const y = Math.max(camera.position.y, 1);
    const zoom = refY / y; // 1 = 처음 위치, 클수록 가까이
    const maxN = Math.round(Math.min(80, BASE_N * Math.pow(zoom, 1.4)));
    const taken = [];
    let n = 0;
    for (const s of items) {
      const d = s.userData;
      s.scale.set(k * d.scaleH * d.aspect, k * d.scaleH, 1);
      v.copy(s.position).project(camera);
      let show = n < maxN && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (show && isMinor(d) && zoom < 1.8) show = false; // 멀리서는 상가·어린이공원 생략
      if (show) {
        const px = (v.x + 1) / 2 * viewW, py = (1 - v.y) / 2 * viewH;
        const w = PX * d.scaleH * d.aspect;
        const r = [px - w * d.anchor - 6, py - PX / 2 - 6, px + w * (1 - d.anchor) + 6, py + PX / 2 + 6];
        if (taken.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) show = false;
        else { taken.push(r); n++; }
      }
      s.visible = show;
    }
  }
  return { group, update, count: items.length, items: list };
}
