"""시연용 더미 민원을 서버 API로 넣는다 (DB를 직접 건드리지 않음).

실행: python data/seed_complaints.py --api http://localhost:8000 --n 80
  ※ 서버를 POST_INTERVAL=0 으로 띄워야 빨리 들어갑니다.
     운영 서버에 넣을 때는 --delay 1.1 을 붙이세요 (같은 IP는 분당 60건까지).

시연용(추천): python data/seed_complaints.py --api http://서버 --n 60 --focus 5 --seed 7 --delay 1.1
  --focus N : 서버 /api/priority 의 열섬 상위 N개 구역 안에 핫스팟을 잡아서
              '뜨거운 곳에 시민 요구가 몰린다'는 흐름이 대시보드에 보이게 한다.
  --seed    : 같은 숫자면 매번 같은 데이터 (리허설과 본 시연을 똑같이)

발표 직전 실서버 초기화(기존 민원을 모두 지우고 새로 채움, 관리자 비밀번호는 환경변수로):
  python data/seed_complaints.py --api http://127.0.0.1:8000 --env-file ~/GRID/.env --reset --n 80 --focus 5 --seed 7 --delay 1.1 --handled 0.35
"""
import argparse
import json
import os
import random
import time
import urllib.error
import urllib.request

import voxelfmt as vf

