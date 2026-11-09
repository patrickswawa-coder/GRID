#!/bin/bash
# 서버에서 실행: ~/GRID/deploy.sh  (main 최신 코드로 웹·API·대시보드 갱신)
# 처음 한 번은 deploy/setup_server.sh 로 설정하세요.
set -e
cd ~/GRID
git pull --ff-only
.venv/bin/pip install -q -r backend/requirements.txt
rsync -a --delete --exclude .well-known web/ /var/www/grid/   # .well-known: HTTPS 인증서 갱신용(root 소유) 폴더는 건드리지 않음
sudo systemctl restart grid-api
echo "배포 완료"
