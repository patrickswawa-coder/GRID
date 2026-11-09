"""열섬 위험 지수 (서버용) + 구역별 우선 개선 순위.

web/js/heat.js 와 **같은 계산**을 numpy 로 옮긴 것. 둘 중 하나를 고치면 다른 쪽도 같이 고칠 것.
(가중치, 반경, 점수 구간, 제안 효과 EFFECTS ↔ web/js/types.js 의 effect)

GET /api/priority  → 구역(200m)별 열섬 지수, 제안 실현 시 지수, 제안·신고·공감 수, 우선순위 점수
"""
import json
import math
from pathlib import Path

import numpy as np

import geo
from fastapi import APIRouter

router = APIRouter()
WEB = Path(__file__).resolve().parents[1] / "web" / "data"

GRASS, ROAD, SIDEWALK, PARK, WATER = 0, 1, 2, 3, 4
RADIUS = 10
W8 = (0.45, 0.2, 0.15, -0.45, -0.3)
ANCHORS = [(-0.45, 0), (0.15, 40), (0.42, 70), (0.56, 100)]
# web/js/types.js 의 effect 와 같게
EFFECTS = {
    "tree": dict(size=5, green=0.6),
    "pocketpark": dict(size=7, green=1, impCut=1),
    "shade": dict(size=5, impCut=0.5),
    "coolfog": dict(size=7, water=0.5),
    "greenroof": dict(size=9, roofCut=0.7),
    "coolpave": dict(size=9, impCut=0.6),
}
FIX = set(EFFECTS)
# 여러 칸 제안(자유 그리기·네모·줄) — web/js/shape.js 의 STEP, MAX_CELLS, expandCells() 와 같게
# (두 언어 결과를 맞추려고 hypot 대신 sqrt, round 대신 floor(v + 0.5))
STEP = {"tree": 3, "shade": 3, "coolfog": 4, "pocketpark": 4, "greenroof": 3, "coolpave": 3}
MAX_CELLS = 50
MAX_POINTS = 300
SHAPES = ("line", "area", "path")


def _rnd(v):
    return math.floor(v + 0.5)


def _len(dx, dz):
    return math.sqrt(dx * dx + dz * dz)


def _points(c):
    pts = c.get("points")
    if isinstance(pts, str):
        try:
            pts = json.loads(pts)
        except ValueError:
            pts = None
    return pts if isinstance(pts, list) else None


def path_length(points):
    return sum(_len(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) for i in range(1, len(points)))


def _along_path(points, step):
    total = path_length(points)
    targets, t = [], 0.0
    while t <= total + 1e-9:
        targets.append(t)
        t += step
    if total - targets[-1] >= step / 2:
        targets.append(total)
    out, seg, seg_start = [], 1, 0.0
    for t in targets:
        while True:
            ax, az = points[seg - 1]
            dx, dz = points[seg][0] - ax, points[seg][1] - az
            L = _len(dx, dz)
            if t <= seg_start + L + 1e-9 or seg == len(points) - 1:
                break
            seg_start += L
            seg += 1
        f = min(1, (t - seg_start) / L) if L > 0 else 0
        p = (_rnd(ax + dx * f), _rnd(az + dz * f))
        if p not in out:
            out.append(p)
    return out


def expand_cells(c):
    """제안 dict {type, x, z, x2?, z2?, shape?, points?} → 블록이 놓일 [(x, z)]"""
    shape, x2, z2 = c.get("shape"), c.get("x2"), c.get("z2")
    x, z = c["x"], c["z"]
    step = STEP.get(c["type"], 3)
    if shape == "path":
        pts = _points(c)
        return _along_path(pts, step) if pts and len(pts) >= 2 else [(x, z)]
    if shape not in ("line", "area") or x2 is None or z2 is None:
        return [(x, z)]
    if shape == "line":
        dx, dz = x2 - x, z2 - z
        n = max(1, _rnd(_len(dx, dz) / step))
        out = []
        for i in range(n + 1):
            p = (_rnd(x + dx * i / n), _rnd(z + dz * i / n))
            if p not in out:
                out.append(p)
        return out

    def axis(a, b):
        lo, span = min(a, b), abs(b - a)
        n = span // step + 1
        off = (span - (n - 1) * step) // 2
        return [lo + off + i * step for i in range(n)]

    return [(px, pz) for pz in axis(z, z2) for px in axis(x, x2)]

