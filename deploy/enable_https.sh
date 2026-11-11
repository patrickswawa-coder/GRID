#!/bin/bash
# HTTPS 켜기 (서버에서 한 번):  bash ~/GRID/deploy/enable_https.sh grid-team7.duckdns.org [이메일]
#
# 하는 일
#  1) 도메인이 이 서버 IP를 가리키는지 확인
#  2) Let's Encrypt 무료 인증서 발급 (webroot 방식: 지금 80번 nginx 그대로 사용, 자동 갱신)
#  3) nginx 를 443(HTTPS)로 바꾸고, http://도메인 · http://IP 로 오는 요청은 https://도메인 으로 넘김
#     → 이미 뽑은 http://32.190.9.9 QR도 계속 동작 (자동으로 https 로 이동)
# 여러 번 실행해도 안전. 되돌리기: bash ~/GRID/deploy/setup_server.sh 를 FORCE_HTTP=1 로 실행
set -e
DOMAIN="$1"; EMAIL="$2"
if [ -z "$DOMAIN" ]; then
  echo "사용법: bash ~/GRID/deploy/enable_https.sh 도메인 [이메일]"
  echo "  예)   bash ~/GRID/deploy/enable_https.sh grid-team7.duckdns.org"
  exit 1
fi

echo "▶ 1/4 도메인 확인"
IP=$(curl -s -m 5 https://checkip.amazonaws.com || true)
RES=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | head -1)
if [ -z "$RES" ] || { [ -n "$IP" ] && [ "$RES" != "$IP" ]; }; then
  echo "✗ $DOMAIN 이 아직 이 서버(${IP:-?})를 가리키지 않아요 (지금: ${RES:-없음})."
  echo "  DuckDNS 화면에서 current ip 가 ${IP:-서버 IP} 인지 확인하고 1~2분 뒤 다시 실행하세요."
  exit 1
fi
echo "   $DOMAIN → $RES ✓"

echo "▶ 2/4 certbot 설치"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null

echo "▶ 3/4 인증서 발급 (1분 이내)"
if [ -n "$EMAIL" ]; then MAIL=(-m "$EMAIL"); else MAIL=(--register-unsafely-without-email); fi
sudo certbot certonly --webroot -w /var/www/grid -d "$DOMAIN" --non-interactive --agree-tos "${MAIL[@]}" \
  --keep-until-expiring --deploy-hook "systemctl reload nginx"

echo "▶ 4/4 nginx 를 HTTPS 로"
sudo tee /etc/nginx/sites-available/grid >/dev/null <<NGINX
# GRID (HTTPS) — deploy/enable_https.sh 가 만든 설정. setup_server.sh 는 이 파일을 덮어쓰지 않음
server {
    listen 80 default_server;
    server_name _;
    location /.well-known/acme-challenge/ { root /var/www/grid; }   # 인증서 자동 갱신용
    location / { return 301 https://$DOMAIN\$request_uri; }          # http://IP · http://도메인 → https
}
server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /var/www/grid;
    index index.html;
    client_max_body_size 2m;
    gzip on;
    gzip_types application/json application/javascript text/css;

    location / {
        try_files \$uri \$uri/ =404;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
NGINX
sudo nginx -t -q
sudo systemctl reload nginx

# 도메인 기억 (setup_server.sh · 안내용)
touch ~/GRID/.env
grep -q '^DOMAIN=' ~/GRID/.env && sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" ~/GRID/.env || echo "DOMAIN=$DOMAIN" >> ~/GRID/.env

sleep 1
if curl -fs "https://$DOMAIN/api/health" >/dev/null; then
  echo
  echo "✅ HTTPS 완료!"
  echo "   시민 페이지 : https://$DOMAIN/"
  echo "   관리자 화면 : https://$DOMAIN/admin/"
  echo "   예전 주소 http://${IP:-32.190.9.9}/ 는 자동으로 위 주소로 넘어가요."
  echo "   ※ 네이버 지도를 쓰면: 네이버 클라우드 콘솔 > Maps > 애플리케이션 > Web 서비스 URL 에 https://$DOMAIN 추가"
else
  echo "✗ https://$DOMAIN 응답이 없어요. 'sudo nginx -t' 와 'sudo journalctl -u nginx -n 30' 결과를 보내주세요."
fi
