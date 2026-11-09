"""QR 코드 생성.

1) 주소 하나:      python data/make_qr.py http://서버주소/            → data/qr.png
2) 거리 QR 포스터: python data/make_qr.py http://서버주소/ --spots data/qr_spots.csv
   → data/qr/<장소>.png  (장소마다 QR + 안내 문구. 찍으면 시민 화면이 그 자리로 바로 이동)

qr_spots.csv: name,lat,lng  (위도·경도는 네이버/카카오 지도에서 장소 우클릭 → 좌표 복사)
QR 주소 형식: <서버>/?at=위도,경도&name=장소이름   (web/js/app.js '거리 QR 위치 모드')
"""
import argparse
import csv
import re
import sys
from pathlib import Path
from urllib.parse import quote

import qrcode
from PIL import Image, ImageDraw, ImageFont

FONTS = [  # 한글 글꼴 (있는 것 하나)
    "C:/Windows/Fonts/malgunbd.ttf", "C:/Windows/Fonts/malgun.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
]


def font(size):
    for f in FONTS:
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return None


def spot_url(base, name, lat, lng):
    return f"{base.rstrip('/')}/?at={float(lat):.6f},{float(lng):.6f}&name={quote(name)}"


def poster(url, name, out):
    q = qrcode.make(url, box_size=14, border=2).convert("RGB")
    W, pad = 760, 40
    q = q.resize((W - pad * 2, W - pad * 2), Image.NEAREST)
    img = Image.new("RGB", (W, W + 330), "white")
    d = ImageDraw.Draw(img)
    f1, f2, f3 = font(46), font(34), font(26)
    if f1:
        d.rectangle([0, 0, W, 150], fill="#e8590c")
        d.text((W // 2, 52), "이 거리, 여름에 얼마나 뜨거울까요?", font=f2, fill="white", anchor="mm")
        d.text((W // 2, 108), "QR을 찍고 3D 지도에서 확인해 보세요", font=f3, fill="white", anchor="mm")
        img.paste(q, (pad, 170))
        d.text((W // 2, W + 190), name, font=f1, fill="#212529", anchor="mm")
        d.text((W // 2, W + 250), "그늘막·가로수가 필요하면 이곳에 의견을 남겨 주세요", font=f3, fill="#495057", anchor="mm")
        d.text((W // 2, W + 295), "GRID · 원주시 무실동 열섬 지도", font=f3, fill="#868e96", anchor="mm")
    else:  # 한글 글꼴이 없으면 QR만
        img = q
        print("  (한글 글꼴을 못 찾아 문구 없이 QR만 저장)")
    img.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://localhost:8000/")
    ap.add_argument("--spots", help="name,lat,lng CSV → 장소별 포스터")
    a = ap.parse_args()
    if not a.spots:
        qrcode.make(a.url, box_size=12, border=2).save("data/qr.png")
        print(f"data/qr.png ← {a.url}")
        return
    outdir = Path("data/qr")
    outdir.mkdir(exist_ok=True)
    with open(a.spots, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            url = spot_url(a.url, row["name"], row["lat"], row["lng"])
            out = outdir / (re.sub(r"[^\w가-힣]+", "_", row["name"]).strip("_") + ".png")
            poster(url, row["name"], out)
            print(f"{out} ← {url}")


if __name__ == "__main__":
    sys.exit(main())
