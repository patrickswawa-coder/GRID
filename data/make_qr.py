"""시연용 QR 코드 생성.  실행: python data/make_qr.py https://서버주소/ → data/qr.png"""
import sys

import qrcode

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000/"
img = qrcode.make(url, box_size=12, border=2)
img.save("data/qr.png")
print(f"data/qr.png ← {url}")
