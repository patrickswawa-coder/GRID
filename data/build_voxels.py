"""V-World SHP → web/data/voxels.json 변환기 (실제 무실동 맵).

준비물 (data/raw/ 에 넣기, git에는 안 올라감):
  - 건물: V-World 'GIS건물통합정보' (AL_D010_...) SHP  ← 필수
  - 도로: 도로 경계면(폴리곤) 또는 도로 중심선(라인) SHP  ← 선택
  - 공원·녹지, 하천: SHP  ← 선택

실행 예:
  python data/build_voxels.py --buildings data/raw/AL_D010_51_*.shp \
      --roads data/raw/road.shp --parks data/raw/park.shp --water data/raw/river.shp

  # 컬럼 이름이 자동으로 안 잡히면 먼저 확인:
  python data/build_voxels.py --buildings data/raw/xxx.shp --inspect
  # 그다음 직접 지정:
  python data/build_voxels.py --buildings ... --floors-col A26 --use-col A9

범위(--bbox)는 '서 남 동 북' 경위도. 기본값은 무실동 일대 근사값이니 지도에서 확인 후 조정하세요.
"""
import argparse
import math
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from pyproj import Transformer

import voxelfmt as vf

METRIC = "EPSG:5186"  # 중부원점 TM (미터)
DEFAULT_BBOX = (127.9080, 37.3186, 127.9380, 37.3455)  # 서, 남, 동, 북 (무실동 + 남쪽 삼육고·남원주IC·호반써밋 원주역, 서쪽 송삼마을)

FLOOR_CANDIDATES = ["A26", "GRND_FLR", "grnd_flr", "지상층수", "FLOORS", "floors"]
HEIGHT_CANDIDATES = ["A16", "HEIGHT", "height", "높이", "BLD_HGT"]
USE_CANDIDATES = ["A9", "MAIN_PURPS", "주용도", "용도", "BDTYP_NM"]


def read(path, bbox_m):
    """범위(bbox) 안의 도형만 읽는다. 시·도 전체 파일(1GB 이상)도 메모리 걱정 없이 처리."""
    import pyogrio

    src_crs = pyogrio.read_info(path).get("crs") or METRIC
    box = shapely.box(*bbox_m)
    if src_crs != METRIC:
        box = gpd.GeoSeries([box], crs=METRIC).to_crs(src_crs).iloc[0]
    g = None
    for enc in ("cp949", "utf-8", None):
        try:
            g = gpd.read_file(path, bbox=box.bounds, encoding=enc) if enc else gpd.read_file(path, bbox=box.bounds)
            break
        except Exception as e:
            err = e
    if g is None:
        raise SystemExit(f"{path} 를 읽지 못했어요: {err}")
    if g.crs is None:
        print(f"! {path}: 좌표계 정보(.prj)가 없어 EPSG:5186 으로 가정합니다")
        g = g.set_crs(METRIC)
    g = g.to_crs(METRIC)
    return g[g.intersects(shapely.box(*bbox_m))].copy()


def pick(cols, cands, override):
    if override:
        return override
    return next((c for c in cands if c in cols), None)


def rasterize(geoms, values, xs, ys, out):
    """셀 중심이 폴리곤 안에 있으면 값을 칠한다. xs, ys: 셀 중심 좌표 1차원 배열."""
    x0, cell = xs[0], xs[1] - xs[0]
    y0 = ys[0]
    for geom, val in zip(geoms, values):
        if geom is None or geom.is_empty:
            continue
        minx, miny, maxx, maxy = geom.bounds
        i0 = max(0, int((minx - x0) / cell)); i1 = min(len(xs), int((maxx - x0) / cell) + 2)
        j0 = max(0, int((y0 - maxy) / cell)); j1 = min(len(ys), int((y0 - miny) / cell) + 2)
        if i0 >= i1 or j0 >= j1:
            continue
        gx, gy = np.meshgrid(xs[i0:i1], ys[j0:j1])
        mask = shapely.contains_xy(geom, gx, gy)
        if not mask.any() and geom.area > 0:  # 셀보다 작은 건물도 최소 1칸
            cx, cy = geom.centroid.x, geom.centroid.y
            i, j = int((cx - x0) / cell + 0.5), int((y0 - cy) / cell + 0.5)
            if 0 <= i < len(xs) and 0 <= j < len(ys):
                out[j, i] = val
            continue
        out[j0:j1, i0:i1][mask] = val


# 도로명주소 건물 용도코드 앞 두 자리 → kind_of 가 알아듣는 용도명
JUSO_USE = {"01": "단독주택", "02": "공동주택", "05": "문화및집회시설", "09": "의료시설", "10": "교육연구시설", "11": "노유자시설"}


