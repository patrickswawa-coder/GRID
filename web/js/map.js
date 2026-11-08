// 3D 복셀 맵: voxels.json 읽기, 지면/건물 그리기, 좌표 변환
// 월드 좌표 1 = 격자 1칸. 칸 (x, z)의 중심은 (x+0.5, ?, z+0.5)
import * as THREE from "three";

const GROUND_COLORS = [
  0x8cc56b, // 0 잔디/빈땅
  0x5b5f66, // 1 차도
  0xcfc6b4, // 2 인도·광장
  0x5fae4e, // 3 공원·녹지
  0x4aa3df, // 4 물
];
const KIND_COLORS = [
  0xe8e2d6, // 0 아파트
  0xc8553d, // 1 단독주택 (빨간 지붕)
  0x8fa7b8, // 2 상업
  0xe0b84c, // 3 공공
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

// 재질에 '블록 테두리' 선을 그려 마인크래프트 느낌을 낸다 (블록을 하나하나 쌓지 않고 셰이더로 처리)
function voxelize(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridN;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 gp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          gp = instanceMatrix * gp;
        #endif
        vGridPos = (modelMatrix * gp).xyz;
        vGridN = normal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridN;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 f = fract(vGridPos + 0.0005);
        vec3 d = min(f, 1.0 - f);
        float edge = abs(vGridN.y) > 0.5 ? min(d.x, d.z) : (abs(vGridN.x) > 0.5 ? min(d.y, d.z) : min(d.x, d.y));
        float w = fwidth(edge) * 1.5;
        float line = (1.0 - smoothstep(0.035, 0.035 + w, edge)) * (1.0 - smoothstep(0.08, 0.25, w));
        diffuseColor.rgb *= mix(1.0, 0.7, line);
        if (vGridN.y > 0.5) diffuseColor.rgb *= 1.12;`
      );
  };
  return material;
}

export function buildScene(map) {
  const { meta } = map;
  const W = meta.width, D = meta.depth;
  const group = new THREE.Group();

  // 지면: 칸마다 색을 칠한 텍스처 (픽셀 그대로 보이게 NearestFilter)
  const tex = new Uint8Array(W * D * 4);
  const c = new THREE.Color();
  for (let i = 0; i < W * D; i++) {
    c.setHex(GROUND_COLORS[map.ground[i]] ?? GROUND_COLORS[0]);
    const n = 0.94 + ((i * 2654435761) % 997) / 997 * 0.08; // 칸마다 살짝 다른 밝기
    tex[i * 4] = Math.min(255, c.r * 255 * n);
    tex[i * 4 + 1] = Math.min(255, c.g * 255 * n);
    tex[i * 4 + 2] = Math.min(255, c.b * 255 * n);
    tex[i * 4 + 3] = 255;
  }
  const groundTex = new THREE.DataTexture(tex, W, D);
  groundTex.magFilter = THREE.NearestFilter;
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.flipY = false;
  groundTex.needsUpdate = true;

  const groundGeo = new THREE.PlaneGeometry(W, D);
  groundGeo.rotateX(-Math.PI / 2);
  // PlaneGeometry UV: v=1이 -z(북쪽). 텍스처 0행 = z=0(북쪽)이 되도록 v를 뒤집는다
  const uv = groundGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const ground = new THREE.Mesh(groundGeo, voxelize(new THREE.MeshLambertMaterial({ map: groundTex })));
  ground.position.set(W / 2, 0, D / 2);
  ground.name = "ground";
  group.add(ground);

  // 땅 덩어리 아래 흙 (그림처럼 떠 있는 섬 느낌)
  const dirt = new THREE.Mesh(
    new THREE.BoxGeometry(W, 3, D),
    voxelize(new THREE.MeshLambertMaterial({ color: 0x8b5a2b }))
  );
  dirt.position.set(W / 2, -1.51, D / 2);
  group.add(dirt);

  // 건물: 칸마다 기둥 하나 (InstancedMesh 한 번에 그림)
  const b = map.buildings;
  const count = b.length / 4;
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(box, voxelize(new THREE.MeshLambertMaterial()), Math.max(count, 1));
  const m = new THREE.Matrix4();
  for (let i = 0, k = 0; i < b.length; i += 4, k++) {
    const [x, z, h, kind] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
    m.makeScale(1, h, 1).setPosition(x + 0.5, 0, z + 0.5);
    mesh.setMatrixAt(k, m);
    c.setHex(KIND_COLORS[kind] ?? KIND_COLORS[0]);
    c.offsetHSL(0, 0, ((((x * 73856093) ^ (z * 19349663)) >>> 0) % 100) / 100 * 0.06 - 0.03);
    mesh.setColorAt(k, c);
  }
  mesh.count = count;
  mesh.name = "buildings";
  group.add(mesh);

  return { group, ground, buildings: mesh };
}
