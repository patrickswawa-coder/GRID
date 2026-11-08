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
// 건물 종류별 [벽, 지붕, 창문]
const KIND_STYLE = [
  [0xfaf8f2, 0xc9c4ba, 0x8fb0c8], // 0 아파트: 흰 벽, 회색 옥상
  [0xf0e2c8, 0xc8553d, 0x7a8fa0], // 1 단독주택: 베이지 벽, 빨간 지붕
  [0xc9d5de, 0x8d99a3, 0x7f9fbc], // 2 상업: 회청색, 띠 창
  [0xefd9a0, 0xd2a63a, 0x6b88a0], // 3 공공: 노란 벽
];

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

export function cellToLatLng(meta, x, z) {
  const lat = meta.origin_lat - ((z + 0.5) * meta.cell) / 111320;
  const lng = meta.origin_lng + ((x + 0.5) * meta.cell) / (111320 * Math.cos((meta.origin_lat * Math.PI) / 180));
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}

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
          wall = mix(wall, mix(vWall, vGlass, 0.14), far * step(0.25, v) * step(v, top - 0.18));
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
  const dirt = new THREE.Mesh(new THREE.BoxGeometry(W, 3, D), voxelize(new THREE.MeshLambertMaterial({ color: 0x8b5a2b })));
  dirt.position.set(W / 2, -1.65, D / 2); // 지면과 겹쳐 깜빡이지 않게 살짝 아래로
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
  for (let i = 0, k = 0; i < b.length; i += 4, k++) {
    const [x, z, h, kind] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
    m.makeScale(1, h, 1).setPosition(x + 0.5, 0, z + 0.5);
    mesh.setMatrixAt(k, m);
    const [wall, roof, glass] = KIND_STYLE[kind] ?? KIND_STYLE[0];
    // 같은 건물 안에서는 비슷하게, 건물마다 조금씩 다른 색
    const v = (hash(x >> 2, z >> 2) - 0.5) * 0.06;
    c.setHex(wall).offsetHSL(0, 0, v).toArray(aWall, k * 3);
    c.setHex(roof).offsetHSL(0, 0, v).toArray(aRoof, k * 3);
    c.setHex(glass).toArray(aGlass, k * 3);
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

  group.add(buildTrees(map));

  // 열섬 레이어(heat.js)가 색을 바꿨다 되돌릴 수 있게 원본을 같이 넘긴다
  return { group, ground, buildings: mesh, groundTex, groundBase: tex.slice(), roofBase: aRoof.slice() };
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