def add_missing_buildings(bld, path, bbox_m):
    """도로명주소 건물(TL_SPBD_BULD)에서 GIS건물통합정보에 없는 건물만 골라 같은 컬럼 형식으로 붙인다."""
    j = read(path, bbox_m)
    base = shapely.union_all(bld.geometry.to_numpy()) if len(bld) else None
    if base is not None:
        overlap = j.geometry.intersection(base).area / j.area.where(j.area > 0, 1)
        j = j[overlap < 0.3]
    floors = gpd.pd.to_numeric(j.get("GRO_FLO_CO"), errors="coerce").fillna(0)
    extra = gpd.GeoDataFrame({
        "A26": floors.where(floors > 0, 2),
        "A16": 0.0,
        "A9": j["BDTYP_CD"].astype(str).str[:2].map(JUSO_USE).fillna("근린생활시설"),
        "A24": j.get("BULD_NM"),
    }, geometry=j.geometry.values, crs=j.crs)
    apply_height_custom(extra, j.get("BULD_NM_DC"))
    print(f"도로명주소 건물에서 빠진 건물 {len(extra)}동 추가")
    return gpd.pd.concat([bld, extra], ignore_index=True)


HEIGHT_CUSTOM = Path(__file__).with_name("height_custom.csv")


def apply_height_custom(extra, detail):
    """새로 지어 도로명주소에 층수가 덜 들어간 건물을 data/height_custom.csv 로 덮어쓴다."""
    if not HEIGHT_CUSTOM.exists() or detail is None:
        return
    detail = detail.fillna("").astype(str).to_numpy()
    names = extra["A24"].fillna("").astype(str).to_numpy()
    for line in HEIGHT_CUSTOM.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        name, dong, floors = [t.strip() for t in line.split(",")[:3]]
        hit = (names == name) & np.array([bool(re.fullmatch(dong, d)) for d in detail])
        extra.loc[hit, "A26"] = float(floors)
        print(f"층수 직접 입력: {name} {hit.sum()}동 → {floors}층")


def kind_of(use: str) -> int:
    use = str(use or "")
    if any(k in use for k in ("아파트", "공동주택", "연립", "다세대")):
        return vf.APT
    if any(k in use for k in ("단독", "다가구", "주택")):
        return vf.HOUSE
    if any(k in use for k in ("공공", "교육", "관공", "업무시설(공", "의료", "문화", "학교")):
        return vf.PUBLIC
    if use:
        return vf.COMMERCIAL
    return vf.HOUSE


# 연속지적도 지목(지번 끝 글자) → 바닥 종류
JIMOK = {
    vf.ROAD: "도철",
    vf.WATER: "천구유",
    vf.PARK: "공체원임묘제",
    vf.SIDEWALK: "대학주차창장종사잡수",
}  # 나머지(전·답·과·목 등)는 잔디


def jimok_col(df):
    """'295-35 대' 처럼 끝 글자가 지목인 컬럼을 찾는다."""
    all_codes = "".join(JIMOK.values()) + "전답과목광염"
    for c in df.columns:
        if c == "geometry":
            continue
        last = df[c].astype(str).str.strip().str[-1]
        if last.isin(list(all_codes)).mean() > 0.8:
            return c
    return None


