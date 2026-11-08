"""실제 V-World 데이터가 준비되기 전까지 쓰는 '무실동 느낌' 임시 맵 생성기.

실행: python data/make_sample_map.py
→ web/data/voxels.json 생성 (실제 데이터는 build_voxels.py 로 덮어쓴다)
"""
import numpy as np

import voxelfmt as vf

W = D = 200          # 200칸 x 5m = 1km
CELL = 5
# 무실동 일대(원주시청 부근) 북서쪽 모서리 근사값
ORIGIN_LAT, ORIGIN_LNG = 37.3440, 127.9150

rng = np.random.default_rng(7)
ground = np.full((D, W), vf.GRASS, np.uint8)
heights = np.zeros((D, W), np.int32)
kinds = np.zeros((D, W), np.int32)

# 도로망: 큰길(폭 4칸) + 작은길(폭 2칸), 양옆 인도 1칸
big = [30, 100, 170]
small = [65, 135]
for p in big:
    ground[:, p - 3:p + 3] = vf.SIDEWALK
    ground[p - 3:p + 3, :] = vf.SIDEWALK
for p in small:
    ground[:, p - 2:p + 2] = vf.SIDEWALK
    ground[p - 2:p + 2, :] = vf.SIDEWALK
for p in big:
    ground[:, p - 2:p + 2] = vf.ROAD
    ground[p - 2:p + 2, :] = vf.ROAD
for p in small:
    ground[:, p - 1:p + 1] = vf.ROAD
    ground[p - 1:p + 1, :] = vf.ROAD

# 하천 (서쪽 가장자리, 원주천 느낌) + 둔치 녹지
for z in range(D):
    c = int(8 + 3 * np.sin(z / 18))
    ground[z, max(0, c - 7):c + 7] = vf.PARK
    ground[z, max(0, c - 4):c + 4] = vf.WATER

# 공원 두 곳
ground[105:132, 105:132] = vf.PARK
ground[38:60, 140:165] = vf.PARK
ground[115:122, 105:132] = vf.SIDEWALK  # 공원 산책로

free = ground == vf.GRASS
free[:, :20] = False


def place(x0, z0, w, d, h, kind):
    if x0 < 0 or z0 < 0 or x0 + w > W or z0 + d > D:
        return
    if not free[z0:z0 + d, x0:x0 + w].all():
        return
    heights[z0:z0 + d, x0:x0 + w] = h
    kinds[z0:z0 + d, x0:x0 + w] = kind
    free[max(0, z0 - 1):z0 + d + 1, max(0, x0 - 1):x0 + w + 1] = False


# 북쪽 절반: 아파트 단지 (고층 판상형)
for z0 in range(36, 96, 14):
    for x0 in range(36, 196, 10):
        if rng.random() < 0.75:
            place(x0, z0, 7, 3, int(rng.integers(10, 18)), vf.APT)

# 큰길가: 상가
for p in big:
    for t in range(0, D, 6):
        if rng.random() < 0.55:
            place(p + 4, t, 4, 4, int(rng.integers(2, 6)), vf.COMMERCIAL)
            place(t, p + 4, 4, 4, int(rng.integers(2, 6)), vf.COMMERCIAL)

# 공공건물 (시청 느낌)
place(140, 104, 14, 10, 8, vf.PUBLIC)
place(72, 140, 12, 8, 4, vf.PUBLIC)

# 남쪽: 단독주택
for _ in range(2500):
    x0, z0 = int(rng.integers(20, 196)), int(rng.integers(100, 196))
    place(x0, z0, int(rng.integers(2, 4)), int(rng.integers(2, 4)), int(rng.integers(1, 3)), vf.HOUSE)

vf.save(vf.OUT, name="원주시 무실동 (임시 샘플 맵)", cell=CELL, origin_lat=ORIGIN_LAT, origin_lng=ORIGIN_LNG,
        ground=ground, heights=heights, kinds=kinds, source="sample")
