#!/bin/bash
# =====================================================
# VPS Setup Script for P2C Catcher
# =====================================================
# Run as root on a fresh Ubuntu 22.04/24.04 VPS:
#   chmod +x setup-vps.sh && sudo ./setup-vps.sh
# =====================================================

set -e

echo "=========================================="
echo "  P2C Catcher VPS Setup"
echo "=========================================="

# Update system
echo "[1/6] Updating system..."
apt-get update -y && apt-get upgrade -y

# Install Node.js 20
echo "[2/6] Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)"
echo "  NPM: $(npm -v)"

# Install Chrome dependencies
echo "[3/6] Installing Chrome/Puppeteer dependencies..."
apt-get install -y \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 libgtk-3-0 \
  libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst6 lsb-release wget xdg-utils \
  2>/dev/null || true

# Install VNC (optional, for login step)
echo "[4/7] Installing TigerVNC (for initial login)..."
apt-get install -y tigervnc-standalone-server xfce4 xfce4-terminal dbus-x11 2>/dev/null || true

# Install cloudflared for Cloudflare Tunnel
echo "[5/7] Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
  ARCH=$(dpkg --print-architecture)
  if [ "$ARCH" = "amd64" ]; then
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
  elif [ "$ARCH" = "arm64" ]; then
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
  fi
  chmod +x /usr/local/bin/cloudflared
  echo "  cloudflared: $(cloudflared --version 2>&1 | head -1)"
else
  echo "  cloudflared already installed"
fi

# Create working directory
echo "[6/7] Setting up project..."
WORK_DIR="/opt/p2c-catcher"
mkdir -p "$WORK_DIR"

if [ -f "package.json" ]; then
  cp -r ./* "$WORK_DIR/" 2>/dev/null || true
  cp .env.example "$WORK_DIR/.env.example" 2>/dev/null || true
fi

cd "$WORK_DIR"
npm install

# Create systemd service
echo "[7/7] Creating systemd service..."
cat > /etc/systemd/system/p2c-catcher.service << 'EOF'
[Unit]
Description=P2C Order Catcher
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/p2c-catcher
ExecStart=/usr/bin/node launcher.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable p2c-catcher

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Configure .env:"
echo "     cd /opt/p2c-catcher"
echo "     cp .env.example .env"
echo "     nano .env"
echo ""
echo "  2. First-time login (needs VNC):"
echo "     vncserver :1 -geometry 1280x720"
echo "     # Connect via VNC client to your_vps_ip:5901"
echo "     export DISPLAY=:1"
echo "     node login.js"
echo ""
echo "  3. Start the service:"
echo "     systemctl start p2c-catcher"
echo "     journalctl -u p2c-catcher -f"
echo ""
echo "  4. Control via Telegram bot:"
echo "     /run   — Start catching"
echo "     /stop  — Stop"
echo "     /cont  — Continue after catch"
echo "     /status — Check status"
echo "     /screen — Get screenshot"
echo "     /web   — Get web dashboard link"
echo ""
echo "  5. Web Dashboard:"
echo "     Cloudflare Tunnel starts automatically."
echo "     Send /web to your bot to get the public URL."
echo "     No ports need to be opened on the VPS!"
echo ""