def paint_parcels(path, bbox_m, xs, ys, ground):
    p = read(path, bbox_m)
    col = jimok_col(p)
    if not col:
        print("! 지적도에서 지목 컬럼을 못 찾았어요 — 바닥은 잔디로 둡니다")
        return
    last = p[col].astype(str).str.strip().str[-1]
    print(f"지적도 {len(p)}필지, 지목 컬럼={col}: " + ", ".join(f"{k}{v}" for k, v in last.value_counts().head(8).items()))
    for val in (vf.SIDEWALK, vf.PARK, vf.WATER, vf.ROAD):  # 도로를 마지막에 칠해 끊기지 않게
        m = last.isin(list(JIMOK[val])).to_numpy()
        rasterize(p.geometry.to_numpy()[m], [val] * int(m.sum()), xs, ys, ground)
    # 넓은 도로의 가장자리 한 칸은 인도로
    road = ground == vf.ROAD
    pad = np.pad(road, 1)
    inner = road & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    ip = np.pad(inner, 1)
    near_inner = ip[:-2, 1:-1] | ip[2:, 1:-1] | ip[1:-1, :-2] | ip[1:-1, 2:]
    ground[road & ~inner & near_inner] = vf.SIDEWALK


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buildings", required=True)
    ap.add_argument("--extra-buildings", help="도로명주소 건물(TL_SPBD_BULD) → 빠진 건물 채우기")
    ap.add_argument("--parcels", help="연속지적도 (clip_parcels.py 결과) → 도로·공원·하천·대지 바닥")
    ap.add_argument("--roads"); ap.add_argument("--parks"); ap.add_argument("--water")
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX, metavar=("W", "S", "E", "N"))
    ap.add_argument("--cell", type=float, default=5.0)
    ap.add_argument("--floor-m", type=float, default=3.0, help="층당 높이(m)")
    ap.add_argument("--road-width", type=float, default=8.0, help="중심선 라인일 때 도로 폭(m)")
    ap.add_argument("--floors-col"); ap.add_argument("--height-col"); ap.add_argument("--use-col")
    ap.add_argument("--inspect", action="store_true", help="컬럼만 출력하고 종료")
    ap.add_argument("--out", default=str(vf.OUT))
    a = ap.parse_args()

    w, s, e, n = a.bbox
    tf = Transformer.from_crs("EPSG:4326", METRIC, always_xy=True)
    (mx0, my0), (mx1, my1) = tf.transform(w, s), tf.transform(e, n)
    bbox_m = (mx0, my0, mx1, my1)

    bld = read(a.buildings, bbox_m)
    if a.extra_buildings and not a.inspect:
        bld = add_missing_buildings(bld, a.extra_buildings, bbox_m)
    if a.inspect:
        print(bld.drop(columns="geometry").head(5).T.to_string())
        return
    print(f"건물 {len(bld)}동 (범위 안)")

    fcol = pick(bld.columns, FLOOR_CANDIDATES, a.floors_col)
    hcol = pick(bld.columns, HEIGHT_CANDIDATES, a.height_col)
    ucol = pick(bld.columns, USE_CANDIDATES, a.use_col)
    print(f"층수 컬럼={fcol}  높이 컬럼={hcol}  용도 컬럼={ucol}  (틀리면 --inspect 로 확인)")

    meters = np.zeros(len(bld))
    if hcol:
        meters = gpd.pd.to_numeric(bld[hcol], errors="coerce").fillna(0).to_numpy()
    if fcol:
        floors = gpd.pd.to_numeric(bld[fcol], errors="coerce").fillna(0).to_numpy()
        meters = np.where(meters > 0, meters, floors * a.floor_m)
    meters = np.where(meters > 0, meters, a.floor_m * 2)  # 정보 없으면 2층
    hblocks = np.clip(np.round(meters / a.cell), 1, 60).astype(int)
    kinds_v = [kind_of(u) for u in (bld[ucol] if ucol else [None] * len(bld))]

    W = int(math.ceil((mx1 - mx0) / a.cell)); D = int(math.ceil((my1 - my0) / a.cell))
    xs = mx0 + (np.arange(W) + 0.5) * a.cell
    ys = my1 - (np.arange(D) + 0.5) * a.cell

    ground = np.full((D, W), vf.GRASS, np.uint8)
    if a.parcels:
        paint_parcels(a.parcels, bbox_m, xs, ys, ground)
    for path, val in ((a.parks, vf.PARK), (a.water, vf.WATER)):
        if path:
            g = read(path, bbox_m)
            rasterize(g.geometry, [val] * len(g), xs, ys, ground)
    if a.roads:
        r = read(a.roads, bbox_m)
        lines = r.geom_type.str.contains("Line")
        geoms = r.geometry.where(~lines, r.geometry.buffer(a.road_width / 2))
        side = geoms.buffer(a.cell * 0.8)
        rasterize(side, [vf.SIDEWALK] * len(r), xs, ys, ground)
        rasterize(geoms, [vf.ROAD] * len(r), xs, ys, ground)

    heights = np.zeros((D, W), np.int32)
    kinds = np.zeros((D, W), np.int32)
    order = np.argsort(hblocks)  # 높은 건물이 나중에 칠해지도록
    geoms = bld.geometry.to_numpy()
    rasterize(geoms[order], hblocks[order], xs, ys, heights)
    rasterize(geoms[order], np.array(kinds_v)[order], xs, ys, kinds)

    vf.save(a.out, name="원주시 무실동", cell=a.cell, origin_lat=n, origin_lng=w,
            ground=ground, heights=heights, kinds=kinds, source="vworld",
            tm={"crs": METRIC, "x0": round(mx0, 3), "y1": round(my1, 3)})  # 격자 원점: 정확한 경위도 변환용


if __name__ == "__main__":
    main()
