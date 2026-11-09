# 서버 배포 (7조 서버)

| 항목 | 값 |
|---|---|
| 주소 | `32.190.9.9` (Ubuntu 24.04, 사용자 `ubuntu`) |
| 접속 키 | `hackathon-e5-t07.pem` — 운영진이 준 7조 폴더에 있음. **GitHub·단톡방에 올리지 말 것** |
| 시민 페이지 | http://32.190.9.9/ |
| 대시보드 | http://32.190.9.9/admin/ |
| AI | Bedrock, 키 없이 서버 권한으로 호출. 기본 모델 Claude Haiku 4.5 |

행사가 끝나면 서버가 삭제됩니다. 코드는 GitHub에 있으니 괜찮지만 **민원 DB(`~/GRID/backend/grid.db`)는 필요하면 미리 받아두기.**

## 1. 내 PC에서 접속 준비 (Windows PowerShell, 처음 한 번)
```powershell
Copy-Item $HOME\Desktop\7조\hackathon-e5-t07.pem $HOME
icacls $HOME\hackathon-e5-t07.pem /inheritance:r /grant:r "${env:USERNAME}:R"
```

## 2. 서버 접속
```powershell
ssh -i $HOME\hackathon-e5-t07.pem ubuntu@32.190.9.9
```
처음엔 `yes` 입력.

## 3. 처음 설정 + 배포 (서버 안에서, 한 줄)
```bash
curl -fsSL https://raw.githubusercontent.com/patrickswawa-coder/GRID/main/deploy/setup_server.sh | bash
```
코드 받기 → 패키지 설치 → 시민 페이지 복사 → API·대시보드 서비스 등록 → nginx 설정까지 자동. 여러 번 실행해도 안전.

## 4. 이후 업데이트 (main에 merge한 뒤)
```bash
~/GRID/deploy.sh
```

## 자주 쓰는 명령 (서버 안에서)
```bash
sudo systemctl status grid-api --no-pager   # 상태
sudo journalctl -u grid-api -n 50                          # API 로그
curl -s localhost/api/ai/summary                           # AI 요약 동작 확인
```

## 시연 전 데이터 초기화 + 더미 민원
```bash
sudo systemctl stop grid-api
cp ~/GRID/backend/grid.db ~/grid-backup-$(date +%m%d%H%M).db 2>/dev/null; rm -f ~/GRID/backend/grid.db*
sudo systemctl start grid-api
cd ~/GRID/data && ../.venv/bin/pip install -q numpy && ../.venv/bin/python seed_complaints.py --api http://127.0.0.1:8000 --n 60 --focus 5 --seed 7 --delay 1.1
```
(같은 IP는 분당 60건까지라 1.1초에 1건씩, 60건이면 약 1분. `--focus 5`는 열섬 상위 구역에 몰리게, `--seed 7`은 매번 같은 데이터)


## HTTPS 켜기 (휴대폰 "내 위치" 버튼, 주소창 경고 없애기)
443 포트는 운영진 확인 결과 열려 있음.

1. **도메인 만들기 (무료, 5분):** https://www.duckdns.org 에 구글/깃허브로 로그인 → `sub domain` 에 이름(예: `grid7`) 입력 → **add domain** → `current ip` 가 `32.190.9.9` 인지 확인 (아니면 고치고 **update ip**)
2. **서버에서 한 줄:**
   ```bash
   cd ~/GRID && git pull --ff-only && bash deploy/enable_https.sh grid7.duckdns.org
   ```
   인증서 발급(자동 갱신) → nginx 를 443으로 → `http://32.190.9.9`·`http://도메인` 은 자동으로 `https://도메인` 으로 이동 (이미 뽑은 QR도 동작)
3. **QR 포스터 다시 만들기:** `python data/make_qr.py https://grid7.duckdns.org/ --spots data/qr_spots.csv`
4. 네이버 지도를 쓰면: 네이버 클라우드 콘솔 → Maps → 애플리케이션 → **Web 서비스 URL** 에 `https://grid7.duckdns.org` 추가 (안 하면 관리자 화면 지도가 인증 오류)

- 이후 업데이트는 그대로 `~/GRID/deploy.sh`. `setup_server.sh` 를 다시 돌려도 HTTPS 설정은 유지됨 (http 로 되돌리려면 `FORCE_HTTP=1`)
- HTTPS 에서만 시민 화면에 **📍 내 위치** 버튼이 보임 (브라우저가 http 에서는 위치를 막음)
