// 3D 복셀 맵: voxels.json 읽기, 지면/건물/나무 그리기, 좌표 변환
// 월드 좌표 1 = 격자 1칸(meta.cell m). 칸 (x, z)의 중심은 (x+0.5, ?, z+0.5)
import * as THREE from "three";

const GRASS = 0, ROAD = 1, SIDEWALK = 2, PARK = 3, WATER = 4;
const GROUND_COLORS = [
  0x86b860, // 0 잔디/빈땅
  0x55595f, // 1 차도
  0xd8cfbd, // 2 인도·대지
  0x5d9e45, // 3 공원·녹지
  0x4aa3df, // 4 물
];
// 건물 종류별 색 후보 { 벽[], 지붕[], 창문 }. 건물(붙어 있는 같은 높이·종류 칸 묶음)마다 하나씩 골라 씀
const GREEN_PAINT = 0x7fa58a; // 우리나라 옥상 방수 페인트(초록)
const KIND_PALETTE = [
  { // 0 아파트: 흰·크림·연한 파스텔 벽
    wall: [0xfaf8f2, 0xf4ecda, 0xe6eef4, 0xf5e4d6, 0xe8eedf, 0xf7f1e3],
    roof: [0xc9c4ba, GREEN_PAINT, 0xbfc6c9, GREEN_PAINT],
    glass: 0x7f9fbc,
  },
  { // 1 단독주택: 베이지·벽돌 벽, 빨강·회청·갈색·초록 지붕
    wall: [0xf0e2c8, 0xe9d6b8, 0xd9b39a, 0xf3ece0, 0xe2cdb0],
    roof: [0xc8553d, 0x5b6b7c, 0x8a5a3c, 0x5f8f6a, 0xd07a45, 0xc8553d],
    glass: 0x7a8fa0,
  },
  { // 2 상가: 회청·석재·벽돌·유리, 띠 창
    wall: [0xc9d5de, 0xe2d3b5, 0xc48a6e, 0xdcdcd8, 0xa9c7cc, 0xeadfcb],
    roof: [0x8d99a3, GREEN_PAINT, 0xa29e96, GREEN_PAINT],
    glass: 0x6f93b4,
  },
  { // 3 공공: 노란·벽돌·크림 벽
    wall: [0xefd9a0, 0xcf9a78, 0xeee3c8],
    roof: [0xd2a63a, GREEN_PAINT, 0x9a8f80],
    glass: 0x6b88a0,
  },
];

// 붙어 있는 같은 종류·같은 높이 칸을 한 건물로 묶어 건물 번호를 매긴다 (색이 칸마다 튀지 않게)
function buildingIds(map) {
  const { width: W } = map.meta;
  const b = map.buildings, n = b.length / 4;
  const at = new Map();
  for (let k = 0; k < n; k++) at.set(b[k * 4 + 1] * W + b[k * 4], k);
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let k = 0; k < n; k++) {
    const x = b[k * 4], z = b[k * 4 + 1], h = b[k * 4 + 2], kind = b[k * 4 + 3];
    for (const j of [at.get(z * W + x + 1), at.get((z + 1) * W + x)]) {
      if (j === undefined || b[j * 4 + 2] !== h || b[j * 4 + 3] !== kind) continue;
      parent[find(j)] = find(k);
    }
  }
  return Int32Array.from({ length: n }, (_, k) => find(k));
}

export async function loadMap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`맵 데이터를 불러오지 못했어요 (${res.status})`);
  const doc = await res.json();
  const { meta } = doc;
  const bin = atob(doc.ground);
  const ground = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) ground[i] = bin.charCodeAt(i);
  const heights = new Uint16Array(meta.width * meta.depth);
  const b = doc.buildings;
  for (let i = 0; i < b.length; i += 4) heights[b[i + 1] * meta.width + b[i]] = b[i + 2];
  return { meta, ground, heights, buildings: b };
}

export function heightAt(map, x, z) {
  if (x < 0 || z < 0 || x >= map.meta.width || z >= map.meta.depth) return 0;
  return map.heights[z * map.meta.width + x];
}

// 경위도 변환은 geo.js (정확한 TM 공식). 예전 이름 그대로 쓰도록 다시 내보냄
export { cellToLatLng, latLngToCell } from "./geo.js";

