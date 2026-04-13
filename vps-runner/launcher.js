// =====================================================
// launcher.js — Headless P2C Catcher with Bot Control
// =====================================================
// Run after login.js: npm start
// Controls via Telegram bot (see bot.js)
// =====================================================

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { createDashboardServer, setTunnelUrl, getTunnelUrl } = require('./dashboard');

// ========================== CONFIG ==========================
const CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  adminId: parseInt(process.env.TELEGRAM_ADMIN_ID, 10),
  p2cUrl: process.env.P2C_URL || 'https://app.send.tg/p2c/orders',
  headless: process.env.HEADLESS !== 'false',
  userDataDir: path.resolve(process.env.USER_DATA_DIR || './chrome-data'),
  chromePath: process.env.CHROME_PATH || undefined,
  screenshotInterval: parseInt(process.env.SCREENSHOT_INTERVAL, 10) || 30,
  screenshotDir: path.resolve(process.env.SCREENSHOT_DIR || './screenshots'),
  // P2C page filters
  paymentMethod: process.env.PAYMENT_METHOD || '',
  sumMin: process.env.SUM_MIN || '',
  sumMax: process.env.SUM_MAX || '',
  // Catcher settings
  orderLimit: parseInt(process.env.ORDER_LIMIT, 10) || 1,
  minDelay: parseInt(process.env.MIN_DELAY, 10) || 0,
  maxDelay: parseInt(process.env.MAX_DELAY, 10) || 0,
  pauseAfterCatch: process.env.PAUSE_AFTER_CATCH !== 'false',
  // Dashboard
  dashboardPort: parseInt(process.env.DASHBOARD_PORT, 10) || 8385,
  dashboardToken: process.env.DASHBOARD_TOKEN || crypto.randomBytes(16).toString('hex'),
  cloudflareEnabled: process.env.CLOUDFLARE_TUNNEL !== 'false',
};

fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
fs.mkdirSync(CONFIG.userDataDir, { recursive: true });

// ========================== GLOBALS ==========================
let browser = null;
let page = null;
let bot = null;
let isRunning = false;
let lastScreenshotPath = null;
let tunnelProcess = null;