_state = {}  # 지도·기본 지수 캐시


def _load():
    if _state:
        return _state
    import base64

    doc = json.loads((WEB / "voxels.json").read_text(encoding="utf-8"))
    m = doc["meta"]
    W, D = m["width"], m["depth"]
    ground = np.frombuffer(base64.b64decode(doc["ground"]), dtype=np.uint8).reshape(D, W)
    H = np.zeros((D, W), np.float32)
    b = doc["buildings"]
    H[np.array(b[1::4]), np.array(b[0::4])] = np.array(b[2::4])
    try:
        labels = json.loads((WEB / "labels.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        labels = []
    _state.update(meta=m, ground=ground, H=H, labels=labels)
    _state["base"] = compute(None)
    return _state


def _box_mean(a, R):
    D, W = a.shape
    S = np.zeros((D + 1, W + 1))
    S[1:, 1:] = a.cumsum(0).cumsum(1)
    z = np.arange(D); x = np.arange(W)
    z0, z1 = np.clip(z - R, 0, D), np.clip(z + R + 1, 0, D)
    x0, x1 = np.clip(x - R, 0, W), np.clip(x + R + 1, 0, W)
    tot = S[z1][:, x1] - S[z0][:, x1] - S[z1][:, x0] + S[z0][:, x0]
    return tot / ((z1 - z0)[:, None] * (x1 - x0)[None, :])


def _score(raw):
    xs, ys = zip(*ANCHORS)
    return np.interp(raw, xs, ys)


def compute(proposals):
    """proposals: [(type, x, z)] 또는 None → 칸별 0~100 지수"""
    g, H = _state["ground"], _state["H"]
    bld = H > 0
    imp = np.where(bld | (g == ROAD) | (g == SIDEWALK), 1.0, 0.0)
    cov = bld.astype(float)
    hgt = np.minimum(H / 8, 1)
    grn = np.where(~bld & (g == PARK), 1.0, np.where(~bld & (g == GRASS), 0.6, 0.0))
    wat = np.where(~bld & (g == WATER), 1.0, 0.0)
    if proposals:
        D, W = g.shape
        mg, mw, mi, mr = (np.zeros((D, W)) for _ in range(4))
        for t, x, z in proposals:
            e = EFFECTS.get(t)
            if not e:
                continue
            r = e["size"] // 2
            sl = (slice(max(0, z - r), min(D, z + r + 1)), slice(max(0, x - r), min(W, x + r + 1)))
            for arr, k in ((mg, "green"), (mw, "water"), (mi, "impCut"), (mr, "roofCut")):
                if e.get(k):
                    arr[sl] = np.minimum(1, arr[sl] + e[k])
        # heat.js features() 와 같은 순서·식
        rc = np.where(bld, mr, 0)
        cov = cov * (1 - rc * 0.5); hgt = hgt * (1 - rc * 0.5); imp = imp * (1 - rc * 0.8)
        grn = np.where(bld & (rc > 0), np.maximum(grn, rc * 0.7), grn)
        imp = np.where(~bld, imp * (1 - mi), imp)
        eg = np.where(~bld, mg, 0)
        grn = np.minimum(1, grn + eg); imp = imp * (1 - eg * 0.7)
        wat = np.minimum(1, wat + mw)
    comb = W8[0] * imp + W8[1] * cov + W8[2] * hgt + W8[3] * grn + W8[4] * wat
    return _score(_box_mean(comb, RADIUS))


def zone_key(x, z, s):
    return f"{chr(65 + x // s)}{z // s + 1}"


def zone_name(zone, s, labels):
    zx, zz = ord(zone[0]) - 65, int(zone[1:]) - 1
    cx, cz = zx * s + s / 2, zz * s + s / 2
    best, bd = None, 1e9
    for l in labels:
        d = math.hypot(l["x"] - cx, l["z"] - cz)
        if d < bd:
            best, bd = l, d
    return f"{best['name']} 주변" if best and bd < s * 1.2 else f"구역 {zone}"


def priority(complaints):
    st = _load()
    m = st["meta"]; s = m.get("zone_size", 40); W, D = m["width"], m["depth"]
    base = st["base"]
    props = [(c["type"], px, pz) for c in complaints if c["type"] in FIX
             for px, pz in expand_cells(c) if 0 <= px < W and 0 <= pz < D]
    after = compute(props) if props else base

    zones = {}
    for zz in range(0, D, s):
        for zx in range(0, W, s):
            key = zone_key(zx, zz, s)
            b = base[zz:zz + s, zx:zx + s]
            a = after[zz:zz + s, zx:zx + s]
            hb = st["H"][zz:zz + s, zx:zx + s] > 0
            g = st["ground"][zz:zz + s, zx:zx + s]
            urban = hb.mean()
            # 토지 구성 (AI 정책 제안이 '자료에 있는 근거'만 쓰도록 같이 넘김)
            paved = (hb | (g == ROAD) | (g == SIDEWALK)).mean()
            green = (~hb & (g == PARK)).mean() + 0.6 * (~hb & (g == GRASS)).mean()
            lat, lng = geo.cell_to_latlng(m, zx + s / 2 - 0.5, zz + s / 2 - 0.5)  # 구역 가운데 (정확한 TM 변환)
            zones[key] = dict(zone=key, heat=float(b.mean()), heat_p90=float(np.percentile(b, 90)),
                              heat_after=float(a.mean()), built=float(urban), paved=float(paved), green=float(green),
                              lat=lat, lng=lng, proposals=0, reports=0, likes=0, types={})
    for c in complaints:
        if not (0 <= c["x"] < W and 0 <= c["z"] < D):
            continue
        z = zones[zone_key(c["x"], c["z"], s)]
        z["proposals" if c["type"] in FIX else "reports"] += 1
        z["likes"] += c.get("likes", 0)
        z["types"][c["type"]] = z["types"].get(c["type"], 0) + 1

    # 우선순위 = 열섬(구역 평균, 60%) + 시민 요구(제안+신고+공감/2, 40%)
    # 예전에는 상위 10% 칸(heat_p90)을 썼는데, 지수가 100에서 잘리기 때문에 시가지 구역 여러 곳이 100으로
    # 동점이 되고 동점끼리 순서가 임의로 정해졌다 (평균 49인 구역이 3위). 평균은 포화가 거의 없고,
    # 시민 페이지 리포트의 'TOP 3'(heat.js zoneHeat = 구역 평균)와도 같은 기준이다.
    demand = {k: z["proposals"] + z["reports"] + z["likes"] / 2 for k, z in zones.items()}
    dmax = max(demand.values()) or 1
    out = []
    for k, z in zones.items():
        if z["built"] < 0.02 and demand[k] == 0:
            continue  # 숲·밭만 있는 구역은 제외
        z["score"] = round(0.6 * z["heat"] + 0.4 * 100 * math.sqrt(demand[k] / dmax), 1)
        z["top_type"] = max(z["types"], key=z["types"].get) if z["types"] else None
        z["name"] = zone_name(k, s, st["labels"])
        for f in ("heat", "heat_p90", "heat_after", "lat", "lng"):
            z[f] = round(z[f], 6 if f in ("lat", "lng") else 1)
        for f in ("built", "paved", "green"):
            z[f] = round(z[f], 3)
        z["delta"] = round(z["heat"] - z["heat_after"], 1)
        out.append(z)
    # 반올림 동점은 평균 → 상위 10% 순으로 가른다 (순서가 매번 같게)
    out.sort(key=lambda z: (-z["score"], -z["heat"], -z["heat_p90"], z["zone"]))
    for i, z in enumerate(out):
        z["rank"] = i + 1
    return out


_cache = {"key": None, "data": None}


@router.get("/api/meta")
def api_meta():
    """지도 크기·구역 크기 (관리자 페이지가 구역 격자를 그릴 때 사용)"""
    m = _load()["meta"]
    return {k: m.get(k) for k in ("name", "width", "depth", "cell", "zone_size", "origin_lat", "origin_lng", "tm")}


@router.get("/api/priority")
def api_priority(limit: int = 30):
    from main import db  # 순환 import 방지

    with db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT x, z, x2, z2, shape, points, type, likes, id FROM complaints").fetchall()]
    key = (len(rows), max((r["id"] for r in rows), default=0), sum(r["likes"] for r in rows))
    if _cache["key"] != key:
        _cache.update(key=key, data=priority(rows))
    return _cache["data"][: max(1, min(limit, 300))]
