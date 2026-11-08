"""연속지적도형정보(시·도, 여러 파일로 나뉨)에서 무실동 일대만 잘라 하나로 합친다.

실행 (레포 맨 위 폴더에서, 파일 이름에 * 사용 가능):
  python data/clip_parcels.py "AL_D002_51_*.shp"
→ data/raw/muksil_parcels.gpkg  (도로·공원·하천 등 지목 정보 포함)
"""
import glob
import sys
from pathlib import Path

import pandas as pd
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_voxels import DEFAULT_BBOX, METRIC, read  # noqa: E402

PAD = 500

if len(sys.argv) < 2:
    raise SystemExit('사용법: python data/clip_parcels.py "AL_D002_51_*.shp"')
files = sorted({f for pat in sys.argv[1:] for f in (glob.glob(pat) or [pat])})
out = Path(__file__).resolve().parent / "raw" / "muksil_parcels.gpkg"
out.parent.mkdir(parents=True, exist_ok=True)

w, s, e, n = DEFAULT_BBOX
tf = Transformer.from_crs("EPSG:4326", METRIC, always_xy=True)
(x0, y0), (x1, y1) = tf.transform(w, s), tf.transform(e, n)
bbox = (x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD)

parts = []
for f in files:
    g = read(f, bbox)
    print(f"{f}: {len(g)}필지")
    if len(g):
        parts.append(g)
if not parts:
    raise SystemExit("무실동 범위에 해당하는 필지가 없어요. 파일이 강원도 것이 맞는지 확인해 주세요.")
g = pd.concat(parts, ignore_index=True)
g.to_file(out, driver="GPKG")
print(f"합계 {len(g)}필지 → {out} ({out.stat().st_size / 1024 / 1024:.1f}MB)")
print("컬럼:", ", ".join(c for c in g.columns if c != "geometry"))
