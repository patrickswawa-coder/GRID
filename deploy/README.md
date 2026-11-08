# 서버 배포 메모

서버에는 이미 `~/GRID`, `.venv`, nginx(`/var/www/grid`), systemd `grid-api` 가 있다고 가정합니다
(기존 `deploy.sh` 기준). 아래 파일은 **예시**이니 서버의 실제 설정과 비교해서 필요한 부분만 반영하세요.

## 1. API (grid-api)
- 이미 돌고 있으면 그대로 두고 `Environment=` 줄만 확인 (`GRID_DB`, `MODEL_ID`, `AI_ENABLED`)
- 새로 만들 때: `sudo cp deploy/grid-api.service /etc/systemd/system/` → `sudo systemctl daemon-reload && sudo systemctl enable --now grid-api`
- **사용자 이름(`ubuntu`)과 경로를 서버에 맞게 수정**

## 2. 대시보드 (grid-dashboard)
```bash
sudo cp deploy/grid-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now grid-dashboard
```

## 3. nginx
`deploy/nginx-grid.conf` 의 `location` 블록들을 기존 server 블록에 합치기 → `sudo nginx -t && sudo systemctl reload nginx`
- `/` → `/var/www/grid` (시민 페이지)
- `/api/` → `127.0.0.1:8000`
- `/dashboard/` → `127.0.0.1:8501` (웹소켓 필요)

## 4. 확인
```bash
curl localhost:8000/api/health
curl -I http://서버주소/dashboard/
```
폰에서 `http://서버주소/` 접속 → 민원 등록 → `http://서버주소/dashboard/` 반영 확인.

## 시연 전 데이터 초기화
```bash
sudo systemctl stop grid-api
cp ~/GRID/backend/grid.db ~/grid-backup-$(date +%m%d%H%M).db && rm ~/GRID/backend/grid.db
sudo systemctl start grid-api
# 더미 데이터 (서버를 POST_INTERVAL=0 으로 띄웠을 때만 빠름)
cd ~/GRID/data && ../.venv/bin/python seed_complaints.py --api http://127.0.0.1:8000 --n 80
```