export function zoneOf(meta, x, z) {
  const s = meta.zone_size || 40;
  return String.fromCharCode(65 + Math.floor(x / s)) + (Math.floor(z / s) + 1);
}

const hash = (x, z, s = 0) => ((((x * 73856093) ^ (z * 19349663) ^ (s * 83492791)) >>> 0) % 1000) / 1000;

// ---------------------------------------------------------------- 셰이더 조각

const GRID_VARY = "varying vec3 vGridPos;\nvarying vec3 vGridN;\n";
const GRID_VERTEX = `#include <begin_vertex>
  vec4 gp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    gp = instanceMatrix * gp;
  #endif
  vGridPos = (modelMatrix * gp).xyz;
  vGridN = normal;`;
// 블록 테두리 선 (멀어지면 자연스럽게 사라짐)
const GRID_LINE = `
  vec3 f = fract(vGridPos + 0.0005);
  vec3 d = min(f, 1.0 - f);
  float edge = abs(vGridN.y) > 0.5 ? min(d.x, d.z) : (abs(vGridN.x) > 0.5 ? min(d.y, d.z) : min(d.x, d.y));
  float lw = fwidth(edge) * 1.5;
  float line = (1.0 - smoothstep(0.03, 0.03 + lw, edge)) * (1.0 - smoothstep(0.08, 0.25, lw));`;

// 지면·흙·나무: 블록 테두리만
function voxelize(material, strength = 0.75) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + GRID_VARY)
      .replace("#include <begin_vertex>", GRID_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + GRID_VARY)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        ${GRID_LINE}
        diffuseColor.rgb *= mix(1.0, ${strength.toFixed(2)}, line);
        if (vGridN.y > 0.5) diffuseColor.rgb *= 1.06;`
      );
  };
  return material;
}

// 건물: 벽/지붕 색 분리, 층마다 창문, 아래쪽 음영
function buildingMaterial() {
  const mat = new THREE.MeshLambertMaterial();
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        ${GRID_VARY}
        attribute vec3 aWall; attribute vec3 aRoof; attribute vec3 aGlass; attribute vec2 aInfo;
        varying vec3 vWall; varying vec3 vRoof; varying vec3 vGlass; varying vec2 vInfo;`
      )
      .replace("#include <begin_vertex>", GRID_VERTEX + "\nvWall = aWall; vRoof = aRoof; vGlass = aGlass; vInfo = aInfo;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        ${GRID_VARY}
        varying vec3 vWall; varying vec3 vRoof; varying vec3 vGlass; varying vec2 vInfo;`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        ${GRID_LINE}
        float kind = vInfo.x, top = vInfo.y;
        if (vGridN.y > 0.5) {
          // 옥상: 블록 선 + 가장자리 난간을 살짝 밝게
          diffuseColor.rgb = vRoof * mix(1.0, 0.82, line);
        } else {
          float u = abs(vGridN.x) > 0.5 ? vGridPos.z : vGridPos.x;
          float v = vGridPos.y;
          float fl = v * FLOORS_PER_BLOCK;        // 층 번호
          float fu = u * (kind < 0.5 ? 2.0 : 1.5); // 창 간격
          float wy = step(0.38, fract(fl)) * step(fract(fl), 0.78);
          float wx = step(0.28, fract(fu)) * step(fract(fu), 0.72);
          if (kind > 0.5 && kind < 1.5) wx = step(0.3, fract(u)) * step(fract(u), 0.7);   // 주택: 작은 창
          if (kind > 1.5 && kind < 2.5) wx = 1.0;                                        // 상가: 띠 창
          float win = wx * wy * step(0.25, v) * step(v, top - 0.18);
          float far = smoothstep(0.25, 0.7, fwidth(fl));                                // 멀면 평균색으로
          vec3 wall = mix(vWall, vGlass, win);
          wall = mix(wall, mix(vWall, vGlass, 0.24), far * step(0.25, v) * step(v, top - 0.18));
          // 건물 꼭대기 띠(난간)
          wall = mix(wall, vRoof * 1.05, step(top - 0.08, v));
          // 땅에 가까울수록 어둡게 (간이 앰비언트 오클루전)
          wall *= mix(0.62, 1.0, smoothstep(0.0, 1.6, v));
          diffuseColor.rgb = wall * mix(1.0, 0.93, line * (1.0 - far) * (1.0 - wx * wy));
        }`
      );
  };
  mat.customProgramCacheKey = () => "grid-building";
  return mat;
}

