"""큰 건물·아파트 단지·학교·공공기관 이름표 → web/data/labels.json

실행 (build_voxels.py 다음에):
  python data/build_labels.py --buildings data/raw/muksil_buildings.gpkg

자동으로 못 잡는 장소(예: 롯데시네마)는 data/landmarks_custom.csv 에 한 줄씩 추가:
  name,lat,lng,kind        ← kind: apt / school / public / shop / transit / park
"""
import argparse
import csv
import json
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from pyproj import Transformer

import voxelfmt as vf
from build_voxels import DEFAULT_BBOX, METRIC, add_missing_buildings, read

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "web" / "data" / "labels.json"
CUSTOM = HERE / "landmarks_custom.csv"
PARKS = HERE / "raw" / "parks.csv"  # 공공데이터포털 '전국도시공원정보표준데이터' CSV

GENERIC = {"초등학교", "중학교", "고등학교", "중.고등학교", "1", "상가동", "관리동"}
PUBLIC_KW = ("시청", "청사", "우편", "테마파크", "도서관", "공단", "등록사업소", "지청", "소방", "경찰", "주민센터", "행정복지")
TRANSIT_KW = ("터미널",)
SKIP_KW = ("사택", "컴퓨터실", "기계실", "창고", "경비실", "다목적")
RENAME = {
    "원주시외버스터미널 더블유시티": "시외버스터미널",
    "원주고속버스터미널": "고속버스터미널",
    "한국국토정보공사 강원지역본부 원주지사": "국토정보공사",
    "중앙근린공원(2구역)": "중앙근린공원",
}


def clean(name: str) -> str:
    name = re.sub(r"\s*(제?\d+동|[가-하A-Z]동|주건축물.*|부속.*)$", "", name.strip())
    name = re.sub(r"^원주시\s+", "", name)
    name = re.sub(r"\s*아파트$", "", name) if " " in name else name  # '무실 세영리첼 1차 아파트' → '무실 세영리첼 1차'
    name = re.sub(r"^원주(?=무실)", "", name)  # '원주무실1단지아파트' → '무실1단지아파트'
    name = name.strip()
    return RENAME.get(name, name)


def classify(name, use):
    if any(k in name for k in TRANSIT_KW) or re.search(r"역$", name):
        return "transit"
    if "학교" in name:
        return "school"
    if any(k in name for k in PUBLIC_KW) or "공원" in name:
        return "public"
    if use == "공동주택":
        return "apt"
    return "shop"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buildings", required=True)
    ap.add_argument("--extra-buildings", help="도로명주소 건물(TL_SPBD_BULD)")
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX)
    ap.add_argument("--cell", type=float, default=5.0)
    ap.add_argument("--shops", type=int, default=12, help="큰 상가 몇 개까지 표시할지")
    a = ap.parse_args()

    w, s, e, n = a.bbox
    tf = Transformer.from_crs("EPSG:4326", METRIC, always_xy=True)
    (mx0, my0), (mx1, my1) = tf.transform(w, s), tf.transform(e, n)
    g = read(a.buildings, (mx0, my0, mx1, my1))
    if a.extra_buildings:
        g = add_missing_buildings(g, a.extra_buildings, (mx0, my0, mx1, my1))
    g = g[g["A24"].notna()].copy()
    g["name"] = g["A24"].astype(str).map(clean)
    g = g[~g["name"].isin(GENERIC) & (g["name"].str.len() >= 2) & ~g["name"].str.match(r"^[\d\-\s]+$|^무실동 \d")]
    g = g[~g["name"].apply(lambda n: any(k in n for k in SKIP_KW) or "," in n)]
    g["area"] = g.area

    doc, _ = vf.load()
    meta = doc["meta"]
    W, D = meta["width"], meta["depth"]
    heights = np.zeros((D, W), int)
    b = doc["buildings"]
    for i in range(0, len(b), 4):
        heights[b[i + 1], b[i]] = b[i + 2]

    labels = []
    for name, grp in g.groupby("name"):
        use = grp["A9"].mode().iloc[0] if grp["A9"].notna().any() else ""
        kind = classify(name, use)
        area = grp["area"].sum()
        if kind == "apt" and len(grp) < 3 and area < 2500:
            continue
        if kind == "shop" and area < 900:
            continue
        geom = shapely.union_all(grp.geometry.to_numpy())
        pt = geom.representative_point() if kind != "apt" else geom.centroid
        x, z = int((pt.x - mx0) / a.cell), int((my1 - pt.y) / a.cell)
        if not (0 <= x < W and 0 <= z < D):
            continue
        h = int(heights[max(0, z - 4):z + 5, max(0, x - 4):x + 5].max())
        labels.append({"name": name, "kind": kind, "x": x, "z": z, "h": h, "area": round(area)})

    shops = sorted([l for l in labels if l["kind"] == "shop"], key=lambda l: -l["area"])[: a.shops]
    labels = [l for l in labels if l["kind"] != "shop"] + shops

    # 공원 이름 (전국도시공원정보표준데이터: 공원명·위도·경도·공원면적)
    if PARKS.exists():
        import pandas as pd
        for enc in ("cp949", "utf-8-sig"):
            try:
                pk = pd.read_csv(PARKS, encoding=enc)
                break
            except UnicodeDecodeError:
                continue
        pk = pk.rename(columns=lambda c: c.strip())
        lat = pd.to_numeric(pk["위도"], errors="coerce"); lng = pd.to_numeric(pk["경도"], errors="coerce")
        area = pd.to_numeric(pk.get("공원면적"), errors="coerce").fillna(0)
        inside = (lat.between(s, n)) & (lng.between(w, e))
        added = 0
        for _, r in pk[inside].assign(_a=area[inside]).sort_values("_a", ascending=False).iterrows():
            px, py = tf.transform(float(r["경도"]), float(r["위도"]))
            x, z = int((px - mx0) / a.cell), int((my1 - py) / a.cell)
            if 0 <= x < W and 0 <= z < D and not any(l["name"] == r["공원명"] for l in labels):
                labels.append({"name": str(r["공원명"]).strip(), "kind": "park", "x": x, "z": z, "h": 0,
                               "area": float(r["_a"])})
                added += 1
        print(f"공원 이름 {added}개 추가 (parks.csv)")

    if CUSTOM.exists():
        with CUSTOM.open(encoding="utf-8-sig") as f:
            for row in csv.DictReader(r for r in f if not r.startswith("#")):
                px, py = tf.transform(float(row["lng"]), float(row["lat"]))
                x, z = int((px - mx0) / a.cell), int((my1 - py) / a.cell)
                if 0 <= x < W and 0 <= z < D:
                    h = int(heights[max(0, z - 2):z + 3, max(0, x - 2):x + 3].max())
                    labels.append({"name": row["name"].strip(), "kind": (row.get("kind") or "shop").strip(),
                                   "x": x, "z": z, "h": h, "area": 10**6})  # 직접 넣은 건 우선 표시

    order = {"public": 0, "transit": 0, "school": 1, "park": 2, "apt": 2, "shop": 3}
    labels.sort(key=lambda l: (order.get(l["kind"], 4), -l["area"]))
    for i, l in enumerate(labels):
        l["rank"] = i
        del l["area"]
    OUT.write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"이름표 {len(labels)}개 → {OUT}")
    for l in labels:
        print(f"  [{l['kind']:7}] {l['name']}")


if __name__ == "__main__":
    main()
