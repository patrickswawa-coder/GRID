#!/bin/bash
# 7조 서버(Ubuntu 24.04, 32.190.9.9) 설정 + 배포를 한 번에. 여러 번 실행해도 안전합니다.
# 서버에 접속한 뒤:
#   curl -fsSL https://raw.githubusercontent.com/patrickswawa-coder/GRID/main/deploy/setup_server.sh | bash
set -e
REPO=https://github.com/patrickswawa-coder/GRID.git
DIR=$HOME/GRID
MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0
ME=$(whoami)

echo "▶ 1/6 필요한 프로그램 설치"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3-venv nginx rsync curl >/dev/null

echo "▶ 2/6 코드 받기"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || { echo "✗ 서버의 코드에 직접 고친 부분이 있어 업데이트를 멈췄어요. 'cd ~/GRID && git status' 로 확인하세요."; exit 1; }
else
  git clone -q "$REPO" "$DIR"
fi
cd "$DIR"

echo "▶ 3/6 Python 패키지 설치 (1~3분)"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r backend/requirements.txt

# .env (키·비밀번호). 없으면 만들고, 관리자 비밀번호가 없으면 무작위로 넣는다. git 에는 올라가지 않는 파일.
touch .env
grep -q '^ADMIN_PASSWORD=' .env || echo "ADMIN_PASSWORD=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
grep -q '^NAVER_MAP_KEY=' .env || echo "NAVER_MAP_KEY=" >> .env
chmod 600 .env

echo "▶ 4/6 시민 페이지 복사"
sudo mkdir -p /var/www/grid
sudo chown "$ME" /var/www/grid
rsync -a --delete --exclude .well-known web/ /var/www/grid/

echo "▶ 5/6 서비스 등록 (API :8000)"
sudo tee /etc/systemd/system/grid-api.service >/dev/null <<EOF
[Unit]
Description=GRID API (FastAPI)
After=network.target

[Service]
User=$ME
WorkingDirectory=$DIR/backend
Environment=GRID_DB=$DIR/backend/grid.db
Environment=AI_ENABLED=1
Environment=POST_INTERVAL=0.5
Environment=MODEL_ID=$MODEL_ID
ExecStart=$DIR/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
# 예전 Streamlit 대시보드 서비스가 남아 있으면 정리 (이제 /admin/ 으로 통합)
sudo systemctl disable --now grid-dashboard 2>/dev/null || true
sudo rm -f /etc/systemd/system/grid-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable -q grid-api
sudo systemctl restart grid-api

echo "▶ 6/6 nginx (80번 포트 하나: 시민 페이지 + /admin/ + /api)"
if grep -q ssl_certificate /etc/nginx/sites-available/grid 2>/dev/null && [ -z "$FORCE_HTTP" ]; then
  echo "   HTTPS 설정(enable_https.sh)이 있어 nginx 는 그대로 둡니다. (http 로 되돌리려면 FORCE_HTTP=1)"
else
sudo tee /etc/nginx/sites-available/grid >/dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    root /var/www/grid;
    index index.html;
    client_max_body_size 2m;

    gzip on;
    gzip_types application/json application/javascript text/css;

    location / {
        try_files $uri $uri/ =404;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/grid /etc/nginx/sites-enabled/grid
sudo rm -f /etc/nginx/sites-enabled/default
fi
sudo nginx -t -q
sudo systemctl reload nginx || sudo systemctl restart nginx

sleep 3
IP=$(curl -s -m 3 https://checkip.amazonaws.com || echo "32.190.9.9")
echo
if curl -fs localhost/api/health >/dev/null; then
  echo "✅ 완료!"
  echo "   시민 페이지 : http://$IP/"
  echo "   대시보드    : http://$IP/admin/"
  echo "   AI 확인     : curl -s localhost/api/ai/summary"
  echo "   관리자 비밀번호 : $(grep '^ADMIN_PASSWORD=' "$DIR/.env" | cut -d= -f2)   (바꾸려면 nano ~/GRID/.env 후 sudo systemctl restart grid-api)"
  grep -q '^NAVER_MAP_KEY=.' "$DIR/.env" || echo "   ※ 네이버 지도: ~/GRID/.env 의 NAVER_MAP_KEY= 뒤에 Client ID 를 넣고 sudo systemctl restart grid-api"
else
  echo "✗ API가 아직 안 떠요. 'sudo journalctl -u grid-api -n 30' 결과를 보내주세요."
fi
