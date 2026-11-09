"""경위도 ↔ 지도 칸(x, z) 변환 — 정확한 버전.

지도(web/data/voxels.json)는 EPSG:5186(중부원점 TM, 미터) 격자로 만들어졌다 (data/build_voxels.py).
예전엔 위경도를 단순 비례(1도 = 111320m)로 바꿔서 15~38m 어긋났다. 여기서는 TM 공식을 그대로 쓴다.
(pyproj 없이 동작해야 해서 직접 구현. tests/test_geo.py 가 pyproj 결과와 비교)
web/js/geo.js, data/voxelfmt.py 와 같은 공식이다 — 고치면 세 곳을 같이.
"""
import math

# EPSG:5186  Korea 2000 / Central Belt 2010  (GRS80)
A = 6378137.0
F = 1 / 298.257222101
E2 = 2 * F - F * F
EP2 = E2 / (1 - E2)
LAT0, LON0, K0, FE, FN = math.radians(38.0), math.radians(127.0), 1.0, 200000.0, 600000.0


def _m(phi):
    e4, e6 = E2 * E2, E2 * E2 * E2
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
                - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
                - (35 * e6 / 3072) * math.sin(6 * phi))


M0 = _m(LAT0)


def to_tm(lat, lng):
    phi, lam = math.radians(lat), math.radians(lng)
    n = A / math.sqrt(1 - E2 * math.sin(phi) ** 2)
    t = math.tan(phi) ** 2
    c = EP2 * math.cos(phi) ** 2
    a = (lam - LON0) * math.cos(phi)
    x = FE + K0 * n * (a + (1 - t + c) * a ** 3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120)
    y = FN + K0 * (_m(phi) - M0 + n * math.tan(phi) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24
                                                        + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720))
    return x, y


def from_tm(x, y):
    m = M0 + (y - FN) / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    c1 = EP2 * math.cos(p1) ** 2
    t1 = math.tan(p1) ** 2
    n1 = A / math.sqrt(1 - E2 * math.sin(p1) ** 2)
    r1 = A * (1 - E2) / (1 - E2 * math.sin(p1) ** 2) ** 1.5
    d = (x - FE) / (n1 * K0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4 / 24
                                           + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6 / 720)
    lng = LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lat), math.degrees(lng)


def cell_to_latlng(meta, x, z):
    """칸 (x, z)의 가운데 → (위도, 경도). meta에 tm 원점이 없으면 예전 근사식."""
    tm = meta.get("tm")
    if tm:
        return from_tm(tm["x0"] + (x + 0.5) * meta["cell"], tm["y1"] - (z + 0.5) * meta["cell"])
    lat = meta["origin_lat"] - (z + 0.5) * meta["cell"] / 111320
    lng = meta["origin_lng"] + (x + 0.5) * meta["cell"] / (111320 * math.cos(math.radians(meta["origin_lat"])))
    return lat, lng


def latlng_to_cell(meta, lat, lng):
    tm = meta.get("tm")
    if tm:
        tx, ty = to_tm(lat, lng)
        return math.floor((tx - tm["x0"]) / meta["cell"]), math.floor((tm["y1"] - ty) / meta["cell"])
    x = (lng - meta["origin_lng"]) * 111320 * math.cos(math.radians(meta["origin_lat"])) / meta["cell"]
    z = (meta["origin_lat"] - lat) * 111320 / meta["cell"]
    return math.floor(x), math.floor(z)