// ---------------------------------------------------------------- 장면 만들기

export function buildScene(map) {
  const { meta } = map;
  const W = meta.width, D = meta.depth;
  const floorsPerBlock = (meta.cell || 5) / 3; // 한 칸 높이에 들어가는 층 수
  const group = new THREE.Group();
  const c = new THREE.Color();

  // 지면: 칸마다 색을 칠한 텍스처
  const tex = new Uint8Array(W * D * 4);
  for (let i = 0; i < W * D; i++) {
    const t = map.ground[i];
    const hex = GROUND_COLORS[t] ?? GROUND_COLORS[0]; // 텍스처는 sRGB 값 그대로 기록
    const x = i % W, z = (i / W) | 0;
    let n = 0.95 + hash(x, z) * 0.08;
    if (t === WATER) n = 0.92 + hash(x, z, 1) * 0.16;
    tex[i * 4] = Math.min(255, ((hex >> 16) & 255) * n);
    tex[i * 4 + 1] = Math.min(255, ((hex >> 8) & 255) * n);
    tex[i * 4 + 2] = Math.min(255, (hex & 255) * n);
    tex[i * 4 + 3] = 255;
  }
  const groundTex = new THREE.DataTexture(tex, W, D);
  groundTex.magFilter = THREE.NearestFilter;
  // 멀리서 볼 때(축소) 칸마다 다른 색이 픽셀보다 작아져 지글거리지 않게, 축소할 때는 평균색으로
  groundTex.generateMipmaps = true;
  groundTex.minFilter = THREE.LinearMipmapLinearFilter;
  groundTex.anisotropy = 4;
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.needsUpdate = true;

  const groundGeo = new THREE.PlaneGeometry(W, D);
  groundGeo.rotateX(-Math.PI / 2);
  // PlaneGeometry UV: v=1이 -z(북쪽). 텍스처 0행 = z=0(북쪽)이 되도록 v를 뒤집는다
  const uv = groundGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const ground = new THREE.Mesh(groundGeo, voxelize(new THREE.MeshLambertMaterial({ map: groundTex }), 0.88));
  ground.position.set(W / 2, 0, D / 2);
  ground.receiveShadow = true;
  ground.name = "ground";
  group.add(ground);

  // 땅 덩어리 아래 흙 (떠 있는 섬 느낌)
  // 윗면은 지면에 가려 안 보이므로 그리지 않는다. 그리면 멀리서 볼 때(최대 축소) 휴대폰에서
  // 깊이 정밀도가 모자라 갈색 윗면이 지면을 뚫고 깜빡인다 (z-fighting)
  const dirtMat = voxelize(new THREE.MeshLambertMaterial({ color: 0x8b5a2b }));
  const noTop = new THREE.MeshBasicMaterial({ visible: false });
  // BoxGeometry 면 순서: +x, -x, +y(윗면), -y, +z, -z
  const dirt = new THREE.Mesh(new THREE.BoxGeometry(W, 3, D), [dirtMat, dirtMat, noTop, dirtMat, dirtMat, dirtMat]);
  dirt.position.set(W / 2, -1.6, D / 2); // 옆면 윗변이 지면 바로 아래에 오게
  group.add(dirt);

  // 건물: 칸마다 기둥 하나 (InstancedMesh 한 번에)
  const b = map.buildings;
  const count = b.length / 4;
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const geo = box.clone();
  const aWall = new Float32Array(count * 3), aRoof = new Float32Array(count * 3);
  const aGlass = new Float32Array(count * 3), aInfo = new Float32Array(count * 2);
  const mesh = new THREE.InstancedMesh(geo, buildingMaterial(), Math.max(count, 1));
  mesh.material.onBeforeCompile = ((orig) => (shader) => {
    shader.fragmentShader = "#define FLOORS_PER_BLOCK " + floorsPerBlock.toFixed(3) + "\n" + shader.fragmentShader;
    orig(shader);
  })(mesh.material.onBeforeCompile);
  const m = new THREE.Matrix4();
  const ids = buildingIds(map);
  for (let i = 0, k = 0; i < b.length; i += 4, k++) {
    const [x, z, h, kind] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
    m.makeScale(1, h, 1).setPosition(x + 0.5, 0, z + 0.5);
    mesh.setMatrixAt(k, m);
    const pal = KIND_PALETTE[kind] ?? KIND_PALETTE[0];
    // 건물 번호로 색을 골라 같은 건물은 같은 색, 건물마다 다른 색
    const r = ids[k], bx = b[r * 4], bz = b[r * 4 + 1];
    const wall = pal.wall[Math.floor(hash(bx, bz, 11) * pal.wall.length)];
    const roof = pal.roof[Math.floor(hash(bx, bz, 12) * pal.roof.length)];
    const v = (hash(bx, bz, 13) - 0.5) * 0.05;
    c.setHex(wall).offsetHSL(0, 0, v).toArray(aWall, k * 3);
    c.setHex(roof).offsetHSL(0, 0, v).toArray(aRoof, k * 3);
    c.setHex(pal.glass).toArray(aGlass, k * 3);
    aInfo[k * 2] = kind;
    aInfo[k * 2 + 1] = h;
  }
  geo.setAttribute("aWall", new THREE.InstancedBufferAttribute(aWall, 3));
  geo.setAttribute("aRoof", new THREE.InstancedBufferAttribute(aRoof, 3));
  geo.setAttribute("aGlass", new THREE.InstancedBufferAttribute(aGlass, 3));
  geo.setAttribute("aInfo", new THREE.InstancedBufferAttribute(aInfo, 2));
  mesh.count = count;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "buildings";
  group.add(mesh);

  const trees = buildTrees(map);
  group.add(trees);

  const markings = buildRoadMarkings(map);
  group.add(markings);

  // 열섬 레이어(heat.js)가 색을 바꿨다 되돌릴 수 있게 원본을 같이 넘긴다
  return { group, ground, buildings: mesh, trees, markings, groundTex, groundBase: tex.slice(), roofBase: aRoof.slice() };
}

