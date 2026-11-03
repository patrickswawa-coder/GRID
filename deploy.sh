#!/bin/bash
set -e
cd ~/GRID
git pull
.venv/bin/pip install -q -r backend/requirements.txt
rsync -a --delete web/ /var/www/grid/
sudo systemctl restart grid-api
echo "배포 완료"
