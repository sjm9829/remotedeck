#!/bin/bash
# RemoteDeck deploy/install script (Slice 5F)
# Installs static build and creates systemd user unit + config.
# Prerequisites: build completed (npm run build in workspace root)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RD_BASE="${HOME}/.local/share/remotedeck"
RD_CONFIG="${HOME}/.config/remotedeck"
UNIT_NAME="remotedeck-core.service"
PORT=4100
# Loopback-only bind for host systemd deployment. Override only deliberately.
LISTEN_HOST="${REMOTEDECK_LISTEN_HOST:-127.0.0.1}"

echo "=== RemoteDeck Install ==="

# 1. Create data/config directories
mkdir -p "${RD_BASE}/data" "${RD_BASE}/static" "${RD_CONFIG}"
chmod 700 "${RD_BASE}" "${RD_BASE}/data" "${RD_BASE}/static" "${RD_CONFIG}"

# 2. Generate secrets if missing
if [ ! -f "${RD_CONFIG}/master-key" ]; then
  openssl rand -hex 32 > "${RD_CONFIG}/master-key"
  chmod 600 "${RD_CONFIG}/master-key"
  echo "  Generated master-key"
fi
if [ ! -f "${RD_CONFIG}/api-token" ]; then
  openssl rand -hex 32 > "${RD_CONFIG}/api-token"
  chmod 600 "${RD_CONFIG}/api-token"
  echo "  Generated api-token"
fi

# 3. Build env file for the unit
MK=$(cat "${RD_CONFIG}/master-key")
AT=$(cat "${RD_CONFIG}/api-token")
umask 0077
cat > "${RD_CONFIG}/env" <<EOF
REMOTEDECK_MASTER_KEY=${MK}
REMOTEDECK_API_TOKEN=${AT}
EOF
chmod 600 "${RD_CONFIG}/env"

# 4. Deploy static build
if [ -d "${REPO_DIR}/apps/dev-client/dist" ]; then
  rsync -a --delete "${REPO_DIR}/apps/dev-client/dist/" "${RD_BASE}/static/"
  echo "  Static build deployed"
else
  echo "  WARNING: apps/dev-client/dist not found; run VITE_REMOTEDECK_BASE=/remotedeck/ npm run build --workspace=apps/dev-client"
fi

# 5. Install systemd user unit
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"
cat > "${UNIT_DIR}/${UNIT_NAME}" <<EOF
[Unit]
Description=RemoteDeck Core Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${REPO_DIR}/apps/core-server/dist/index.js
WorkingDirectory=${REPO_DIR}
Environment=PORT=${PORT}
Environment=REMOTEDECK_LISTEN_HOST=${LISTEN_HOST}
Environment=DATABASE_PATH=${RD_BASE}/data/remotedeck.db
Environment=LOG_LEVEL=info
EnvironmentFile=${RD_CONFIG}/env
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
KillMode=process
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 644 "${UNIT_DIR}/${UNIT_NAME}"
echo "  Unit installed: ${UNIT_DIR}/${UNIT_NAME}"

# 6. Enable and start
systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}"
systemctl --user restart "${UNIT_NAME}"
echo "  Service: enabled + (re)started"

echo "=== Done ==="
