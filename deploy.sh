#!/bin/bash
# 서버에서 실행: ~/GRID/deploy.sh  (main 최신 코드로 웹·API·대시보드 갱신)
# 처음 한 번은 deploy/setup_server.sh 로 설정하세요.
set -e
cd ~/GRID
git pull --ff-only
.venv/bin/pip install -q -r backend/requirements.txt -r dashboard/requirements.txt
rsync -a --delete web/ /var/www/grid/
sudo systemctl restart grid-api grid-dashboard
echo "배포 완료"
