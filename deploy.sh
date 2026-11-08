#!/bin/bash
# 서버에서 실행: ./deploy.sh  (main 최신 코드로 웹·API·대시보드 갱신)
set -e
cd ~/GRID
git pull
.venv/bin/pip install -q -r backend/requirements.txt -r dashboard/requirements.txt
rsync -a --delete web/ /var/www/grid/
sudo systemctl restart grid-api
if systemctl list-unit-files | grep -q '^grid-dashboard'; then
  sudo systemctl restart grid-dashboard
fi
echo "배포 완료"