// 공원·임야에는 숲, 도로변 인도에는 가로수
function buildTrees(map) {
  const { width: W, depth: D } = map.meta;
  const g = map.ground, H = map.heights;
  const spots = [];
  for (let z = 1; z < D - 1; z++) {
    for (let x = 1; x < W - 1; x++) {
      const i = z * W + x;
      if (H[i]) continue;
      const t = g[i];
      if (t === PARK && hash(x, z, 7) < 0.16) spots.push([x, z, 0]);
      else if (t === SIDEWALK && (x + 2 * z) % 4 === 0 &&
               (g[i - 1] === ROAD || g[i + 1] === ROAD || g[i - W] === ROAD || g[i + W] === ROAD)) spots.push([x, z, 1]);
    }
  }
  const tree = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x6b4426 }), spots.length);
  const leaves = new THREE.InstancedMesh(box, voxelize(new THREE.MeshLambertMaterial(), 0.8), spots.length * 2);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  let L = 0;
  spots.forEach(([x, z, street], k) => {
    const s = street ? 0.7 : 0.8 + hash(x, z, 3) * 0.5;      // 크기
    const th = street ? 0.7 : 0.5 + hash(x, z, 4) * 0.5;     // 줄기 높이
    m.makeScale(0.22, th, 0.22).setPosition(x + 0.5, 0, z + 0.5);
    trunks.setMatrixAt(k, m);
    c.setHSL(0.27 + hash(x, z, 5) * 0.06, 0.55, 0.3 + hash(x, z, 6) * 0.1);
    m.makeScale(s, s * 0.9, s).setPosition(x + 0.5, th, z + 0.5);
    leaves.setMatrixAt(L, m); leaves.setColorAt(L++, c);
    m.makeScale(s * 0.55, s * 0.5, s * 0.55).setPosition(x + 0.5, th + s * 0.9, z + 0.5);
    leaves.setMatrixAt(L, m); leaves.setColorAt(L++, c.offsetHSL(0, 0, 0.05));
  });
  leaves.count = L;
  for (const im of [trunks, leaves]) {
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    tree.add(im);
  }
  tree.name = "trees";
  return tree;
}

