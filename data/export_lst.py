"""위성 지표온도 ↔ 열섬 지수 비교 결과를 대시보드용 작은 JSON 으로 저장 (web/data/lst_compare.json)

    python data/fetch_lst.py     # 먼저 한 번: data/raw/muksil_lst.tif (Landsat 여름 장면, 키 필요 없음)
    python data/export_lst.py    # → web/data/lst_compare.json  (대시보드 '근거' 그림)

서버에서 (geopandas 없이 됨):
    cd ~/GRID && .venv/bin/pip install -q rasterio scipy pystac-client planetary-computer
    .venv/bin/python data/fetch_lst.py && .venv/bin/python data/export_lst.py && ./deploy.sh

계산은 data/calibrate_lst.py 와 같음: 장면마다 무실동 평균과의 차이(°C) → 평균 → 지도 5m 격자 → 100m 구역 평균.
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate_lst as cl  # noqa: E402  (rasterio·scipy 필요, 없으면 설치 안내 후 끝남)

hm = cl.hm
OUT = cl.ROOT / "web" / "data" / "lst_compare.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tif", default=str(cl.LST), help="위성 지표온도 파일 (fetch_lst.py 결과)")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    cl.LST = Path(a.tif)
    if not cl.LST.exists():
        sys.exit(f"{cl.LST} 가 없어요. 먼저 python data/fetch_lst.py")

    st = hm._load()
    g, H, idx = st["ground"], st["H"], st["base"]
    print("위성 장면:")
    anom = cl.lst_anomaly(st["meta"], g.shape)
    import rasterio
    with rasterio.open(cl.LST) as src:
        scenes = [d for d in src.descriptions if d]

    def compare(b):
        y, x = cl.blocks(anom, b), cl.blocks(idx, b)
        f = np.isfinite(y) & np.isfinite(x)
        r = float(np.corrcoef(x[f], y[f])[0, 1])
        k = np.polyfit(x[f], y[f], 1)
        return x[f], y[f], r, k

    x, y, r100, k = compare(20)
    _, _, r30, _ = compare(6)
    bld = H > 0
    kinds = (("저층 건물", (H >= 1) & (H < 3)), ("중층 건물", (H >= 3) & (H < 8)), ("고층 건물(40m+)", H >= 8),
             ("차도", ~bld & (g == hm.ROAD)), ("인도·대지", ~bld & (g == hm.SIDEWALK)),
             ("공원·숲", ~bld & (g == hm.PARK)), ("잔디·밭", ~bld & (g == hm.GRASS)), ("하천", ~bld & (g == hm.WATER)))
    types = [{"name": n, "dT": round(float(np.nanmean(anom[m])), 1)} for n, m in kinds if m.any()]
    doc = {
        "source": "Landsat 8·9 Collection 2 Level-2 표면온도 (Microsoft Planetary Computer)",
        "scenes": scenes, "block_m": 100, "r100": round(r100, 2), "r30": round(r30, 2),
        "slope10": round(float(k[0]) * 10, 2), "intercept": round(float(k[1]), 2),
        "points": [[round(float(p), 1), round(float(q), 2)] for p, q in zip(x, y)],
        "types": types, "made_at": dt.date.today().isoformat(),
    }
    Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n100m 구역 {len(x)}곳: 상관 r={r100:.2f} (30m 구역 r={r30:.2f}), 지수 10점 ≈ {k[0] * 10:.2f}°C")
    print(f"저장: {a.out}  ({Path(a.out).stat().st_size / 1024:.0f}KB) → 서버면 ./deploy.sh 로 대시보드에 반영")


if __name__ == "__main__":
    main()