// ========================== CATCHER SCRIPT ==========================
// This is injected into the page — same v3 logic, but controlled externally
function getCatcherScript(config) {
  return `
(function () {
  'use strict';
  if (window.__p2c_injected) return;
  window.__p2c_injected = true;

  console.log('[P2C Headless] Catcher injected');

  // ========================== STATE ==========================
  window.__p2c = {
    enabled: false,
    autoClick: true,
    orderLimit: ${config.orderLimit},
    minDelay: ${config.minDelay},
    maxDelay: ${config.maxDelay},
    pauseAfterCatch: ${config.pauseAfterCatch},
    sessionCaught: 0,
    lastCatchTime: 0,
    inCooldown: false,
    waitingApproval: false,
    limitReached: false,
    orders: [],
    lastStatus: 'Инициализация...',
    lastEvent: null,
  };

  const state = window.__p2c;
  const SCAN_INTERVAL = 25;
  const COOLDOWN = 200;
  const PAY_TEXTS = ['Оплатить'];
  const ORDER_KEYWORDS = ['USDT', '₽', 'RUB'];

  function rnd(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function ts() {
    return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function extractOrderInfo(el) {
    if (!el) return null;
    const t = el.textContent || '';
    const info = { time: ts(), raw: t.substring(0, 200), rub: null, usdt: null, recipient: null, reward: null };
    const rm = t.match(/([\\d.,]+)\\s*[₽P]/);       if (rm) info.rub = rm[1];
    const um = t.match(/([\\d.,]+)\\s*USDT/);        if (um) info.usdt = um[1];
    const rcm = t.match(/Получатель\\s*([\\w_]+)/);  if (rcm) info.recipient = rcm[1];
    const rwm = t.match(/Вознаграждение\\s*\\+?([\\d.,]+)\\s*USDT/); if (rwm) info.reward = rwm[1];
    return info;
  }

  function canCatch() {
    if (state.limitReached || state.inCooldown || state.waitingApproval) return false;
    if (state.orderLimit > 0 && state.sessionCaught >= state.orderLimit) {
      state.limitReached = true;
      state.lastStatus = 'ЛИМИТ ' + state.sessionCaught + '/' + state.orderLimit;
      state.lastEvent = { type: 'limit', caught: state.sessionCaught, limit: state.orderLimit, time: ts() };
      return false;
    }
    return true;
  }

  function findPayButtons(root) {
    const btns = [];
    const els = (root || document).querySelectorAll(
      'button, [role="button"], a, div[class*="btn"], div[class*="button"], span[class*="btn"]'
    );
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const txt = el.textContent;
      if (txt && txt.includes('Оплатить')) {
        if (el.offsetParent !== null || el.offsetWidth > 0) btns.push(el);
      }
    }
    return btns;
  }

  function findPayButtonsDeep() {
    let btns = findPayButtons(document);
    try {
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        try {
          const doc = iframes[i].contentDocument || iframes[i].contentWindow?.document;
          if (doc) btns = btns.concat(findPayButtons(doc));
        } catch (e) {}
      }
    } catch (e) {}
    return btns;
  }

  function getOrderCard(btn) {
    let el = btn;
    for (let i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el) break;
      if (ORDER_KEYWORDS.some(kw => (el.textContent || '').includes(kw))) return el;
    }
    return btn.parentElement || btn;
  }

  const clicked = new WeakSet();

  function performClick(btn, info, detectTime) {
    try {
      const btnWindow = btn.ownerDocument?.defaultView || window;
      btn.click();
      const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true, view: btnWindow });
      btn.dispatchEvent(clickEvt);

      const totalMs = Math.round(performance.now() - detectTime);
      state.sessionCaught++;
      state.lastCatchTime = Date.now();
      if (info) {
        info.catchDelay = totalMs;
        state.orders.unshift(info);
        if (state.orders.length > 50) state.orders.pop();
      }

      state.lastStatus = 'CAUGHT #' + state.sessionCaught + ' (' + totalMs + 'ms)';
      state.lastEvent = {
        type: 'caught',
        num: state.sessionCaught,
        delay: totalMs,
        rub: info?.rub,
        usdt: info?.usdt,
        recipient: info?.recipient,
        reward: info?.reward,
        time: ts()
      };

      if (state.orderLimit > 0 && state.sessionCaught >= state.orderLimit) {
        state.limitReached = true;
        state.waitingApproval = true;
        state.lastStatus = 'LIMIT ' + state.sessionCaught + '/' + state.orderLimit;
        state.lastEvent = { type: 'limit', caught: state.sessionCaught, limit: state.orderLimit, time: ts() };
        return;
      }

      if (state.pauseAfterCatch) {
        state.waitingApproval = true;
        state.lastStatus = 'PAUSED after #' + state.sessionCaught;
        state.lastEvent = { type: 'paused', num: state.sessionCaught, time: ts() };
        return;
      }

      setTimeout(() => {
        state.inCooldown = false;
        state.lastStatus = 'WATCHING...';
      }, COOLDOWN);
    } catch (e) {
      state.inCooldown = false;
      state.lastStatus = 'ERROR: ' + e.message;
      state.lastEvent = { type: 'error', message: e.message, time: ts() };
    }
  }

  function clickPayButton(btn) {
    if (!state.enabled || !state.autoClick || !canCatch()) return;
    const detectTime = performance.now();
    const card = getOrderCard(btn);
    const info = extractOrderInfo(card);
    state.inCooldown = true;
    const delay = rnd(state.minDelay, state.maxDelay);
    if (delay <= 0) {
      performClick(btn, info, detectTime);
    } else {
      setTimeout(() => performClick(btn, info, detectTime), delay);
    }
  }

  function scan() {
    if (!state.enabled || !state.autoClick || state.waitingApproval || state.limitReached || state.inCooldown) return;
    const btns = findPayButtonsDeep();
    for (let i = 0; i < btns.length; i++) {
      if (!clicked.has(btns[i])) {
        clicked.add(btns[i]);
        clickPayButton(btns[i]);
        return;
      }
    }
  }

  // MutationObserver — instant reaction
  function setupObserver(root) {
    new MutationObserver((muts) => {
      if (!state.enabled || !state.autoClick || state.inCooldown || state.waitingApproval || state.limitReached) return;
      for (let i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length > 0) { scan(); return; }
      }
    }).observe(root, { childList: true, subtree: true });
  }

  function watchIframes() {
    new MutationObserver(() => {
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        try {
          const doc = iframes[i].contentDocument || iframes[i].contentWindow?.document;
          if (doc && !iframes[i]._p2c) { iframes[i]._p2c = true; setupObserver(doc.body || doc.documentElement); }
        } catch (e) {}
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // === Command API for Puppeteer ===
  window.__p2c_cmd = function(cmd, args) {
    switch (cmd) {
      case 'start':
        state.sessionCaught = 0;
        state.limitReached = false;
        state.waitingApproval = false;
        state.inCooldown = false;
        state.enabled = true;
        state.autoClick = true;
        if (args?.orderLimit) state.orderLimit = args.orderLimit;
        if (args?.minDelay != null) state.minDelay = args.minDelay;
        if (args?.maxDelay != null) state.maxDelay = args.maxDelay;
        if (args?.pauseAfterCatch != null) state.pauseAfterCatch = args.pauseAfterCatch;
        state.lastStatus = 'WATCHING...';
        state.lastEvent = { type: 'started', time: ts() };
        scan();
        return 'started';
      case 'stop':
        state.enabled = false;
        state.autoClick = false;
        state.waitingApproval = false;
        state.inCooldown = false;
        state.lastStatus = 'STOPPED';
        state.lastEvent = { type: 'stopped', time: ts() };
        return 'stopped';
      case 'continue':
        state.waitingApproval = false;
        state.inCooldown = false;
        if (state.limitReached) { state.sessionCaught = 0; state.limitReached = false; }
        state.lastStatus = 'WATCHING...';
        state.lastEvent = { type: 'continued', time: ts() };
        scan();
        return 'continued';
      case 'status':
        return JSON.parse(JSON.stringify({
          enabled: state.enabled,
          caught: state.sessionCaught,
          limit: state.orderLimit,
          limitReached: state.limitReached,
          waitingApproval: state.waitingApproval,
          inCooldown: state.inCooldown,
          status: state.lastStatus,
          lastEvent: state.lastEvent,
          orders: state.orders.slice(0, 5),
          minDelay: state.minDelay,
          maxDelay: state.maxDelay,
        }));
      case 'config':
        if (args?.orderLimit) state.orderLimit = args.orderLimit;
        if (args?.minDelay != null) state.minDelay = args.minDelay;
        if (args?.maxDelay != null) state.maxDelay = args.maxDelay;
        if (args?.pauseAfterCatch != null) state.pauseAfterCatch = args.pauseAfterCatch;
        return 'configured';
      default:
        return 'unknown command';
    }
  };

  // Init
  if (document.body) {
    setupObserver(document.body);
    watchIframes();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      setupObserver(document.body);
      watchIframes();
    });
  }

  setInterval(() => {
    if (state.enabled && state.autoClick && !state.inCooldown && !state.waitingApproval && !state.limitReached) {
      scan();
    }
  }, SCAN_INTERVAL);

  state.lastStatus = 'READY — waiting for /start';
  state.lastEvent = { type: 'ready', time: ts() };
  console.log('[P2C Headless] Ready');
})();
`;
}

