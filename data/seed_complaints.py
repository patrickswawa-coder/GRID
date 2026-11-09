"""시연용 더미 민원을 서버 API로 넣는다 (DB를 직접 건드리지 않음).

실행: python data/seed_complaints.py --api http://localhost:8000 --n 80
  ※ 서버를 POST_INTERVAL=0 으로 띄워야 빨리 들어갑니다.
     운영 서버(POST_INTERVAL=3)에 넣을 때는 --delay 3.2 를 붙이세요.

시연용(추천): python data/seed_complaints.py --api http://서버 --n 60 --focus 5 --seed 7
  --focus N : 서버 /api/priority 의 열섬 상위 N개 구역 안에 핫스팟을 잡아서
              '뜨거운 곳에 시민 요구가 몰린다'는 흐름이 대시보드에 보이게 한다.
  --seed    : 같은 숫자면 매번 같은 데이터 (리허설과 본 시연을 똑같이)
"""
import argparse
import json
import random
import time
import urllib.request

import voxelfmt as vf

TEXTS = {
    "tree": ["여름에 그늘이 하나도 없어요", "통학로에 가로수가 있으면 좋겠어요", "버스 기다릴 때 너무 뜨거워요"],
    "pocketpark": ["빈 주차장을 작은 숲으로 바꿔 주세요", "아이들이 놀 그늘진 공원이 없어요", "공터에 나무를 심어 주세요"],
    "shade": ["횡단보도 앞에 그늘막이 필요해요", "정류장에 햇빛 가림막 부탁드려요", "신호 기다리다 더위 먹을 것 같아요"],
    "coolfog": ["상가 거리에 쿨링포그 있으면 좋겠어요", "한여름 놀이터가 너무 뜨거워요"],
    "greenroof": ["아파트 상가 옥상에 정원을 만들어 주세요", "공공건물 옥상녹화 해 주세요"],
    "coolpave": ["보도블록이 너무 뜨거워요", "비 오면 물이 고이고 여름엔 달궈져요"],
    "trash": ["쓰레기가 길에 많이 버려져요", "상가 앞 쓰레기통이 항상 넘쳐요"],
    "odor": ["음식물 쓰레기 냄새가 심해요", "공사장 먼지가 심해요"],
    "noise": ["밤늦게 공사 소음이 있어요", "오토바이 소음이 심해요"],
    "other": ["불법 주차가 너무 많아요", "자전거 거치대가 필요해요"],
}
WEIGHTS = {"tree": 6, "shade": 5, "pocketpark": 3, "coolfog": 2, "greenroof": 2, "coolpave": 2,
           "trash": 3, "odor": 2, "noise": 2, "other": 1}


def pick_hot(a, meta, cand):
    """열섬 상위 구역(서버 /api/priority, 아직 민원이 없으면 열섬 순) 안의 인도·공원 칸을 핫스팟으로."""
    s = meta.get("zone_size", 40)
    with urllib.request.urlopen(f"{a.api}/api/priority?limit={a.focus}") as r:
        zones = [z["zone"] for z in json.load(r)]
    hot = []
    for zone in zones:
        zx, zz = ord(zone[0]) - 65, int(zone[1:]) - 1
        inside = [(x, z) for x, z in cand if x // s == zx and z // s == zz]
        if inside:
            hot.append(random.choice(inside))
    print("핫스팟 구역:", ", ".join(zones))
    return hot or random.sample(cand, 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--n", type=int, default=80)
    ap.add_argument("--focus", type=int, default=0, help="열섬 상위 N개 구역에 핫스팟 (0이면 무작위)")
    ap.add_argument("--delay", type=float, default=0, help="등록 사이 대기(초). 서버 도배 방지 간격보다 길게")
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    if a.seed is not None:
        random.seed(a.seed)

    doc, ground = vf.load()
    meta = doc["meta"]
    # 인도·도로·공원 칸 위주로, 몇몇 '핫스팟' 근처에 몰리게
    cand = [(x, z) for z in range(meta["depth"]) for x in range(meta["width"]) if ground[z, x] in (2, 3)]
    b = doc["buildings"]
    roofs = [(b[i], b[i + 1]) for i in range(0, len(b), 4)]
    hot = pick_hot(a, meta, cand) if a.focus else random.sample(cand, 4)
    types = list(WEIGHTS)
    for i in range(a.n):
        if random.random() < 0.6:
            hx, hz = random.choice(hot)
            near = [(x, z) for x, z in random.sample(cand, 400) if abs(x - hx) < 25 and abs(z - hz) < 25]
            x, z = random.choice(near) if near else random.choice(cand)
        else:
            x, z = random.choice(cand)
        t = random.choices(types, weights=[WEIGHTS[k] for k in types])[0]
        if t == "greenroof":
            x, z = random.choice(roofs)
        lat, lng = vf.cell_to_latlng(meta, x, z)
        body = {"x": x, "z": z, "lat": lat, "lng": lng, "zone": vf.zone_of(meta, x, z),
                "type": t, "text": random.choice(TEXTS[t])}
        req = urllib.request.Request(f"{a.api}/api/complaints", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        cid = json.load(urllib.request.urlopen(req))["id"]
        if a.delay:
            time.sleep(a.delay)
        for _ in range(random.choices([0, 1, 3, 8], weights=[5, 3, 2, 1])[0]):
            urllib.request.urlopen(urllib.request.Request(f"{a.api}/api/complaints/{cid}/like", method="POST"))
    print(f"{a.n}건 등록 완료")


if __name__ == "__main__":
    main()
