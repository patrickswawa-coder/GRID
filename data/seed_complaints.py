"""시연용 더미 민원을 서버 API로 넣는다 (DB를 직접 건드리지 않음).

실행: python data/seed_complaints.py --api http://localhost:8000 --n 80
  ※ 서버를 POST_INTERVAL=0 으로 띄워야 빨리 들어갑니다.
"""
import argparse
import json
import random
import urllib.request

import voxelfmt as vf

TEXTS = {
    "streetlight": ["밤에 골목이 너무 어두워요", "가로등이 고장 나서 깜빡여요", "학원 끝나고 오는 길이 무서워요",
                    "공원 산책로에 가로등이 없어요"],
    "bench": ["버스 기다릴 때 앉을 곳이 없어요", "어르신들 쉬어갈 벤치가 필요해요", "공원에 그늘 벤치 있으면 좋겠어요"],
    "trash": ["쓰레기가 길에 많이 버려져요", "상가 앞 쓰레기통이 항상 넘쳐요", "분리수거함이 필요해요"],
    "tree": ["여름에 그늘이 하나도 없어요", "가로수가 말라 죽었어요", "삭막해서 나무를 더 심었으면"],
    "walkway": ["인도가 좁아서 유모차가 못 다녀요", "보도블록이 깨져서 넘어질 뻔했어요", "횡단보도까지 너무 멀어요",
                "비 오면 물이 고여요"],
    "other": ["불법 주차가 너무 많아요", "자전거 거치대가 필요해요", "CCTV 설치 부탁드려요"],
}
WEIGHTS = {"streetlight": 5, "walkway": 4, "trash": 3, "bench": 3, "tree": 2, "other": 1}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--n", type=int, default=80)
    a = ap.parse_args()

    doc, ground = vf.load()
    meta = doc["meta"]
    # 인도·도로·공원 칸 위주로, 몇몇 '핫스팟' 근처에 몰리게
    cand = [(x, z) for z in range(meta["depth"]) for x in range(meta["width"]) if ground[z, x] in (2, 3)]
    hot = random.sample(cand, 4)
    types = list(WEIGHTS)
    for i in range(a.n):
        if random.random() < 0.6:
            hx, hz = random.choice(hot)
            near = [(x, z) for x, z in random.sample(cand, 400) if abs(x - hx) < 25 and abs(z - hz) < 25]
            x, z = random.choice(near) if near else random.choice(cand)
        else:
            x, z = random.choice(cand)
        t = random.choices(types, weights=[WEIGHTS[k] for k in types])[0]
        lat, lng = vf.cell_to_latlng(meta, x, z)
        body = {"x": x, "z": z, "lat": lat, "lng": lng, "zone": vf.zone_of(meta, x, z),
                "type": t, "text": random.choice(TEXTS[t])}
        req = urllib.request.Request(f"{a.api}/api/complaints", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        cid = json.load(urllib.request.urlopen(req))["id"]
        for _ in range(random.choices([0, 1, 3, 8], weights=[5, 3, 2, 1])[0]):
            urllib.request.urlopen(urllib.request.Request(f"{a.api}/api/complaints/{cid}/like", method="POST"))
    print(f"{a.n}건 등록 완료")


if __name__ == "__main__":
    main()
