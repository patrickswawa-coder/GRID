#!/bin/bash
# 서버에서 실행: ~/GRID/deploy.sh  (main 최신 코드로 웹·API·대시보드 갱신)
# 처음 한 번은 deploy/setup_server.sh 로 설정하세요.
set -e
cd ~/GRID
git pull --ff-only
.venv/bin/pip install -q -r backend/requirements.txt
rsync -a --delete --exclude .well-known web/ /var/www/grid/   # .well-known: HTTPS 인증서 갱신용(root 소유) 폴더는 건드리지 않음
sudo systemctl restart grid-api

# 브라우저가 예전 파일(css/js)을 계속 쓰지 않게: 매번 서버에 "바뀌었나?" 확인하라고 알림
# (안 바뀐 파일은 304 로 바로 끝나서 느려지지 않음). 처음 한 번만 설치되고 이후엔 그대로.
CACHE_CONF=/etc/nginx/conf.d/grid-cache.conf
if [ ! -f "$CACHE_CONF" ]; then
  echo 'add_header Cache-Control "no-cache" always;  # GRID: 배포 후 새 화면이 바로 보이게 (deploy.sh)' | sudo tee "$CACHE_CONF" >/dev/null
  if sudo nginx -t -q 2>/dev/null; then
    sudo systemctl reload nginx
    echo "   nginx: 브라우저 캐시 설정 추가"
  else
    sudo rm -f "$CACHE_CONF"
    echo "   nginx: 캐시 설정을 넣지 못해 되돌렸어요 (배포는 정상)"
  fi
fi
echo "배포 완료"
