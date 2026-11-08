# 서버 배포 (7조 서버)

| 항목 | 값 |
|---|---|
| 주소 | `32.190.9.9` (Ubuntu 24.04, 사용자 `ubuntu`) |
| 접속 키 | `hackathon-e5-t07.pem` — 운영진이 준 7조 폴더에 있음. **GitHub·단톡방에 올리지 말 것** |
| 시민 페이지 | http://32.190.9.9/ |
| 대시보드 | http://32.190.9.9:8501/ |
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
sudo systemctl status grid-api grid-dashboard --no-pager   # 상태
sudo journalctl -u grid-api -n 50                          # API 로그
curl -s localhost/api/ai/summary                           # AI 요약 동작 확인
```

## 시연 전 데이터 초기화 + 더미 민원
```bash
sudo systemctl stop grid-api
cp ~/GRID/backend/grid.db ~/grid-backup-$(date +%m%d%H%M).db 2>/dev/null; rm -f ~/GRID/backend/grid.db*
sudo systemctl start grid-api
cd ~/GRID/data && ../.venv/bin/pip install -q numpy && ../.venv/bin/python seed_complaints.py --api http://127.0.0.1:8000 --n 80
```
(더미 민원은 도배 방지 때문에 3초에 1건씩 들어가서 80건이면 약 4분)
