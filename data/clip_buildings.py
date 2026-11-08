"""시·도 전체 건물 SHP(1GB 이상)에서 무실동 일대만 잘라 작은 파일로 저장한다.

실행 (레포 맨 위 폴더에서):
  python data/clip_buildings.py AL_D010_51_20261009.shp
→ data/raw/muksil_buildings.gpkg  (수 MB, 층수·용도 등 모든 컬럼 유지)

이후 변환: python data/build_voxels.py --buildings data/raw/muksil_buildings.gpkg
"""
import sys
from pathlib import Path

from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_voxels import DEFAULT_BBOX, METRIC, read  # noqa: E402

PAD = 500  # 나중에 범위를 조금 넓힐 수 있게 사방 500m 여유

if len(sys.argv) < 2:
    raise SystemExit("사용법: python data/clip_buildings.py <건물 SHP 경로> [출력 경로]")
src = sys.argv[1]
out = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parent / "raw" / "muksil_buildings.gpkg")
out.parent.mkdir(parents=True, exist_ok=True)

w, s, e, n = DEFAULT_BBOX
tf = Transformer.from_crs("EPSG:4326", METRIC, always_xy=True)
(x0, y0), (x1, y1) = tf.transform(w, s), tf.transform(e, n)
g = read(src, (x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD))
g.to_file(out, driver="GPKG")
print(f"건물 {len(g)}동 → {out} ({out.stat().st_size / 1024 / 1024:.1f}MB)")
print("컬럼:", ", ".join(c for c in g.columns if c != "geometry"))
