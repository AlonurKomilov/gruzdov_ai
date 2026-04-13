# =====================================================
# P2C Catcher — Makefile
# =====================================================
# Usage:
#   make install   — Install everything + create .env
#   make start     — Start all services (launcher + tunnel)
#   make stop      — Stop all services
#   make restart   — Stop then start
#   make status    — Show running processes
#   make logs      — Tail live logs
#   make login     — One-time Telegram login (needs display)
#   make screen    — Take a screenshot now
#   make clean     — Remove screenshots and temp files
#   make uninstall — Remove systemd service
# =====================================================

SHELL := /bin/bash
DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
NODE := $(shell which node 2>/dev/null || echo "node")
NPM := $(shell which npm 2>/dev/null || echo "npm")
SERVICE_NAME := p2c-catcher
PID_FILE := $(DIR)/.launcher.pid

.PHONY: install start stop restart status logs login screen clean uninstall help

# ========================== HELP ==========================
help:
	@echo ""
	@echo "  ⚡ P2C Catcher — Commands"
	@echo "  ════════════════════════════════════"
	@echo "  make install   — Install deps + create .env"
	@echo "  make start     — Start catcher + dashboard + tunnel"
	@echo "  make stop      — Stop everything"
	@echo "  make restart   — Restart all services"
	@echo "  make status    — Show running processes"
	@echo "  make logs      — Tail live logs"
	@echo "  make login     — Telegram login (needs display)"
	@echo "  make screen    — Take screenshot"
	@echo "  make clean     — Remove temp files"
	@echo "  make uninstall — Remove systemd service"
	@echo ""

# ========================== INSTALL ==========================
install: _install_node _install_deps _install_cloudflared _create_env _install_service
	@echo ""
	@echo "  ✅ Installation complete!"
	@echo ""
	@echo "  Next: edit .env with your settings, then run:"
	@echo "    make login    (first time only — Telegram login)"
	@echo "    make start    (start catching)"
	@echo ""

_install_node:
	@echo "[1/5] Checking Node.js..."
	@if ! command -v node &>/dev/null; then \
		echo "  Installing Node.js 20..."; \
		curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
		apt-get install -y nodejs; \
	fi
	@echo "  Node: $$(node -v) | NPM: $$(npm -v)"

_install_deps:
	@echo "[2/5] Installing npm dependencies..."
	@cd "$(DIR)" && $(NPM) install
	@echo "  ✅ Dependencies installed"

_install_cloudflared:
	@echo "[3/5] Checking cloudflared..."
	@if ! command -v cloudflared &>/dev/null; then \
		echo "  Installing cloudflared..."; \
		ARCH=$$(dpkg --print-architecture 2>/dev/null || echo "amd64"); \
		curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$$ARCH" -o /usr/local/bin/cloudflared && \
		chmod +x /usr/local/bin/cloudflared && \
		echo "  ✅ cloudflared installed"; \
	else \
		echo "  ✅ cloudflared already installed"; \
	fi

_create_env:
	@echo "[4/5] Setting up .env..."
	@if [ ! -f "$(DIR)/.env" ]; then \
		cp "$(DIR)/.env.example" "$(DIR)/.env"; \
		echo "  ✅ .env created from template — edit it: nano $(DIR)/.env"; \
	else \
		echo "  ⏭  .env already exists — skipping"; \
	fi
	@mkdir -p "$(DIR)/chrome-data" "$(DIR)/screenshots"