// ========================== BROWSER ==========================
async function launchBrowser() {
  console.log('[Browser] Launching...');

  const opts = {
    headless: CONFIG.headless ? 'new' : false,
    userDataDir: CONFIG.userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',   // critical: no timer throttling
      '--disable-backgrounding-occluded-windows', // critical: no background throttle
      '--disable-renderer-backgrounding',         // critical: keep renderer active
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-features=TranslateUI',
      '--window-size=1280,720',
    ],
    defaultViewport: { width: 1280, height: 720 },
  };
  if (CONFIG.chromePath) opts.executablePath = CONFIG.chromePath;

  browser = await puppeteer.launch(opts);
  page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );

  // Block unnecessary resources to speed up page load
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    // Block images, fonts, media — we only need the DOM
    if (['image', 'font', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log(`[Browser] Navigating to: ${CONFIG.p2cUrl}`);
  await page.goto(CONFIG.p2cUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[Browser] Page loaded');

  // Set P2C filters if configured
  await applyPageFilters();

  // Inject catcher script
  await page.evaluate(getCatcherScript(CONFIG));
  console.log('[Browser] Catcher injected');

  // Re-inject on navigation
  page.on('framenavigated', async () => {
    try {
      await page.evaluate(getCatcherScript(CONFIG));
      console.log('[Browser] Catcher re-injected after navigation');
    } catch (e) {}
  });

  return page;
}

// ========================== P2C PAGE FILTERS ==========================
async function applyPageFilters() {
  if (!page) return 'No page';
  const results = [];

  try {
    // Wait for the page content to be ready
    await page.waitForSelector('input, button, [role="button"]', { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500)); // let SPA render

    // --- SET SUM RANGE ---
    if (CONFIG.sumMin || CONFIG.sumMax) {
      // Find all number inputs on the page (the sum min/max fields)
      const inputsSet = await page.evaluate((sumMin, sumMax) => {
        const results = [];
        // Strategy 1: find inputs near "Сумма" or "RUB" text
        const allInputs = document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input');
        const numInputs = [];
        for (const inp of allInputs) {
          // Skip hidden inputs
          if (inp.offsetParent === null && inp.offsetWidth === 0) continue;
          // Check if it looks like a number field (near RUB or sum labels)
          const parent = inp.closest('div, form, section') || inp.parentElement;
          const ctx = parent ? parent.textContent : '';
          if (ctx.includes('RUB') || ctx.includes('Сумма') || ctx.includes('₽') || inp.placeholder?.match(/\d/)) {
            numInputs.push(inp);
          }
        }

        // Also try: just all visible number-like inputs that are not part of our panel
        if (numInputs.length < 2) {
          for (const inp of allInputs) {
            if (inp.offsetParent === null && inp.offsetWidth === 0) continue;
            if (inp.id?.startsWith('p2c-')) continue; // skip our panel inputs
            if (!numInputs.includes(inp)) numInputs.push(inp);
          }
        }

        // Set values — first input = min, second = max
        function setInputValue(input, value) {
          if (!input || !value) return false;
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }

        if (numInputs.length >= 2 && sumMin) {
          setInputValue(numInputs[0], sumMin);
          results.push('sumMin=' + sumMin);
        }
        if (numInputs.length >= 2 && sumMax) {
          setInputValue(numInputs[1], sumMax);
          results.push('sumMax=' + sumMax);
        }
        if (numInputs.length === 1 && sumMin) {
          setInputValue(numInputs[0], sumMin);
          results.push('single_input=' + sumMin);
        }

        return { found: numInputs.length, set: results };
      }, CONFIG.sumMin, CONFIG.sumMax);

      console.log(`[Filters] Sum inputs: found=${inputsSet.found}, set=[${inputsSet.set.join(', ')}]`);
      results.push(`Sum: ${inputsSet.set.join(', ')} (${inputsSet.found} inputs found)`);
    }

    // --- SELECT PAYMENT METHOD ---
    if (CONFIG.paymentMethod) {
      const methodResult = await page.evaluate((methodName) => {
        // Look for clickable elements containing the payment method name
        // Could be a dropdown, button, or selectable card
        const allEls = document.querySelectorAll('button, [role="button"], div[class*="select"], div[class*="option"], div[class*="item"], div[class*="method"], span, a');
        let found = false;
        let clicked = false;

        // First try: look for already-visible option with the method name
        for (const el of allEls) {
          const txt = (el.textContent || '').trim();
          if (txt === methodName || txt.includes(methodName)) {
            if (el.offsetParent !== null || el.offsetWidth > 0) {
              el.click();
              found = true;
              clicked = true;
              break;
            }
          }
        }

        // Second try: maybe it's a dropdown — look for select elements
        if (!found) {
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            for (const opt of sel.options) {
              if (opt.text.includes(methodName) || opt.value.includes(methodName)) {
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                found = true;
                clicked = true;
                break;
              }
            }
            if (found) break;
          }
        }

        return { found, clicked, methodName };
      }, CONFIG.paymentMethod);

      console.log(`[Filters] Payment method "${CONFIG.paymentMethod}": found=${methodResult.found}, clicked=${methodResult.clicked}`);
      results.push(`Method: ${CONFIG.paymentMethod} (${methodResult.found ? 'set' : 'not found'})`);
    }

    return results.join(' | ');
  } catch (e) {
    console.error('[Filters] Error:', e.message);
    return 'Error: ' + e.message;
  }
}

// ========================== SCREENSHOT ==========================
async function takeScreenshot() {
  if (!page) return null;
  try {
    const filename = `screen_${Date.now()}.png`;
    const filepath = path.join(CONFIG.screenshotDir, filename);
    await page.screenshot({ path: filepath, type: 'png' });
    lastScreenshotPath = filepath;

    // Clean old screenshots (keep last 10)
    const files = fs.readdirSync(CONFIG.screenshotDir)
      .filter(f => f.startsWith('screen_') && f.endsWith('.png'))
      .sort()
      .reverse();
    for (let i = 10; i < files.length; i++) {
      fs.unlinkSync(path.join(CONFIG.screenshotDir, files[i]));
    }
    return filepath;
  } catch (e) {
    console.error('[Screenshot] Error:', e.message);
    return null;
  }
}

// ========================== PAGE COMMANDS ==========================
async function sendCommand(cmd, args) {
  if (!page) return { error: 'Browser not running' };
  try {
    return await page.evaluate((c, a) => window.__p2c_cmd(c, a), cmd, args || {});
  } catch (e) {
    return { error: e.message };
  }
}

async function getStatus() {
  return sendCommand('status');
}

// ========================== TELEGRAM BOT ==========================
function startBot() {
  if (!CONFIG.botToken || CONFIG.botToken === 'your_bot_token_here') {
    console.log('[Bot] No TELEGRAM_BOT_TOKEN set — bot disabled');
    return;
  }

  bot = new TelegramBot(CONFIG.botToken, { polling: true });
  console.log('[Bot] Started');

  function isAdmin(msg) {
    return msg.from.id === CONFIG.adminId;
  }

  function reply(msg, text, opts) {
    return bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', ...opts });
  }

  // /start command — show help
  bot.onText(/\/help|\/start/, (msg) => {
    if (!isAdmin(msg)) return;
    reply(msg, `
<b>⚡ P2C Catcher Control</b>

<b>Commands:</b>
/run — Start catching orders
/stop — Stop catching
/cont — Continue after catch/limit
/status — Current status
/screen — Screenshot of the page
/config — Show current config
/set_limit N — Set order limit
/set_delay MIN MAX — Set delay (ms)
/set_pause on|off — Pause after catch

<b>P2C Filters:</b>
/set_sum MIN MAX — Set sum range (RUB)
/set_method NAME — Set payment method
/filters — Apply current filters to page

<b>Web Dashboard:</b>
/web — Get dashboard link

/reload — Reload page
/help — This message
    `.trim());
  });

  // /run — start catching
  bot.onText(/\/run/, async (msg) => {
    if (!isAdmin(msg)) return;
    const result = await sendCommand('start', {
      orderLimit: CONFIG.orderLimit,
      minDelay: CONFIG.minDelay,
      maxDelay: CONFIG.maxDelay,
      pauseAfterCatch: CONFIG.pauseAfterCatch,
    });
    reply(msg, `🟢 <b>Catcher started</b>\nLimit: ${CONFIG.orderLimit} | Delay: ${CONFIG.minDelay}-${CONFIG.maxDelay}ms`);
  });

  // /stop
  bot.onText(/\/stop/, async (msg) => {
    if (!isAdmin(msg)) return;
    await sendCommand('stop');
    reply(msg, '🔴 <b>Catcher stopped</b>');
  });

  // /cont — continue
  bot.onText(/\/cont/, async (msg) => {
    if (!isAdmin(msg)) return;
    await sendCommand('continue');
    reply(msg, '▶️ <b>Continued</b>');
  });

  // /status
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg)) return;
    const s = await getStatus();
    if (s.error) return reply(msg, `❌ ${s.error}`);

    let text = `<b>📊 Status</b>\n`;
    text += `State: ${s.enabled ? '🟢 Active' : '🔴 Inactive'}\n`;
    text += `Caught: ${s.caught}/${s.limit}\n`;
    text += `Status: ${s.status}\n`;
    text += `Delay: ${s.minDelay}-${s.maxDelay}ms\n`;
    if (s.limitReached) text += `⛔ Limit reached\n`;
    if (s.waitingApproval) text += `⏸ Waiting approval\n`;

    if (s.orders && s.orders.length > 0) {
      text += `\n<b>Last orders:</b>\n`;
      for (const o of s.orders) {
        text += `${o.time} — ${o.rub || '?'}₽ / ${o.usdt || '?'} USDT (${o.catchDelay}ms)\n`;
      }
    }
    reply(msg, text);
  });

  // /screen — send screenshot
  bot.onText(/\/screen/, async (msg) => {
    if (!isAdmin(msg)) return;
    const filepath = await takeScreenshot();
    if (filepath) {
      bot.sendPhoto(msg.chat.id, filepath, { caption: `📸 ${new Date().toLocaleTimeString()}` });
    } else {
      reply(msg, '❌ Screenshot failed');
    }
  });

  // /config
  bot.onText(/\/config/, async (msg) => {
    if (!isAdmin(msg)) return;
    const s = await getStatus();
    reply(msg, `<b>⚙️ Config</b>
Order limit: ${s.limit || CONFIG.orderLimit}
Delay: ${s.minDelay ?? CONFIG.minDelay}-${s.maxDelay ?? CONFIG.maxDelay}ms
Pause after catch: ${CONFIG.pauseAfterCatch ? 'ON' : 'OFF'}
Payment method: ${CONFIG.paymentMethod || 'any'}
Sum range: ${CONFIG.sumMin || '?'}-${CONFIG.sumMax || '?'} RUB
URL: ${CONFIG.p2cUrl}`);
  });

  // /set_limit N
  bot.onText(/\/set_limit\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const limit = parseInt(match[1], 10);
    CONFIG.orderLimit = limit;
    await sendCommand('config', { orderLimit: limit });
    reply(msg, `✅ Order limit set to <b>${limit}</b>`);
  });

  // /set_delay MIN MAX
  bot.onText(/\/set_delay\s+(\d+)\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const min = parseInt(match[1], 10);
    const max = parseInt(match[2], 10);
    CONFIG.minDelay = min;
    CONFIG.maxDelay = max;
    await sendCommand('config', { minDelay: min, maxDelay: max });
    reply(msg, `✅ Delay set to <b>${min}-${max}ms</b>`);
  });

  // /set_pause on|off
  bot.onText(/\/set_pause\s+(on|off)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const pause = match[1] === 'on';
    CONFIG.pauseAfterCatch = pause;
    await sendCommand('config', { pauseAfterCatch: pause });
    reply(msg, `✅ Pause after catch: <b>${pause ? 'ON' : 'OFF'}</b>`);
  });

  // /set_sum MIN MAX — set sum range
  bot.onText(/\/set_sum\s+(\d+)\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    CONFIG.sumMin = match[1];
    CONFIG.sumMax = match[2];
    const result = await applyPageFilters();
    reply(msg, `✅ Sum range set to <b>${match[1]}-${match[2]} RUB</b>\n${result}`);
  });

  // /set_method NAME — set payment method
  bot.onText(/\/set_method\s+(.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    CONFIG.paymentMethod = match[1].trim();
    const result = await applyPageFilters();
    reply(msg, `✅ Payment method set to <b>${CONFIG.paymentMethod}</b>\n${result}`);
  });

  // /filters — re-apply filters
  bot.onText(/\/filters/, async (msg) => {
    if (!isAdmin(msg)) return;
    const result = await applyPageFilters();
    const screenshotPath = await takeScreenshot();
    if (screenshotPath) {
      bot.sendPhoto(msg.chat.id, screenshotPath, {
        caption: `⚙️ Filters applied\nMethod: ${CONFIG.paymentMethod || 'any'}\nSum: ${CONFIG.sumMin || '?'}-${CONFIG.sumMax || '?'} RUB\n${result}`
      });
    } else {
      reply(msg, `⚙️ Filters applied\nMethod: ${CONFIG.paymentMethod || 'any'}\nSum: ${CONFIG.sumMin || '?'}-${CONFIG.sumMax || '?'} RUB\n${result}`);
    }
  });

  // /reload — reload page
  bot.onText(/\/reload/, async (msg) => {
    if (!isAdmin(msg)) return;
    try {
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await applyPageFilters();
      await page.evaluate(getCatcherScript(CONFIG));
      reply(msg, '🔄 <b>Page reloaded, filters applied, catcher re-injected</b>');
    } catch (e) {
      reply(msg, `❌ Reload error: ${e.message}`);
    }
  });

  // /web — get dashboard link
  bot.onText(/\/web/, (msg) => {
    if (!isAdmin(msg)) return;
    const url = getTunnelUrl();
    if (url) {
      reply(msg, `🌐 <b>Dashboard:</b>\n<a href="${url}?token=${CONFIG.dashboardToken}">${url}</a>\n\n🔑 Token auto-set in link. Bookmark it.`);
    } else {
      // Fallback: direct URL (only works if port is open)
      reply(msg, `🌐 <b>Dashboard (local):</b>\nhttp://127.0.0.1:${CONFIG.dashboardPort}?token=${CONFIG.dashboardToken}\n\n⚠️ Cloudflare tunnel not active. Run setup-tunnel.sh`);
    }
  });

  // === Event polling — notify admin of catches ===
  let lastEventJson = '';
  setInterval(async () => {
    if (!page) return;
    try {
      const s = await getStatus();
      if (!s || s.error || !s.lastEvent) return;

      const eventJson = JSON.stringify(s.lastEvent);
      if (eventJson === lastEventJson) return;
      lastEventJson = eventJson;

      const ev = s.lastEvent;
      if (ev.type === 'caught') {
        bot.sendMessage(CONFIG.adminId,
          `✅ <b>Order #${ev.num} caught!</b> (${ev.delay}ms)\n${ev.rub || '?'}₽ / ${ev.usdt || '?'} USDT${ev.recipient ? '\n→ ' + ev.recipient : ''}`,
          { parse_mode: 'HTML' }
        );
      } else if (ev.type === 'limit') {
        bot.sendMessage(CONFIG.adminId,
          `⛔ <b>Limit reached:</b> ${ev.caught}/${ev.limit}\nSend /cont to continue or /set_limit N`,
          { parse_mode: 'HTML' }
        );
      } else if (ev.type === 'paused') {
        bot.sendMessage(CONFIG.adminId,
          `⏸ <b>Paused after order #${ev.num}</b>\nSend /cont to continue`,
          { parse_mode: 'HTML' }
        );
      } else if (ev.type === 'error') {
        bot.sendMessage(CONFIG.adminId,
          `❌ <b>Error:</b> ${ev.message}`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (e) {}
  }, 1000);
}

// ========================== PERIODIC SCREENSHOT ==========================
function startScreenshotLoop() {
  if (CONFIG.screenshotInterval > 0) {
    setInterval(takeScreenshot, CONFIG.screenshotInterval * 1000);
  }
}

// ========================== KEEPALIVE ==========================
function startKeepAlive() {
  // Reload page if it becomes unresponsive
  setInterval(async () => {
    if (!page) return;
    try {
      const alive = await page.evaluate(() => !!window.__p2c);
      if (!alive) {
        console.log('[KeepAlive] Catcher not found — re-injecting...');
        await page.evaluate(getCatcherScript(CONFIG));
      }
    } catch (e) {
      console.log('[KeepAlive] Page unresponsive — reloading...');
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await applyPageFilters();
        await page.evaluate(getCatcherScript(CONFIG));
        console.log('[KeepAlive] Recovered');
        if (bot && CONFIG.adminId) {
          bot.sendMessage(CONFIG.adminId, '🔄 Page was unresponsive — reloaded and re-injected', { parse_mode: 'HTML' });
        }
      } catch (e2) {
        console.error('[KeepAlive] Recovery failed:', e2.message);
      }
    }
  }, 15000);
}

// ========================== DASHBOARD ==========================
function startDashboard() {
  createDashboardServer({
    port: CONFIG.dashboardPort,
    authToken: CONFIG.dashboardToken,
    sendCommand,
    getStatus,
    takeScreenshot,
    applyFilters: applyPageFilters,
    getConfig: () => ({
      orderLimit: CONFIG.orderLimit,
      minDelay: CONFIG.minDelay,
      maxDelay: CONFIG.maxDelay,
      pauseAfterCatch: CONFIG.pauseAfterCatch,
      paymentMethod: CONFIG.paymentMethod,
      sumMin: CONFIG.sumMin,
      sumMax: CONFIG.sumMax,
    }),
    setConfig: (newCfg) => {
      if (newCfg.orderLimit !== undefined) CONFIG.orderLimit = parseInt(newCfg.orderLimit, 10) || 1;
      if (newCfg.minDelay !== undefined) CONFIG.minDelay = parseInt(newCfg.minDelay, 10) || 0;
      if (newCfg.maxDelay !== undefined) CONFIG.maxDelay = parseInt(newCfg.maxDelay, 10) || 0;
      if (newCfg.pauseAfterCatch !== undefined) CONFIG.pauseAfterCatch = !!newCfg.pauseAfterCatch;
      if (newCfg.paymentMethod !== undefined) CONFIG.paymentMethod = newCfg.paymentMethod;
      if (newCfg.sumMin !== undefined) CONFIG.sumMin = newCfg.sumMin;
      if (newCfg.sumMax !== undefined) CONFIG.sumMax = newCfg.sumMax;
    },
  });
  console.log(`[Dashboard] Auth token: ${CONFIG.dashboardToken}`);
}

// ========================== CLOUDFLARE TUNNEL ==========================
function startCloudflaredTunnel() {
  if (!CONFIG.cloudflareEnabled) {
    console.log('[Tunnel] Cloudflare tunnel disabled');
    return;
  }

  // Check if cloudflared is installed
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
  } catch {
    console.log('[Tunnel] cloudflared not found. Install it:');
    console.log('  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared');
    console.log('  chmod +x /usr/local/bin/cloudflared');
    console.log('[Tunnel] Skipping tunnel — dashboard available locally only');
    return;
  }

  console.log('[Tunnel] Starting Cloudflare quick tunnel...');

  // Use "cloudflared tunnel --url" for free quick tunnels (no account needed)
  tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${CONFIG.dashboardPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlFound = false;

  function parseTunnelUrl(data) {
    const text = data.toString();
    // cloudflared outputs the URL in stderr
    const match = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !urlFound) {
      urlFound = true;
      const url = match[1];
      setTunnelUrl(url);
      console.log(`[Tunnel] ✅ Public URL: ${url}`);
      console.log(`[Tunnel] Dashboard: ${url}?token=${CONFIG.dashboardToken}`);

      // Notify admin via bot
      if (bot && CONFIG.adminId) {
        bot.sendMessage(CONFIG.adminId,
          `🌐 <b>Dashboard online!</b>\n<a href="${url}?token=${CONFIG.dashboardToken}">Open Dashboard</a>\n\n🔑 Link includes auth token — bookmark it`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        ).catch(() => {});
      }
    }
  }

  tunnelProcess.stdout.on('data', parseTunnelUrl);
  tunnelProcess.stderr.on('data', parseTunnelUrl);

  tunnelProcess.on('close', (code) => {
    console.log(`[Tunnel] cloudflared exited with code ${code}`);
    setTunnelUrl(null);
    // Auto-restart after 5s
    if (code !== null) {
      console.log('[Tunnel] Restarting in 5s...');
      setTimeout(startCloudflaredTunnel, 5000);
    }
  });

  tunnelProcess.on('error', (e) => {
    console.error('[Tunnel] Error:', e.message);
  });
}

