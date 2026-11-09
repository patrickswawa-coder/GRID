"""경위도 ↔ 칸 변환이 정확한지 (EPSG:5186 TM). pyproj가 있으면 pyproj와 비교."""
import json
import math
from pathlib import Path

import pytest

import geo

META = json.loads((Path(__file__).resolve().parents[2] / "web/data/voxels.json").read_text(encoding="utf-8"))["meta"]


def test_roundtrip_cells():
    for x, z in [(0, 0), (409, 3), (235, 257), (META["width"] - 1, META["depth"] - 1)]:
        lat, lng = geo.cell_to_latlng(META, x, z)
        assert geo.latlng_to_cell(META, lat, lng) == (x, z)


def test_label_position_is_real():
    # 시외버스터미널 라벨 칸(397, 9)은 실제 위치 근처여야 함 (예전 근사식은 약 26m 어긋났음)
    lat, lng = geo.cell_to_latlng(META, 397, 9)
    assert abs(lat - 37.345129) < 2e-5 and abs(lng - 127.930738) < 2e-5


def test_matches_pyproj():
    pyproj = pytest.importorskip("pyproj")
    f = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
    for lat, lng in [(37.3455, 127.908), (37.3195, 127.938), (37.333, 127.92)]:
        x, y = geo.to_tm(lat, lng)
        X, Y = f.transform(lng, lat)
        assert math.hypot(x - X, y - Y) < 0.01
