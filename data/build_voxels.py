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

import geopandas as gpd
import numpy as np
import shapely
from pyproj import Transformer

import voxelfmt as vf

METRIC = "EPSG:5186"  # 중부원점 TM (미터)
DEFAULT_BBOX = (127.9150, 37.3305, 127.9375, 37.3440)  # 서, 남, 동, 북 (무실동 근사)

FLOOR_CANDIDATES = ["A26", "GRND_FLR", "grnd_flr", "지상층수", "FLOORS", "floors"]
HEIGHT_CANDIDATES = ["A16", "HEIGHT", "height", "높이", "BLD_HGT"]
USE_CANDIDATES = ["A9", "MAIN_PURPS", "주용도", "용도", "BDTYP_NM"]


def read(path, bbox_m):
    for enc in ("cp949", "utf-8", None):
        try:
            g = gpd.read_file(path, encoding=enc) if enc else gpd.read_file(path)
            break
        except Exception:
            continue
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buildings", required=True)
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
            ground=ground, heights=heights, kinds=kinds, source="vworld")


if __name__ == "__main__":
    main()