_install_service:
	@echo "[5/5] Setting up systemd service..."
	@echo '[Unit]' > /tmp/$(SERVICE_NAME).service
	@echo 'Description=P2C Order Catcher' >> /tmp/$(SERVICE_NAME).service
	@echo 'After=network.target' >> /tmp/$(SERVICE_NAME).service
	@echo '' >> /tmp/$(SERVICE_NAME).service
	@echo '[Service]' >> /tmp/$(SERVICE_NAME).service
	@echo 'Type=simple' >> /tmp/$(SERVICE_NAME).service
	@echo 'WorkingDirectory=$(DIR)' >> /tmp/$(SERVICE_NAME).service
	@echo 'ExecStart=$(NODE) $(DIR)/launcher.js' >> /tmp/$(SERVICE_NAME).service
	@echo 'Restart=always' >> /tmp/$(SERVICE_NAME).service
	@echo 'RestartSec=10' >> /tmp/$(SERVICE_NAME).service
	@echo 'Environment=NODE_ENV=production' >> /tmp/$(SERVICE_NAME).service
	@echo '' >> /tmp/$(SERVICE_NAME).service
	@echo '[Install]' >> /tmp/$(SERVICE_NAME).service
	@echo 'WantedBy=multi-user.target' >> /tmp/$(SERVICE_NAME).service
	@if command -v systemctl &>/dev/null; then \
		cp /tmp/$(SERVICE_NAME).service /etc/systemd/system/$(SERVICE_NAME).service 2>/dev/null && \
		systemctl daemon-reload 2>/dev/null && \
		systemctl enable $(SERVICE_NAME) 2>/dev/null && \
		echo "  ✅ Systemd service created and enabled"; \
	else \
		echo "  ⚠️  systemctl not available — use 'make start' to run manually"; \
	fi
	@rm -f /tmp/$(SERVICE_NAME).service

# ========================== START ==========================
start:
	@echo "⚡ Starting P2C Catcher..."
	@if [ ! -f "$(DIR)/.env" ]; then \
		echo "❌ .env not found. Run 'make install' first."; \
		exit 1; \
	fi
	@if [ ! -d "$(DIR)/node_modules" ]; then \
		echo "❌ Dependencies not installed. Run 'make install' first."; \
		exit 1; \
	fi
	@# Try systemd first, fallback to direct
	@if command -v systemctl &>/dev/null && [ -f /etc/systemd/system/$(SERVICE_NAME).service ]; then \
		systemctl start $(SERVICE_NAME) && \
		echo "✅ Started via systemd"; \
		echo "   Logs: make logs"; \
	else \
		echo "Starting directly (no systemd)..."; \
		cd "$(DIR)" && nohup $(NODE) launcher.js > "$(DIR)/catcher.log" 2>&1 & \
		echo $$! > "$(PID_FILE)"; \
		sleep 2; \
		if kill -0 $$(cat "$(PID_FILE)" 2>/dev/null) 2>/dev/null; then \
			echo "✅ Started (PID: $$(cat $(PID_FILE)))"; \
			echo "   Logs: tail -f $(DIR)/catcher.log"; \
		else \
			echo "❌ Failed to start — check catcher.log"; \
			cat "$(DIR)/catcher.log" | tail -20; \
		fi; \
	fi

# ========================== STOP ==========================
stop:
	@echo "⏹  Stopping P2C Catcher..."
	@if command -v systemctl &>/dev/null && [ -f /etc/systemd/system/$(SERVICE_NAME).service ]; then \
		systemctl stop $(SERVICE_NAME) 2>/dev/null; \
		echo "✅ Stopped via systemd"; \
	fi
	@# Also kill any direct-run process
	@if [ -f "$(PID_FILE)" ]; then \
		PID=$$(cat "$(PID_FILE)"); \
		if kill -0 "$$PID" 2>/dev/null; then \
			kill "$$PID" 2>/dev/null; \
			echo "✅ Killed process $$PID"; \
		fi; \
		rm -f "$(PID_FILE)"; \
	fi
	@# Kill any remaining launcher processes
	@pkill -f "node.*launcher.js" 2>/dev/null || true
	@# Kill cloudflared tunnel
	@pkill -f "cloudflared.*tunnel" 2>/dev/null || true
	@echo "✅ All stopped"

# ========================== RESTART ==========================
restart: stop
	@sleep 2
	@$(MAKE) start

