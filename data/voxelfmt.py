"""web/data/voxels.json 저장 형식 (docs/CONVENTIONS.md 4장)."""
import base64
import json
import math
from pathlib import Path

import numpy as np

GRASS, ROAD, SIDEWALK, PARK, WATER = 0, 1, 2, 3, 4
APT, HOUSE, COMMERCIAL, PUBLIC = 0, 1, 2, 3

OUT = Path(__file__).resolve().parents[1] / "web" / "data" / "voxels.json"


def save(path, *, name, cell, origin_lat, origin_lng, ground: np.ndarray, heights: np.ndarray,
         kinds: np.ndarray, zone_size=40, source="sample"):
    """ground/heights/kinds: (depth, width) 배열. heights=0 이면 건물 없음."""
    depth, width = ground.shape
    zs, xs = np.nonzero(heights)
    flat = np.stack([xs, zs, heights[zs, xs], kinds[zs, xs]], axis=1).astype(int).ravel().tolist()
    doc = {
        "meta": {
            "name": name, "cell": cell, "width": int(width), "depth": int(depth),
            "origin_lat": round(origin_lat, 6), "origin_lng": round(origin_lng, 6),
            "zone_size": zone_size, "source": source,
        },
        "ground": base64.b64encode(ground.astype(np.uint8).tobytes()).decode(),
        "buildings": flat,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {path}  ({width}x{depth}칸, 건물 기둥 {len(xs)}개, {path.stat().st_size/1024:.0f}KB)")


def cell_to_latlng(meta, x, z):
    lat = meta["origin_lat"] - (z + 0.5) * meta["cell"] / 111320
    lng = meta["origin_lng"] + (x + 0.5) * meta["cell"] / (111320 * math.cos(math.radians(meta["origin_lat"])))
    return lat, lng


def zone_of(meta, x, z):
    zs = meta.get("zone_size", 40)
    return f"{chr(65 + x // zs)}{z // zs + 1}"


def load(path=OUT):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    m = doc["meta"]
    ground = np.frombuffer(base64.b64decode(doc["ground"]), dtype=np.uint8).reshape(m["depth"], m["width"])
    return doc, ground