TEXTS = {
    "tree": ["여름에 그늘이 하나도 없어요", "통학로에 가로수가 있으면 좋겠어요", "버스 기다릴 때 너무 뜨거워요",
             "아이 등굣길인데 햇볕을 피할 곳이 없습니다", "인도가 넓은데 나무가 한 그루도 없어요", "어르신들 걸어 다니기 힘들어하세요",
             "유모차 끌고 다니면 한낮엔 못 나와요", "가로수가 죽은 자리가 몇 년째 비어 있어요"],
    "pocketpark": ["빈 주차장을 작은 숲으로 바꿔 주세요", "아이들이 놀 그늘진 공원이 없어요", "공터에 나무를 심어 주세요",
                   "방치된 자투리땅에 쉼터를 만들어 주세요", "상가 뒤 공터가 여름엔 찜통이에요", "벤치랑 나무 몇 그루만 있어도 좋겠어요"],
    "shade": ["횡단보도 앞에 그늘막이 필요해요", "정류장에 햇빛 가림막 부탁드려요", "신호 기다리다 더위 먹을 것 같아요",
              "신호가 긴 교차로인데 그늘이 없어요", "학교 앞 횡단보도에 그늘막 설치해 주세요", "버스 정류장 의자가 뜨거워서 못 앉아요",
              "어르신들이 신호 기다리기 힘들어하세요"],
    "coolfog": ["상가 거리에 쿨링포그 있으면 좋겠어요", "한여름 놀이터가 너무 뜨거워요", "광장에 물안개 시설이 있으면 좋겠어요",
                "버스 터미널 앞 대기 공간이 너무 더워요"],
    "greenroof": ["아파트 상가 옥상에 정원을 만들어 주세요", "공공건물 옥상녹화 해 주세요", "옥상이 달궈져서 꼭대기 층이 너무 더워요",
                  "주민센터 옥상을 쉼터로 쓰면 좋겠어요"],
    "coolpave": ["보도블록이 너무 뜨거워요", "비 오면 물이 고이고 여름엔 달궈져요", "주차장 아스팔트 열기가 밤까지 남아요",
                 "놀이터 바닥이 뜨거워서 아이들이 못 놀아요"],
    "trash": ["쓰레기가 길에 많이 버려져요", "상가 앞 쓰레기통이 항상 넘쳐요", "분리수거장 주변이 지저분해요", "담배꽁초가 너무 많아요"],
    "odor": ["음식물 쓰레기 냄새가 심해요", "공사장 먼지가 심해요", "하수구 냄새가 여름마다 올라와요"],
    "noise": ["밤늦게 공사 소음이 있어요", "오토바이 소음이 심해요", "새벽 배달 차량 소리에 잠을 못 자요"],
    "other": ["불법 주차가 너무 많아요", "자전거 거치대가 필요해요", "가로등이 어두워요"],
}
REPLIES = {
    "working": ["현장 확인 후 설치 위치를 검토하고 있어요.", "담당 부서에서 현장 조사 일정을 잡았어요.", "내년도 사업 대상지로 검토 중이에요."],
    "done": ["현장 확인 후 조치를 마쳤어요. 제안 감사합니다.", "올해 그늘막 설치 대상에 반영했어요.", "담당 부서에서 정비를 끝냈어요."],
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
    ap.add_argument("--env-file", default="", help="ADMIN_PASSWORD 가 적힌 .env 파일 (서버: ~/GRID/.env)")
    ap.add_argument("--reset", action="store_true", help="넣기 전에 지금 있는 민원을 모두 지운다 (관리자 비밀번호 필요)")
    ap.add_argument("--handled", type=float, default=0, help="이 비율만큼 '처리중/처리 완료' + 답변을 붙인다 (예: 0.35, 관리자 비밀번호 필요)")
    a = ap.parse_args()
    if a.seed is not None:
        random.seed(a.seed)

    # 관리자 비밀번호는 명령줄에 쓰지 않는다 (명령 기록에 남으므로): 환경변수 ADMIN_PASSWORD 또는 --env-file
    pw = os.getenv("ADMIN_PASSWORD", "")
    if a.env_file:
        for line in open(os.path.expanduser(a.env_file), encoding="utf-8"):
            k, _, v = line.strip().partition("=")
            if k.strip() == "ADMIN_PASSWORD":
                pw = v.strip().strip("'\"")
    admin = {"Content-Type": "application/json", "X-Admin-Token": pw}
    if a.reset or a.handled:
        try:  # 지우기 전에 비밀번호부터 확인
            urllib.request.urlopen(urllib.request.Request(f"{a.api}/api/admin/login", headers=admin, method="POST",
                                                          data=json.dumps({"password": pw}).encode()))
        except urllib.error.HTTPError:
            raise SystemExit("관리자 비밀번호가 맞지 않아요. --env-file ~/GRID/.env 를 붙였는지 확인해 주세요. (아무것도 바꾸지 않았어요)")
    if a.reset:
        with urllib.request.urlopen(f"{a.api}/api/complaints?limit=2000") as r:
            old = json.load(r)
        for c in old:
            urllib.request.urlopen(urllib.request.Request(f"{a.api}/api/complaints/{c['id']}", headers=admin, method="DELETE"))
        print(f"기존 민원 {len(old)}건 삭제")

    doc, ground = vf.load()
    meta = doc["meta"]
    # 인도·도로·공원 칸 위주로, 몇몇 '핫스팟' 근처에 몰리게
    cand = [(x, z) for z in range(meta["depth"]) for x in range(meta["width"]) if ground[z, x] in (2, 3)]
    b = doc["buildings"]
    roofs = [(b[i], b[i + 1]) for i in range(0, len(b), 4)]
    hot = pick_hot(a, meta, cand) if a.focus else random.sample(cand, 4)
    types = list(WEIGHTS)
    skipped = 0
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
                                     headers={"Content-Type": "application/json", "X-Client-Id": f"seed-{random.random()}"},
                                     method="POST")  # 민원마다 다른 시민처럼
        try:
            cid = json.load(urllib.request.urlopen(req))["id"]
        except urllib.error.HTTPError as e:
            if e.code in (409, 429):  # 같은 칸·유형 중복, 너무 빠름 → 건너뜀
                skipped += 1
                continue
            raise
        if a.delay:
            time.sleep(a.delay)
        if random.random() < a.handled:
            st = random.choices(["working", "done"], weights=[3, 2])[0]
            urllib.request.urlopen(urllib.request.Request(
                f"{a.api}/api/complaints/{cid}", headers=admin, method="PATCH",
                data=json.dumps({"status": st, "reply": random.choice(REPLIES[st])}).encode()))
        for _ in range(random.choices([0, 1, 3, 8], weights=[5, 3, 2, 1])[0]):
            # 서버가 '한 사람 한 번' 공감만 받으므로 공감마다 다른 사람(X-Client-Id)인 척 보낸다
            urllib.request.urlopen(urllib.request.Request(f"{a.api}/api/complaints/{cid}/like", method="POST",
                                   headers={"X-Client-Id": f"seed-{random.random()}"}))
    print(f"{a.n - skipped}건 등록 완료" + (f" (중복 {skipped}건 건너뜀)" if skipped else ""))


if __name__ == "__main__":
    main()
