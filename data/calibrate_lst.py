"""열섬 지수 ↔ 위성 지표온도 비교·가중치 보정 (발표 근거 재현용)

    python data/fetch_lst.py        # 먼저: data/raw/muksil_lst.tif (Landsat 여름 장면들)
    python data/calibrate_lst.py    # 상관·바닥 종류별 온도·추천 가중치 출력

방법
1) 장면마다 '무실동 평균과의 차이'(°C)를 구해 평균 → 날씨가 다른 날도 같이 쓸 수 있음
2) 지도 5m 격자(EPSG:5186)로 다시 맞춘 뒤 30m·100m 구역 평균으로 비교 (열 센서 원래 해상도 100m)
3) 특성(포장면·건물덮개·높이·녹지·물, 주변 50m 평균)으로 부호를 정한 최소제곱(NNLS) 맞춤
"""
import sys
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject
    from scipy.optimize import nnls
except ImportError:
    sys.exit("먼저 설치해 주세요:  pip install rasterio scipy")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import heatmodel as hm  # noqa: E402

LST = ROOT / "data" / "raw" / "muksil_lst.tif"
NAMES = ("포장면", "건물덮개", "높이", "녹지", "물")
SIGN = np.array([1, 1, -1, -1, -1])  # 부호 제약 (데워짐 +, 식힘 −)


def lst_anomaly(meta, shape):
    D, W = shape
    tm = meta["tm"]
    dst = from_origin(tm["x0"], tm["y1"], meta["cell"], meta["cell"])
    with MemoryFile(LST.read_bytes()) as mf, mf.open() as src:  # 한글 경로 대비 메모리로
        out = []
        for i in range(1, src.count + 1):
            a = np.full((D, W), np.nan, np.float32)
            reproject(src.read(i), a, src_transform=src.transform, src_crs=src.crs, dst_transform=dst,
                      dst_crs=tm["crs"], resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
            out.append(a - np.nanmean(a))
            print(f"  {src.descriptions[i - 1]}: 평균 대비 범위 {np.nanpercentile(out[-1], 2):.1f} ~ {np.nanpercentile(out[-1], 98):.1f}°C")
    return np.nanmean(out, axis=0)


def blocks(a, b):
    D, W = a.shape
    d, w = (D // b) * b, (W // b) * b
    return np.nanmean(a[:d, :w].reshape(D // b, b, W // b, b), axis=(1, 3)).ravel()


def main():
    if not LST.exists():
        sys.exit(f"{LST} 가 없어요. 먼저 python data/fetch_lst.py")
    st = hm._load()
    g, H = st["ground"], st["H"]
    print("위성 장면:")
    anom = lst_anomaly(st["meta"], g.shape)
    bld = H > 0
    feats = (
        np.where(bld | (g == hm.ROAD) | (g == hm.SIDEWALK), 1.0, 0.0),
        bld.astype(float),
        np.minimum(H / 8, 1),
        np.where(~bld & (g == hm.PARK), 1.0, np.where(~bld & (g == hm.GRASS), 0.6, 0.0)),
        np.where(~bld & (g == hm.WATER), 1.0, 0.0),
    )
    idx = st["base"]
    print("\n지금 지수 vs 위성 (무실동 평균 대비 °C)")
    for b in (6, 20):
        y, x = blocks(anom, b), blocks(idx, b)
        f = np.isfinite(y)
        r = np.corrcoef(x[f], y[f])[0, 1]
        k = np.polyfit(x[f], y[f], 1)
        print(f"  {b * 5}m 구역: r={r:.2f}  지수 10점 ≈ {k[0] * 10:.2f}°C  ({f.sum()}구역)")

    print("\n바닥 종류별 위성 온도 (무실동 평균 대비)")
    for nm, m in (("저층 건물(~10m)", (H >= 1) & (H < 3)), ("중층 건물", (H >= 3) & (H < 8)), ("고층 건물(40m+)", H >= 8),
                  ("차도", ~bld & (g == hm.ROAD)), ("인도·대지", ~bld & (g == hm.SIDEWALK)),
                  ("공원·숲", ~bld & (g == hm.PARK)), ("잔디·밭", ~bld & (g == hm.GRASS)), ("물", ~bld & (g == hm.WATER))):
        print(f"  {nm:12s} {np.nanmean(anom[m]):+.1f}°C")

    print("\n가중치 맞춤 (주변 50m 평균, 부호 제약, 포장면은 4°C로 고정 — 0이면 그늘막·투수포장 제안 효과가 사라짐)")
    F = [hm._box_mean(a, hm.RADIUS) for a in feats]
    for b in (6, 20):
        y = blocks(anom, b)
        f = np.isfinite(y)
        X = np.stack([blocks(a, b) for a in F], 1)[f]
        X -= X.mean(0)
        ym = y[f] - y[f].mean()
        c, _ = nnls(X[:, 1:] * SIGN[1:], ym - 4.0 * X[:, 0])
        w = np.r_[4.0, c * SIGN[1:]]
        r2 = 1 - ((ym - X @ w) ** 2).sum() / (ym ** 2).sum()
        print(f"  {b * 5}m 구역: R²={r2:.2f}  " + ", ".join(f"{n} {v:+.1f}" for n, v in zip(NAMES, w)))
    print(f"\n지금 코드의 가중치(heatmodel.W8): " + ", ".join(f"{n} {v:+.1f}" for n, v in zip(NAMES, hm.W8)))


if __name__ == "__main__":
    main()
