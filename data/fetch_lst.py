"""무실동 여름 위성 지표온도(Landsat 8·9 표면온도) 받기 — 키·가입 필요 없음 (Microsoft Planetary Computer)

준비 (한 번만):
    pip install pystac-client planetary-computer rasterio

실행:
    python data/fetch_lst.py
→ data/raw/muksil_lst.tif  (구름 적은 여름 장면들, 장면마다 밴드 1개, 단위 °C, 30m)

열섬 지수(web/js/heat.js) 가중치를 위성 표면온도로 검증·보정하는 데 씁니다.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

try:
    import planetary_computer
    import pystac_client
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
except ImportError:
    sys.exit("먼저 설치해 주세요:  pip install pystac-client planetary-computer rasterio")

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from build_voxels import DEFAULT_BBOX  # (서, 남, 동, 북) — 지도와 같은 범위
except ImportError:  # 서버처럼 geopandas 가 없으면 지도 파일(voxels.json)의 범위로 계산
    import json
    _m = json.loads((Path(__file__).resolve().parents[1] / "web" / "data" / "voxels.json").read_text(encoding="utf-8"))["meta"]
    _x0, _y1, _c = _m["tm"]["x0"], _m["tm"]["y1"], _m["cell"]
    DEFAULT_BBOX = transform_bounds(_m["tm"]["crs"], "EPSG:4326", _x0, _y1 - _m["depth"] * _c, _x0 + _m["width"] * _c, _y1)

OUT = Path(__file__).resolve().parent / "raw" / "muksil_lst.tif"
CACHE = OUT.parent / "lst_cache"  # 받은 원본 (다시 실행할 때 재사용, 지워도 됨)
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
PAD = 0.005  # 지도 경계 바깥 여유 (약 500m)


def summer_ranges(years):
    return [f"{y}-06-01/{y}-09-10" for y in years]


def fetch(item, key):
    """파일을 파이썬으로 내려받아 메모리에서 연다.
    (윈도우 + 한글 사용자 폴더에서 rasterio 가 인터넷 주소를 직접 열면 인코딩 오류가 나서 우회)"""
    import urllib.request
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{item.id}_{key}.tif"
    if not f.exists():
        print(f"    {key} 받는 중…", end="", flush=True)
        with urllib.request.urlopen(item.assets[key].href, timeout=120) as r:
            data = r.read()
        f.write_bytes(data)
        print(f" {len(data) / 1e6:.0f}MB")
    return MemoryFile(f.read_bytes())


def read_scene(item, bbox):
    """장면에서 지도 범위만 잘라 °C 배열로. 구름·그림자는 NaN."""
    with fetch(item, "lwir11") as mf, mf.open() as src:
        b = transform_bounds("EPSG:4326", src.crs, *bbox, densify_pts=21)
        win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        dn = src.read(1, window=win).astype("float64")
        transform, crs = src.window_transform(win), src.crs
    with fetch(item, "qa_pixel") as mf, mf.open() as src:
        q = src.read(1, window=win)
    # Landsat C2 L2 표면온도: DN × 0.00341802 + 149.0 (K)
    t = dn * 0.00341802 + 149.0 - 273.15
    bad = (dn == 0) | ((q & 0b11010) != 0)  # 1 dilated cloud, 3 cloud, 4 cloud shadow
    t[bad] = np.nan
    return t.astype("float32"), transform, crs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2022,2023,2024,2025", help="여름을 찾을 연도들")
    ap.add_argument("--max-cloud", type=float, default=30, help="장면 전체 구름 비율(%%) 상한")
    ap.add_argument("--min-valid", type=float, default=0.9, help="무실동 안 맑은 칸 비율 하한")
    ap.add_argument("--max-scenes", type=int, default=5)
    a = ap.parse_args()

    w, s, e, n = DEFAULT_BBOX
    bbox = (w - PAD, s - PAD, e + PAD, n + PAD)
    cat = pystac_client.Client.open(STAC, modifier=planetary_computer.sign_inplace)
    items = []
    for dr in summer_ranges([int(y) for y in a.years.split(",")]):
        res = cat.search(collections=["landsat-c2-l2"], bbox=bbox, datetime=dr,
                         query={"eo:cloud_cover": {"lt": a.max_cloud}, "platform": {"in": ["landsat-8", "landsat-9"]}})
        items += list(res.items())
    items.sort(key=lambda it: it.properties.get("eo:cloud_cover", 100))
    print(f"후보 장면 {len(items)}개 (여름, 구름 {a.max_cloud:.0f}% 미만)")
    if not items:
        sys.exit("장면이 없어요. --max-cloud 60 처럼 올려서 다시 해 보세요.")

    bands, dates, ref = [], [], None
    for it in items:
        if len(bands) >= a.max_scenes:
            break
        try:
            t, tr, crs = read_scene(it, bbox)
        except Exception as ex:  # 네트워크 일시 오류 등
            print(f"  {it.id}: 건너뜀 ({ex})")
            continue
        if ref is None:
            ref = (t.shape, tr, crs)
        elif t.shape != ref[0] or crs != ref[2]:
            print(f"  {it.id}: 격자가 달라 건너뜀")
            continue
        valid = float(np.isfinite(t).mean())
        day = it.datetime.strftime("%Y-%m-%d")
        if valid < a.min_valid:
            print(f"  {day}: 맑은 칸 {valid:.0%} → 제외")
            continue
        print(f"  {day}: 맑은 칸 {valid:.0%}, 평균 {np.nanmean(t):.1f}°C, 범위 {np.nanpercentile(t, 2):.1f}~{np.nanpercentile(t, 98):.1f}°C")
        bands.append(t)
        dates.append(day)
    if not bands:
        sys.exit("쓸 만한 맑은 장면이 없어요. --min-valid 0.7 --max-cloud 60 으로 다시 해 보세요.")

    shape, tr, crs = ref
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with MemoryFile() as mf:
        with mf.open(driver="GTiff", height=shape[0], width=shape[1], count=len(bands),
                     dtype="float32", crs=crs, transform=tr, nodata=float("nan"), compress="deflate") as dst:
            for i, (b, d) in enumerate(zip(bands, dates), 1):
                dst.write(b, i)
                dst.set_band_description(i, d)
        OUT.write_bytes(mf.read())
    print(f"저장: {OUT}  ({len(bands)}장면, {shape[1]}×{shape[0]}칸, {OUT.stat().st_size / 1e6:.1f}MB)")


if __name__ == "__main__":
    main()