# ========================== STATUS ==========================
status:
	@echo ""
	@echo "  ⚡ P2C Catcher Status"
	@echo "  ═══════════════════════"
	@if command -v systemctl &>/dev/null && [ -f /etc/systemd/system/$(SERVICE_NAME).service ]; then \
		systemctl is-active --quiet $(SERVICE_NAME) && \
			echo "  Service:     🟢 Running (systemd)" || \
			echo "  Service:     🔴 Stopped (systemd)"; \
	elif [ -f "$(PID_FILE)" ] && kill -0 $$(cat "$(PID_FILE)" 2>/dev/null) 2>/dev/null; then \
		echo "  Service:     🟢 Running (PID: $$(cat $(PID_FILE)))"; \
	else \
		echo "  Service:     🔴 Stopped"; \
	fi
	@pgrep -f "node.*launcher.js" >/dev/null 2>&1 && \
		echo "  Launcher:    🟢 Running" || \
		echo "  Launcher:    🔴 Not running"
	@pgrep -f "cloudflared.*tunnel" >/dev/null 2>&1 && \
		echo "  Tunnel:      🟢 Running" || \
		echo "  Tunnel:      🔴 Not running"
	@if [ -f "$(DIR)/.env" ]; then \
		echo "  Config:      ✅ .env exists"; \
	else \
		echo "  Config:      ❌ .env missing"; \
	fi
	@if [ -d "$(DIR)/chrome-data/Default" ] || [ -f "$(DIR)/chrome-data/Local State" ]; then \
		echo "  Session:     ✅ Telegram logged in"; \
	else \
		echo "  Session:     ❌ Not logged in (run: make login)"; \
	fi
	@echo ""

# ========================== LOGS ==========================
logs:
	@if command -v systemctl &>/dev/null && [ -f /etc/systemd/system/$(SERVICE_NAME).service ]; then \
		journalctl -u $(SERVICE_NAME) -f --no-pager; \
	elif [ -f "$(DIR)/catcher.log" ]; then \
		tail -f "$(DIR)/catcher.log"; \
	else \
		echo "No logs found. Is the service running?"; \
	fi

# ========================== LOGIN ==========================
login:
	@echo "🔐 Starting Telegram login..."
	@if [ ! -d "$(DIR)/node_modules" ]; then \
		echo "❌ Run 'make install' first."; \
		exit 1; \
	fi
	@cd "$(DIR)" && $(NODE) login.js

# ========================== SCREENSHOT ==========================
screen:
	@if [ -d "$(DIR)/screenshots" ]; then \
		LATEST=$$(ls -t "$(DIR)/screenshots"/screen_*.png 2>/dev/null | head -1); \
		if [ -n "$$LATEST" ]; then \
			echo "Latest screenshot: $$LATEST"; \
			echo "  $$(stat -c '%y' "$$LATEST" 2>/dev/null || stat -f '%Sm' "$$LATEST" 2>/dev/null)"; \
		else \
			echo "No screenshots yet."; \
		fi; \
	else \
		echo "No screenshots directory."; \
	fi

# ========================== CLEAN ==========================
clean:
	@echo "🧹 Cleaning temp files..."
	@rm -rf "$(DIR)/screenshots"/*.png
	@rm -f "$(DIR)/catcher.log"
	@rm -f "$(PID_FILE)"
	@echo "✅ Cleaned"

# ========================== UNINSTALL ==========================
uninstall:
	@echo "🗑  Removing systemd service..."
	@if command -v systemctl &>/dev/null; then \
		systemctl stop $(SERVICE_NAME) 2>/dev/null || true; \
		systemctl disable $(SERVICE_NAME) 2>/dev/null || true; \
		rm -f /etc/systemd/system/$(SERVICE_NAME).service; \
		systemctl daemon-reload 2>/dev/null || true; \
		echo "✅ Service removed"; \
	else \
		echo "⚠️  No systemd — nothing to remove"; \
	fi
