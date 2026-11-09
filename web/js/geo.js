// 경위도 ↔ 지도 칸(x, z) — 정확한 버전 (backend/geo.py, data/voxelfmt.py 와 같은 공식. 고치면 세 곳 같이)
// 지도는 EPSG:5186(중부원점 TM, 미터) 격자. 예전 단순 비례식(1도=111320m)은 15~38m 어긋났다.
const A = 6378137.0, F = 1 / 298.257222101, E2 = 2 * F - F * F, EP2 = E2 / (1 - E2);
const R = Math.PI / 180, LAT0 = 38 * R, LON0 = 127 * R, K0 = 1, FE = 200000, FN = 600000;
const { sin, cos, tan, sqrt } = Math;

function mArc(p) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * p - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * sin(2 * p)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * sin(4 * p) - ((35 * e6) / 3072) * sin(6 * p));
}
const M0 = mArc(LAT0);

export function toTM(lat, lng) {
  const p = lat * R, l = lng * R;
  const n = A / sqrt(1 - E2 * sin(p) ** 2), t = tan(p) ** 2, c = EP2 * cos(p) ** 2, a = (l - LON0) * cos(p);
  const x = FE + K0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120);
  const y = FN + K0 * (mArc(p) - M0 + n * tan(p) * ((a * a) / 2 + ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24
    + ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720));
  return [x, y];
}

export function fromTM(x, y) {
  const m = M0 + (y - FN) / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - sqrt(1 - E2)) / (1 + sqrt(1 - E2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * sin(6 * mu) + ((1097 * e1 ** 4) / 512) * sin(8 * mu);
  const c1 = EP2 * cos(p1) ** 2, t1 = tan(p1) ** 2, n1 = A / sqrt(1 - E2 * sin(p1) ** 2);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin(p1) ** 2) ** 1.5, d = (x - FE) / (n1 * K0);
  const lat = p1 - ((n1 * tan(p1)) / r1) * ((d * d) / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lng = LON0 + (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) / cos(p1);
  return [lat / R, lng / R];
}

/** 칸 (x, z) 가운데 → { lat, lng }. meta.tm 이 없으면 예전 근사식 */
export function cellToLatLng(meta, x, z) {
  let lat, lng;
  if (meta.tm) [lat, lng] = fromTM(meta.tm.x0 + (x + 0.5) * meta.cell, meta.tm.y1 - (z + 0.5) * meta.cell);
  else {
    lat = meta.origin_lat - ((z + 0.5) * meta.cell) / 111320;
    lng = meta.origin_lng + ((x + 0.5) * meta.cell) / (111320 * cos(meta.origin_lat * R));
  }
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}

/** 경위도 → 칸 { x, z } (지도 밖일 수 있음) */
export function latLngToCell(meta, lat, lng) {
  if (meta.tm) {
    const [tx, ty] = toTM(lat, lng);
    return { x: Math.floor((tx - meta.tm.x0) / meta.cell), z: Math.floor((meta.tm.y1 - ty) / meta.cell) };
  }
  return {
    x: Math.floor(((lng - meta.origin_lng) * 111320 * cos(meta.origin_lat * R)) / meta.cell),
    z: Math.floor(((meta.origin_lat - lat) * 111320) / meta.cell),
  };
}
