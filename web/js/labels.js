// 큰 건물·아파트·학교 이름표. 겹치면 중요도(rank) 낮은 것부터 숨긴다.
import * as THREE from "three";

const ICON = { apt: "🏢", school: "🏫", public: "🏛️", transit: "🚌", shop: "🛍️", park: "🌳" };
const COLOR = { apt: "#2f6fed", school: "#f08c00", public: "#9c36b5", transit: "#e8590c", shop: "#495057", park: "#2f9e44" };
const PX = innerWidth < 500 ? 22 : 30; // 이름표 화면 높이(px) 목표 (폰은 작게)

function makeTexture(text, kind) {
  const font = "600 34px -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  ctx.font = font;
  const label = `${ICON[kind] || "📍"} ${text}`;
  const w = Math.ceil(ctx.measureText(label).width) + 40, h = 60;
  cv.width = w; cv.height = h;
  ctx.font = font;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.strokeStyle = COLOR[kind] || "#495057";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 26);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1d2433";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 20, h / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { t, aspect: w / h };
}

export async function loadLabels(url) {
  let list = [];
  try {
    const r = await fetch(url);
    if (r.ok) list = await r.json();
  } catch {}
  const group = new THREE.Group();
  const items = list.map((l) => {
    const { t, aspect } = makeTexture(l.name, l.kind);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
    s.material.sizeAttenuation = false;
    s.position.set(l.x + 0.5, l.h + 2.5, l.z + 0.5);
    s.renderOrder = 5;
    s.userData = { ...l, aspect };
    group.add(s);
    return s;
  });

  const v = new THREE.Vector3();
  let last = 0;
  function update(camera, viewH, viewW, force = false) {
    const now = performance.now();
    if (!force && now - last < 150) return;
    last = now;
    // 화면에서 PX 높이가 되도록 크기 계산 (sizeAttenuation=false 기준)
    const k = PX / (viewH * 0.5 * camera.projectionMatrix.elements[5]);
    const dist = camera.position.distanceTo(new THREE.Vector3(camera.position.x, 0, camera.position.z)) ;
    const taken = [];
    for (const s of items) {
      const d = s.userData;
      s.scale.set(k * d.aspect, k, 1);
      v.copy(s.position).project(camera);
      let show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      if (show && d.kind === "shop" && dist > 120) show = false; // 멀리서는 상가 이름 생략
      if (show) {
        const cx = (v.x + 1) / 2 * viewW, cy = (1 - v.y) / 2 * viewH;
        const hw = (PX * d.aspect) / 2 + 4, hh = PX / 2 + 3;
        const r = [cx - hw, cy - hh, cx + hw, cy + hh];
        if (taken.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) show = false;
        else taken.push(r);
      }
      s.visible = show;
    }
  }
  return { group, update, count: items.length, items: list };
}