// ---------------------------------------------------------------- 도로 표시 (중앙선·가장자리선)
// 바닥 텍스처는 칸당 1픽셀이라 가는 선을 못 그려서, 얇은 사각형을 도로 위에 따로 깐다 (InstancedMesh 하나).
// 열섬 레이어를 켜면 숨긴다 (app.js setHeat).
function buildRoadMarkings(map) {
  const { width: W, depth: D } = map.meta;
  const N = W * D;
  const isRoad = (i) => map.ground[i] === ROAD && !(map.heights[i] > 0);
  // 차도 칸마다 '차도 밖까지 몇 칸'(4방향 거리) — 가운데일수록 큼
  const d = new Int16Array(N);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    if (!isRoad(i)) { d[i] = 0; q[qt++] = i; } else d[i] = -1;
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W, z = (i / W) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
      const j = nz * W + nx;
      if (d[j] < 0) { d[j] = d[i] + 1; q[qt++] = j; }
    }
  }
  for (let i = 0; i < N; i++) if (d[i] < 0) d[i] = 1; // 지도 끝까지 이어진 차도
  const at = (x, z) => (x < 0 || z < 0 || x >= W || z >= D ? 0 : d[z * W + x]);

  // 넓은 길(폭 3칸=15m 이상) 근처만 가장자리선 — 골목까지 그리면 지저분함
  const wide = new Uint8Array(N);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (at(x, z) < 2) continue;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < W && nz < D) wide[nz * W + nx] = 1;
    }
  }

  const quads = [], center = []; // quads: [cx, cz, sx, sz, yellow]
  const LINE = 0.1, EDGE = 0.14, CENTER = 0.2;
  const CENTER_MIN = 3; // 폭 5칸(25m) 이상 큰길만 중앙선
  const MIN_RUN = 8;    // 8칸(40m) 넘게 이어진 것만
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x;
    if (!isRoad(i)) continue;
    // 가장자리선: 옆 칸이 차도가 아니면 (물·지도 밖 제외) 그쪽 변 안쪽에 흰 선
    if (wide[i]) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const j = nz * W + nx;
        if (isRoad(j) || map.ground[j] === WATER) continue;
        if (dx) quads.push([x + 0.5 + dx * (0.5 - EDGE), z + 0.5, LINE, 1, 0]);
        else quads.push([x + 0.5, z + 0.5 + dz * (0.5 - EDGE), 1, LINE, 0]);
      }
    }
    // 중앙선 후보: 길을 가로질러 봤을 때 가운데(거리 최대) — 폭이 홀수면 칸 가운데, 짝수면 두 칸 사이
    const v = d[i];
    if (v < CENTER_MIN) continue;
    if (v > at(x, z - 1)) {
      if (v > at(x, z + 1)) center.push([i, x + 0.5, z + 0.5, 1, CENTER]);
      else if (v === at(x, z + 1) && v > at(x, z + 2)) center.push([i, x + 0.5, z + 1, 1, CENTER]);
    }
    if (v > at(x - 1, z)) {
      if (v > at(x + 1, z)) center.push([i, x + 0.5, z + 0.5, CENTER, 1]);
      else if (v === at(x + 1, z) && v > at(x + 2, z)) center.push([i, x + 1, z + 0.5, CENTER, 1]);
    }
  }
  // 짧게 끊긴 조각(주차장·교차로 한가운데 등)은 버리고 길게 이어진 중앙선만 남긴다
  const mark = new Int32Array(N).fill(-1);
  center.forEach(([i], k) => { mark[i] = k; });
  const comp = new Int32Array(center.length).fill(-1), size = [];
  for (let k = 0; k < center.length; k++) {
    if (comp[k] >= 0) continue;
    const id = size.length, stack = [k];
    comp[k] = id; size.push(0);
    while (stack.length) {
      const c = stack.pop(); size[id]++;
      const i = center[c][0], x = i % W, z = (i / W) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const j = mark[nz * W + nx];
        if (j >= 0 && comp[j] < 0) { comp[j] = id; stack.push(j); }
      }
    }
  }
  center.forEach(([, cx, cz, sx, sz], k) => { if (size[comp[k]] >= MIN_RUN) quads.push([cx, cz, sx, sz, 1]); });

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(quads.length, 1));
  const m = new THREE.Matrix4(), col = new THREE.Color();
  quads.forEach(([cx, cz, sx, sz, y], k) => {
    m.makeScale(sx, 1, sz).setPosition(cx, 0.02, cz);
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, col.setHex(y ? 0xf2c12e : 0xf1f3f5));
  });
  mesh.count = quads.length;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "road-markings";
  return mesh;
}
