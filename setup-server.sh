#!/usr/bin/env bash
# Энэ скрипт нь СЕРВЕР дээр (DigitalOcean droplet) ажиллана.
# Node.js, nginx, certbot суулгаж, MediaHub кодыг байршуулж,
# pm2-оор тогтвортой ажиллуулж, kino-hub.mn домэйны nginx тохиргоог хийнэ.
set -euo pipefail

DOMAIN="kino-hub.mn"
APP_DIR="/var/www/mediahub"
TARBALL="/root/kinostream.tar.gz"

echo "================================================================"
echo " MediaHub сервер тохиргоо эхэллээ ($(date))"
echo "================================================================"

echo ""
echo "-- [1/8] Систем шинэчилж, шаардлагатай багцуудыг суулгаж байна --"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl nginx ufw

echo ""
echo "-- [2/8] Node.js 20 шалгаж/суулгаж байна --"
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo ""
echo "-- [3/8] Аюулгүй байдлын зорилгоор жижиг swap файл (1GB) үүсгэж байна --"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap үүслээ."
else
  echo "swap файл өмнө нь үүссэн байна, алгасав."
fi

echo ""
echo "-- [4/8] Кодыг байршуулж байна ($APP_DIR) --"
mkdir -p "$APP_DIR"
if [ -f "$APP_DIR/data/db.json" ]; then
  echo "  Одоо байгаа өгөгдлийн санг (data/db.json) хадгалж байна..."
  cp "$APP_DIR/data/db.json" /root/db.json.backup
fi
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'data' -exec rm -rf {} +
tar -xzf "$TARBALL" -C "$APP_DIR"
mkdir -p "$APP_DIR/data"
if [ -f /root/db.json.backup ]; then
  cp /root/db.json.backup "$APP_DIR/data/db.json"
  echo "  Хуучин өгөгдлийн санг сэргээлээ."
fi

echo ""
echo "-- [5/8] Сангуудыг суулгаж, .env.local тохируулж байна --"
cd "$APP_DIR"
npm install --omit=dev=false
if [ ! -f .env.local ]; then
  cp .env.example .env.local
fi
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
# Хэрэв AUTH_SECRET хоосон бол л шинээр үүсгэнэ (давхар ажиллуулахад дахин үүсгэхгүй)
if ! grep -q '^AUTH_SECRET=.\+' .env.local; then
  sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=${SECRET}|" .env.local
fi
sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://${DOMAIN}|" .env.local
if ! grep -q '^AUTH_TRUST_HOST=' .env.local; then
  echo "AUTH_TRUST_HOST=true" >> .env.local
else
  sed -i "s|^AUTH_TRUST_HOST=.*|AUTH_TRUST_HOST=true|" .env.local
fi

echo ""
echo "-- [6/8] Кодыг build хийж байна (энэ хэсэг хэдэн минут үргэлжилж болно) --"
npm run build

echo ""
echo "-- [7/8] pm2-оор процессыг тогтвортой ажиллуулж байна --"
npm install -g pm2
pm2 delete mediahub >/dev/null 2>&1 || true
pm2 start npm --name mediahub -- run start -- -p 3000
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo ""
echo "-- [8/8] nginx болон firewall тохируулж байна --"
cat > /etc/nginx/sites-available/${DOMAIN} <<EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

SERVER_IP=$(curl -s -4 ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo "================================================================"
echo " АМЖИЛТТАЙ ДУУСЛАА"
echo "================================================================"
echo ""
echo " Сайт одоогоор дараах хаягаар шалгагдана (домэйн холбогдоогүй байсан ч):"
echo "   http://${SERVER_IP}"
echo ""
echo " kino-hub.mn домэйны A record-ыг ${SERVER_IP} IP рүү чиглүүлсний дараа"
echo " дараах командыг ЭНЭ СЕРВЕР дээр ажиллуулж, үнэгүй SSL идэвхжүүлнэ үү:"
echo ""
echo "   apt-get install -y certbot python3-certbot-nginx"
echo "   certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
echo ""
echo " Жишээ бүртгэлүүд (admin panel-д нэвтрэх):"
echo "   Админ:      admin@example.com     / ChangeMe123!"
echo "   Нийлүүлэгч: creator@example.com   / password123"
echo ""
echo " Процессын төлөв шалгах: pm2 status"
echo " Лог харах:              pm2 logs mediahub"
echo "================================================================"