// ========================== MAIN ==========================
async function main() {
  console.log('='.repeat(60));
  console.log('  P2C Catcher — Headless VPS Mode');
  console.log('='.repeat(60));

  // Check session exists
  if (!fs.existsSync(path.join(CONFIG.userDataDir, 'Default')) &&
      !fs.existsSync(path.join(CONFIG.userDataDir, 'Local State'))) {
    console.error('');
    console.error('  ❌ No saved session found!');
    console.error('  Run "npm run login" first to log into Telegram.');
    console.error('');
    process.exit(1);
  }

  await launchBrowser();
  startBot();
  startDashboard();
  startCloudflaredTunnel();
  startScreenshotLoop();
  startKeepAlive();

  console.log('');
  console.log('[Main] System running. Control via Telegram bot or web dashboard.');
  console.log('[Main] Send /help to your bot to see commands.');
  console.log('[Main] Send /web to get the dashboard link.');
  console.log('');

  // Notify admin
  if (bot && CONFIG.adminId) {
    setTimeout(() => {
      bot.sendMessage(CONFIG.adminId,
        `🚀 <b>P2C Catcher started on VPS</b>\nURL: ${CONFIG.p2cUrl}\nSend /run to begin catching\nSend /web for dashboard link`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }, 2000);
  }

  // Handle graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`\n[Main] ${sig} received — shutting down...`);
      if (tunnelProcess) tunnelProcess.kill();
      if (bot) bot.stopPolling();
      if (browser) await browser.close();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error('[Main] Fatal error:', e);
  process.exit(1);
});
