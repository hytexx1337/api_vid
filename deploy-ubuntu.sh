#!/usr/bin/env bash
#
# deploy-ubuntu.sh â€” Instala api_vid desde 0 en una VPS Ubuntu limpia.
#
# QuÃ© hace:
#   1. Instala dependencias de sistema (build tools, python3, git, etc.)
#   2. Instala Node.js 22.x LTS (vÃ­a NodeSource) + PM2 global
#   3. Clonea (o actualiza) el repo de GitHub
#   4. npm ci (deps de Node) + venv de Python para el microservicio miruro
#   5. Crea .env desde .env.example si no existe (hay que completarlo a mano)
#   6. Arranca todo con PM2 (ecosystem.config.cjs) y lo deja persistente (systemd)
#   7. Instala/configura nginx como reverse proxy para el dominio
#   8. Emite certificado HTTPS con certbot (Let's Encrypt)
#
# Uso:
#   sudo bash deploy-ubuntu.sh
#
# Requisitos previos:
#   - El dominio (DOMAIN) ya debe apuntar (registro A) a la IP de esta VPS,
#     sino el paso de certbot va a fallar (lo podÃ©s reintentar despuÃ©s:
#     sudo certbot --nginx -d "$DOMAIN").
#   - Correr como root o con sudo.
#
# DespuÃ©s de correrlo:
#   - CompletÃ¡ /var/www/api_vid/.env con tus secretos reales (API_KEY, R2, etc.)
#     PodÃ©s subir tu .env local con: scp .env usuario@servidor:/var/www/api_vid/.env
#   - pm2 restart ecosystem.config.cjs (desde APP_DIR) para que tome el .env nuevo.

set -euo pipefail

# â”€â”€ ConfiguraciÃ³n (editable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
DOMAIN="${DOMAIN:-wachin.zenkai.live}"
REPO_URL="${REPO_URL:-https://github.com/hytexx1337/api_vid}"
APP_DIR="${APP_DIR:-/var/www/api_vid}"
GIT_BRANCH="${GIT_BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"   # dejar vacÃ­o => certbot sin email (--register-unsafely-without-email)
APP_PORT="${APP_PORT:-8000}"
RUN_USER="${SUDO_USER:-$(whoami)}"

log() { echo -e "\n\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Este script necesita privilegios de root. Correlo con: sudo bash $0"
  exit 1
fi

# â”€â”€ 1. Dependencias de sistema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Actualizando apt e instalando dependencias base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git build-essential \
  python3 python3-venv python3-pip \
  nginx certbot python3-certbot-nginx \
  ufw

# â”€â”€ 2. Node.js (NodeSource) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  log "Instalando Node.js ${NODE_MAJOR}.x desde NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js ya instalado: $(node -v)"
fi

log "Versiones: node=$(node -v) npm=$(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  log "Instalando PM2 global"
  npm install -g pm2
else
  log "PM2 ya instalado: $(pm2 -v)"
fi

# â”€â”€ 3. Clonar / actualizar repo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo ya existe en $APP_DIR â€” haciendo git pull"
  git -C "$APP_DIR" fetch origin "$GIT_BRANCH"
  git -C "$APP_DIR" checkout "$GIT_BRANCH"
  git -C "$APP_DIR" pull origin "$GIT_BRANCH"
else
  log "Clonando $REPO_URL en $APP_DIR"
  git clone --branch "$GIT_BRANCH" "$REPO_URL" "$APP_DIR"
fi

chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# â”€â”€ 4. Dependencias de la app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Instalando dependencias de Node (npm ci)"
cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci

log "Creando venv de Python para el microservicio miruro"
if [[ ! -d "$APP_DIR/venv" ]]; then
  sudo -u "$RUN_USER" python3 -m venv "$APP_DIR/venv"
fi
sudo -u "$RUN_USER" "$APP_DIR/venv/bin/pip" install --upgrade pip
sudo -u "$RUN_USER" "$APP_DIR/venv/bin/pip" install flask curl_cffi

mkdir -p "$APP_DIR/logs" "$APP_DIR/data" "$APP_DIR/subs-cache"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/logs" "$APP_DIR/data" "$APP_DIR/subs-cache"

# â”€â”€ 5. .env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$APP_DIR/.env.example" ]]; then
    warn ".env no existe â€” copiando .env.example. COMPLETALO CON TUS SECRETOS REALES."
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  else
    warn ".env no existe y no hay .env.example â€” creando uno mÃ­nimo."
    echo "PORT=${APP_PORT}" > "$APP_DIR/.env"
  fi
  chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env"
else
  log ".env ya existe, no lo toco."
fi

# â”€â”€ 6. PM2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Arrancando/recargando con PM2"
sudo -u "$RUN_USER" bash -lc "cd '$APP_DIR' && pm2 startOrReload ecosystem.config.cjs"
sudo -u "$RUN_USER" bash -lc "pm2 save"

log "Configurando PM2 para arrancar en el boot (systemd)"
PM2_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v pm2')"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$RUN_USER" --hp "$(eval echo ~"$RUN_USER")" >/tmp/pm2-startup.out 2>&1 || true
STARTUP_CMD="$(grep -E '^sudo ' /tmp/pm2-startup.out || true)"
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD"
fi

# â”€â”€ 7. Nginx â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Configurando nginx para $DOMAIN -> 127.0.0.1:${APP_PORT}"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}"
# Sacar el default si estÃ¡ activo y pisarÃ­a el server_name _ por defecto
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx

# â”€â”€ 8. Firewall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Configurando ufw (OpenSSH + Nginx Full)"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
if ! ufw status | grep -q "Status: active"; then
  yes | ufw enable || true
fi

# â”€â”€ 9. Certbot (HTTPS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "Emitiendo certificado HTTPS con certbot para $DOMAIN"
if [[ -n "$CERTBOT_EMAIL" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect || \
    warn "certbot fallÃ³ â€” revisÃ¡ que $DOMAIN apunte (registro A) a la IP de esta VPS, y reintentÃ¡: certbot --nginx -d $DOMAIN"
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
    warn "certbot fallÃ³ â€” revisÃ¡ que $DOMAIN apunte (registro A) a la IP de esta VPS, y reintentÃ¡: certbot --nginx -d $DOMAIN"
fi

log "Listo."
echo "  App dir:        $APP_DIR"
echo "  PM2 status:      pm2 status"
echo "  Logs:             pm2 logs"
echo "  Nginx config:    $NGINX_CONF"
echo ""
warn "IMPORTANTE: completÃ¡ $APP_DIR/.env con tus secretos reales (API_KEY, R2_*, CR_*, etc.)"
warn "y luego: cd $APP_DIR && pm2 restart ecosystem.config.cjs"
