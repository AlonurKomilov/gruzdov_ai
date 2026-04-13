// =====================================================
// dashboard.js — Web Dashboard for P2C Catcher
// =====================================================
// Provides a web UI to control the catcher remotely.
// Protected by token auth. Exposed via Cloudflare Tunnel.
// =====================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _sendCommand = null;
let _getStatus = null;
let _takeScreenshot = null;
let _applyFilters = null;
let _getConfig = null;
let _setConfig = null;
let _tunnelUrl = null;

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

function createDashboardServer({ port, authToken, sendCommand, getStatus, takeScreenshot, applyFilters, getConfig, setConfig }) {
  _sendCommand = sendCommand;
  _getStatus = getStatus;
  _takeScreenshot = takeScreenshot;
  _applyFilters = applyFilters;
  _getConfig = getConfig;
  _setConfig = setConfig;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- Auth check (token in query or cookie) ---
    const tokenParam = url.searchParams.get('token');
    const cookieToken = parseCookie(req.headers.cookie || '', 'p2c_token');

    if (url.pathname !== '/health') {
      if (tokenParam === authToken) {
        // Set cookie so user doesn't need token in URL again
        res.setHeader('Set-Cookie', `p2c_token=${authToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      } else if (cookieToken !== authToken) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end('<h1>401 Unauthorized</h1><p>Add ?token=YOUR_TOKEN to the URL</p>');
        return;
      }
    }

    // --- Routes ---
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // Serve dashboard HTML
        const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);

      } else if (url.pathname === '/api/status') {
        const status = await _getStatus();
        const config = _getConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, config }));

      } else if (url.pathname === '/api/command' && req.method === 'POST') {
        const body = await readBody(req);
        const { cmd, args } = JSON.parse(body);
        const result = await _sendCommand(cmd, args || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));

      } else if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        _setConfig(newConfig);
        // Also update in-page catcher config
        await _sendCommand('config', {
          orderLimit: newConfig.orderLimit,
          minDelay: newConfig.minDelay,
          maxDelay: newConfig.maxDelay,
          pauseAfterCatch: newConfig.pauseAfterCatch,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/api/filters' && req.method === 'POST') {
        const body = await readBody(req);
        const filters = JSON.parse(body);
        if (filters.paymentMethod !== undefined) _setConfig({ paymentMethod: filters.paymentMethod });
        if (filters.sumMin !== undefined) _setConfig({ sumMin: filters.sumMin });
        if (filters.sumMax !== undefined) _setConfig({ sumMax: filters.sumMax });
        const result = await _applyFilters();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));

      } else if (url.pathname === '/api/screenshot') {
        const filepath = await _takeScreenshot();
        if (filepath && fs.existsSync(filepath)) {
          const img = fs.readFileSync(filepath);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
          res.end(img);
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Screenshot failed' }));
        }

      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');

      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Dashboard] Running on http://127.0.0.1:${port}`);
  });

  return server;
}

function setTunnelUrl(url) {
  _tunnelUrl = url;
}

function getTunnelUrl() {
  return _tunnelUrl;
}

// --- Helpers ---
function parseCookie(cookieStr, name) {
  const match = cookieStr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { createDashboardServer, setTunnelUrl, getTunnelUrl };
