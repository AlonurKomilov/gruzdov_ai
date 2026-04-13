// ==UserScript==
// @name         Crypto Bot P2C Order Catcher
// @namespace    crypto-bot-p2c-catcher
// @version      2.0
// @description  Auto-catch P2C merchant orders in Crypto Bot (Telegram Web + standalone)
// @match        https://web.telegram.org/*
// @match        https://*.telegram.org/*
// @match        https://app.send.tg/*
// @match        https://*.send.tg/*
// @match        https://*.crypt.bot/*
// @match        https://crypt.bot/*
// @match        https://app.crypt.bot/*
// @match        https://pay.crypt.bot/*
// @match        https://*.cryptobot.app/*
// @match        https://t.me/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log('[P2C Catcher] Script loaded on:', window.location.href);

  // ========================== STATE ==========================
  const state = {
    enabled: false,
    autoClick: true,
    // User-configurable from panel
    orderLimit: 1,        // how many to catch before stopping
    minDelay: 50,
    maxDelay: 150,
    soundEnabled: true,
    // Runtime
    sessionCaught: 0,
    lastCatchTime: 0,
    inCooldown: false,
    waitingApproval: false,
    limitReached: false,
    pendingOrder: null,
    orders: [],
    lastStatus: 'Настройте и нажмите СТАРТ',
    observerActive: false,
  };

  // Fixed config
  const SCAN_INTERVAL = 150;
  const COOLDOWN = 1500;
  const PAY_TEXTS = ['Оплатить'];
  const ORDER_KEYWORDS = ['USDT', '₽', 'RUB'];
  const TOGGLE_KEY = 'Q';

  // ========================== SOUND ==========================
  function playBeep() {
    if (!state.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0.3;
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

  // ========================== UTILS ==========================
  function rnd(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function ts() {
    return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ========================== ORDER EXTRACTION ==========================
  function extractOrderInfo(el) {
    if (!el) return null;
    const t = el.textContent || '';
    const info = { time: ts(), raw: t.substring(0, 200), rub: null, usdt: null, recipient: null, reward: null, pricePerUsdt: null };
    const rm = t.match(/([\d.,]+)\s*[₽P]/);       if (rm) info.rub = rm[1];
    const um = t.match(/([\d.,]+)\s*USDT/);        if (um) info.usdt = um[1];
    const rcm = t.match(/Получатель\s*([\w_]+)/);  if (rcm) info.recipient = rcm[1];
    const rwm = t.match(/Вознаграждение\s*\+?([\d.,]+)\s*USDT/); if (rwm) info.reward = rwm[1];
    const pm = t.match(/Цена за 1 USDT\s*([\d.,]+)/); if (pm) info.pricePerUsdt = pm[1];
    return info;
  }

  // ========================== CHECK LIMITS ==========================
  function canCatch() {
    if (state.limitReached) return false;
    if (state.inCooldown || state.waitingApproval) return false;
    if (state.orderLimit > 0 && state.sessionCaught >= state.orderLimit) {
      state.limitReached = true;
      state.lastStatus = `⛔ Лимит ${state.orderLimit} заказ(ов) достигнут. Измените и нажмите СТАРТ`;
      updatePanel();
      return false;
    }
    return true;
  }

  // ========================== PAY BUTTON DETECTION ==========================
  function findPayButtons(root) {
    const btns = [];
    const els = (root || document).querySelectorAll(
      'button, [role="button"], a, div[class*="btn"], div[class*="button"], span[class*="btn"]'
    );
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      for (const pt of PAY_TEXTS) {
        if (txt === pt || txt.includes(pt)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const s = window.getComputedStyle(el);
            if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
              btns.push(el);
            }
          }
        }
      }
    }
    return btns;
  }

  function findPayButtonsDeep() {
    let btns = findPayButtons(document);
    try {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
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

  // ========================== CLICK HANDLER ==========================
  function clickPayButton(btn) {
    if (!state.enabled || !state.autoClick) return;
    if (!canCatch()) return;

    const card = getOrderCard(btn);
    const info = extractOrderInfo(card);
    state.inCooldown = true;
    const delay = rnd(state.minDelay, state.maxDelay);
    state.lastStatus = `⏳ Захват через ${delay}мс...`;
    updatePanel();

    setTimeout(() => {
      try {
        // Use the button's own window context (critical for iframes)
        const btnWindow = btn.ownerDocument?.defaultView || window;
        btn.focus();
        for (const evtName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          btn.dispatchEvent(new MouseEvent(evtName, { bubbles: true, cancelable: true, view: btnWindow }));
        }

        state.sessionCaught++;
        state.lastCatchTime = Date.now();
        if (info) {
          info.catchDelay = delay;
          state.orders.unshift(info);
          if (state.orders.length > 50) state.orders.pop();
        }

        state.lastStatus = `✅ Заказ #${state.sessionCaught} пойман! (${delay}мс)`;
        playBeep();

        // Check if limit reached
        if (state.orderLimit > 0 && state.sessionCaught >= state.orderLimit) {
          state.limitReached = true;
          state.waitingApproval = true;
          state.pendingOrder = info;
          state.lastStatus = `⛔ Поймано ${state.sessionCaught}/${state.orderLimit}. Нажмите ПРОДОЛЖИТЬ или измените лимит`;
          updatePanel();
          return;
        }

        // Pause for approval if checkbox is on
        const pauseEnabled = panelEl ? panelEl.querySelector('#p2c-pause').checked : true;
        if (pauseEnabled) {
          state.waitingApproval = true;
          state.pendingOrder = info;
          state.lastStatus = `⏸️ Заказ #${state.sessionCaught} пойман — подтвердите`;
          updatePanel();
          return;
        }

        // No pause — continue after cooldown
        updatePanel();
        setTimeout(() => {
          state.inCooldown = false;
          state.lastStatus = `👀 Ловим ${state.orderLimit} заказ(ов)...`;
          updatePanel();
        }, COOLDOWN);
      } catch (e) {
        state.inCooldown = false;
        state.lastStatus = '❌ Ошибка: ' + e.message;
        updatePanel();
      }
    }, delay);
  }

  // ========================== SCANNING ==========================
  let lastBtnCount = 0;
  const clicked = new WeakSet();

  function scan() {
    if (!state.enabled || !state.autoClick || state.waitingApproval || state.limitReached) return;
    const btns = findPayButtonsDeep();
    if (btns.length > 0 && btns.length !== lastBtnCount) {
      for (const b of btns) {
        if (!clicked.has(b)) {
          clicked.add(b);
          clickPayButton(b);
          break;
        }
      }
    }
    lastBtnCount = btns.length;
  }

  // ========================== MUTATION OBSERVER ==========================
  function setupObserver(root) {
    const obs = new MutationObserver((muts) => {
      if (!state.enabled || !state.autoClick || state.inCooldown || state.waitingApproval || state.limitReached) return;
      for (const m of muts) {
        if (m.addedNodes.length > 0) { setTimeout(scan, 10); break; }
      }
    });
    obs.observe(root, { childList: true, subtree: true });
    state.observerActive = true;
  }

  function watchIframes() {
    new MutationObserver(() => {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc && !iframe._p2c) { iframe._p2c = true; setupObserver(doc.body || doc.documentElement); }
        } catch (e) {}
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // ========================== UI PANEL ==========================
  let panelEl = null;

  function createPanel() {
    const p = document.createElement('div');
    p.id = 'p2c-panel';
    p.innerHTML = `
      <style>
        #p2c-panel {
          position:fixed; top:10px; right:10px; width:330px; max-height:600px;
          background:rgba(20,20,30,0.96); color:#e0e0e0; border:1px solid #444;
          border-radius:12px; font-family:-apple-system,sans-serif; font-size:13px;
          z-index:2147483647; box-shadow:0 4px 24px rgba(0,0,0,0.5);
          overflow:hidden; user-select:none;
        }
        #p2c-panel.min .p2c-body { display:none; }
        .p2c-hdr {
          display:flex; justify-content:space-between; align-items:center;
          padding:10px 14px; background:rgba(40,40,60,0.9);
          border-bottom:1px solid #333; cursor:move;
        }
        .p2c-hdr-t { font-weight:600; font-size:14px; color:#8b5cf6; }
        .p2c-hdr-b { display:flex; gap:6px; }
        .p2c-hdr-b button {
          background:rgba(255,255,255,0.1); border:none; color:#ccc;
          width:26px; height:26px; border-radius:6px; cursor:pointer; font-size:14px;
          display:flex; align-items:center; justify-content:center;
        }
        .p2c-hdr-b button:hover { background:rgba(255,255,255,0.2); }
        .p2c-body { padding:12px 14px; max-height:500px; overflow-y:auto; }
        .p2c-st {
          padding:8px 12px; border-radius:8px; margin-bottom:10px;
          font-weight:500; text-align:center;
        }
        .p2c-st.on { background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); }
        .p2c-st.pause { background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3); }
        .p2c-st.off { background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); }
        .p2c-st.limit { background:rgba(139,92,246,0.15); color:#a78bfa; border:1px solid rgba(139,92,246,0.3); }
        .p2c-stxt { text-align:center; margin-bottom:8px; font-size:12px; color:#888; }
        .p2c-progress {
          background:rgba(255,255,255,0.05); border-radius:8px; padding:8px 12px;
          margin-bottom:10px; text-align:center;
        }
        .p2c-progress-bar {
          height:6px; background:rgba(255,255,255,0.1); border-radius:3px;
          overflow:hidden; margin-top:6px;
        }
        .p2c-progress-fill {
          height:100%; background:#8b5cf6; border-radius:3px;
          transition:width 0.3s;
        }
        .p2c-cfg {
          background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);
          border-radius:8px; padding:10px; margin-bottom:10px;
        }
        .p2c-cfg-title {
          font-weight:600; font-size:12px; color:#aaa; margin-bottom:8px;
        }
        .p2c-row {
          display:flex; align-items:center; justify-content:space-between;
          margin-bottom:8px;
        }
        .p2c-row:last-child { margin-bottom:0; }
        .p2c-lbl { font-size:12px; color:#999; }
        .p2c-inp {
          width:70px; background:rgba(255,255,255,0.08); border:1px solid #555;
          color:#fff; padding:4px 8px; border-radius:6px; font-size:13px;
          text-align:center; outline:none;
        }
        .p2c-inp:focus { border-color:#8b5cf6; }
        .p2c-chk-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
        .p2c-chk {
          width:18px; height:18px; accent-color:#8b5cf6; cursor:pointer;
        }
        .p2c-btns { display:flex; gap:6px; margin-bottom:10px; }
        .p2c-btns button {
          flex:1; padding:10px; border-radius:8px; border:none;
          font-size:13px; font-weight:700; cursor:pointer; transition:all 0.2s;
        }
        .p2c-btn-start { background:#22c55e; color:#fff; }
        .p2c-btn-start:hover { background:#16a34a; }
        .p2c-btn-stop { background:#ef4444; color:#fff; }
        .p2c-btn-stop:hover { background:#dc2626; }
        .p2c-btn-approve {
          background:#22c55e; color:#fff; font-weight:700; width:100%;
          padding:12px; border:none; border-radius:8px; cursor:pointer;
          font-size:14px; margin-bottom:8px; display:none;
          animation:p2c-pulse 1.5s infinite;
        }
        .p2c-btn-approve:hover { background:#16a34a; }
        .p2c-btn-approve.vis { display:block; }
        @keyframes p2c-pulse {
          0%,100% { box-shadow:0 0 0 0 rgba(34,197,94,0.4); }
          50% { box-shadow:0 0 0 8px rgba(34,197,94,0); }
        }
        .p2c-pending {
          background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.3);
          border-radius:8px; padding:10px; margin-bottom:8px; font-size:12px;
          display:none;
        }
        .p2c-pending.vis { display:block; }
        .p2c-pending .lb { color:#888; font-size:11px; }
        .p2c-pending .vl { color:#4ade80; font-weight:600; }
        .p2c-ord-t { font-weight:600; margin-bottom:6px; color:#aaa; font-size:12px; }
        .p2c-ord {
          background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
          border-radius:8px; padding:8px 10px; margin-bottom:6px; font-size:12px;
        }
        .p2c-ord .tm { color:#888; font-size:11px; }
        .p2c-ord .am { color:#4ade80; font-weight:600; }
        .p2c-ord .dl { color:#facc15; font-size:11px; }
        .p2c-ord .rc { color:#8b5cf6; font-size:11px; }
        .p2c-hint {
          font-size:11px; color:#555; text-align:center;
          padding-top:6px; border-top:1px solid #333;
        }
        .p2c-reset {
          background:none; border:none; color:#666; cursor:pointer;
          font-size:11px; text-decoration:underline; margin-top:4px;
        }
        .p2c-reset:hover { color:#aaa; }
      </style>
      <div class="p2c-hdr">
        <span class="p2c-hdr-t">⚡ P2C Catcher v2</span>
        <div class="p2c-hdr-b">
          <button id="p2c-min" title="Свернуть">−</button>
          <button id="p2c-close" title="Скрыть">×</button>
        </div>
      </div>
      <div class="p2c-body">
        <div id="p2c-st" class="p2c-st off"></div>
        <div id="p2c-stxt" class="p2c-stxt"></div>

        <!-- PROGRESS -->
        <div id="p2c-progress" class="p2c-progress">
          <span id="p2c-caught">0</span> / <span id="p2c-target">1</span> заказов
          <div class="p2c-progress-bar"><div id="p2c-bar" class="p2c-progress-fill" style="width:0%"></div></div>
        </div>

        <!-- SETTINGS -->
        <div class="p2c-cfg">
          <div class="p2c-cfg-title">⚙️ Настройки</div>
          <div class="p2c-row">
            <span class="p2c-lbl">Поймать заказов:</span>
            <input id="p2c-limit" type="number" class="p2c-inp" min="1" max="999" value="1">
          </div>
          <div class="p2c-row">
            <span class="p2c-lbl">Задержка мин (мс):</span>
            <input id="p2c-dmin" type="number" class="p2c-inp" min="0" max="5000" value="50">
          </div>
          <div class="p2c-row">
            <span class="p2c-lbl">Задержка макс (мс):</span>
            <input id="p2c-dmax" type="number" class="p2c-inp" min="0" max="5000" value="150">
          </div>
          <div class="p2c-chk-row">
            <input id="p2c-snd" type="checkbox" class="p2c-chk" checked>
            <span class="p2c-lbl">Звук при поимке</span>
          </div>
          <div class="p2c-chk-row">
            <input id="p2c-pause" type="checkbox" class="p2c-chk" checked>
            <span class="p2c-lbl">Пауза после каждого заказа</span>
          </div>
        </div>

        <!-- ACTION BUTTONS -->
        <div class="p2c-btns">
          <button id="p2c-start" class="p2c-btn-start">▶️ СТАРТ</button>
          <button id="p2c-stop" class="p2c-btn-stop">⏹ СТОП</button>
        </div>

        <!-- PENDING ORDER + APPROVE -->
        <div id="p2c-pend" class="p2c-pending"></div>
        <button id="p2c-approve" class="p2c-btn-approve">▶️ ПРОДОЛЖИТЬ — Ловить следующий</button>

        <!-- ORDER LOG -->
        <div>
          <div class="p2c-ord-t">Последние заказы:</div>
          <div id="p2c-list"></div>
        </div>
        <div style="text-align:center">
          <button id="p2c-reset" class="p2c-reset">Сбросить счётчик</button>
        </div>
        <div class="p2c-hint">Ctrl+Shift+Q — вкл/выкл</div>
      </div>
    `;

    document.body.appendChild(p);
    panelEl = p;
    makeDraggable(p, p.querySelector('.p2c-hdr'));

    // Minimize / Close
    p.querySelector('#p2c-min').onclick = () => p.classList.toggle('min');
    p.querySelector('#p2c-close').onclick = () => { p.style.display = 'none'; };

    // Settings inputs → live-update state
    const $limit = p.querySelector('#p2c-limit');
    const $dmin = p.querySelector('#p2c-dmin');
    const $dmax = p.querySelector('#p2c-dmax');
    const $snd = p.querySelector('#p2c-snd');
    const $pause = p.querySelector('#p2c-pause');

    $limit.onchange = () => { state.orderLimit = Math.max(1, parseInt($limit.value) || 1); updatePanel(); };
    $dmin.onchange = () => { state.minDelay = Math.max(0, parseInt($dmin.value) || 0); };
    $dmax.onchange = () => { state.maxDelay = Math.max(state.minDelay, parseInt($dmax.value) || 400); };
    $snd.onchange = () => { state.soundEnabled = $snd.checked; };
    $pause.onchange = () => { /* just read at catch time */ };

    // START
    p.querySelector('#p2c-start').onclick = () => {
      // Read all settings from UI
      state.orderLimit = Math.max(1, parseInt($limit.value) || 1);
      state.minDelay = Math.max(0, parseInt($dmin.value) || 0);
      state.maxDelay = Math.max(state.minDelay, parseInt($dmax.value) || 400);
      state.soundEnabled = $snd.checked;
      // Reset counters for new run
      state.sessionCaught = 0;
      state.limitReached = false;
      state.waitingApproval = false;
      state.pendingOrder = null;
      state.inCooldown = false;
      state.enabled = true;
      state.autoClick = true;
      state.lastStatus = `👀 Ловим ${state.orderLimit} заказ(ов)...`;
      updatePanel();
    };

    // STOP
    p.querySelector('#p2c-stop').onclick = () => {
      state.enabled = false;
      state.autoClick = false;
      state.waitingApproval = false;
      state.inCooldown = false;
      state.lastStatus = '⏹ Остановлен пользователем';
      updatePanel();
    };

    // APPROVE / CONTINUE
    p.querySelector('#p2c-approve').onclick = () => {
      const $pauseChk = panelEl.querySelector('#p2c-pause');
      state.waitingApproval = false;
      state.pendingOrder = null;
      state.inCooldown = false;
      // If limit reached, reset for a new round with same settings
      if (state.limitReached) {
        state.sessionCaught = 0;
        state.limitReached = false;
      }
      state.lastStatus = `👀 Ловим ${state.orderLimit} заказ(ов)...`;
      updatePanel();
      playBeep();
    };

    // RESET counter
    p.querySelector('#p2c-reset').onclick = () => {
      state.sessionCaught = 0;
      state.limitReached = false;
      state.orders = [];
      state.lastStatus = '🔄 Счётчик сброшен';
      updatePanel();
    };

    updatePanel();
  }

  // ========================== UPDATE PANEL ==========================
  function updatePanel() {
    if (!panelEl) return;
    const stEl = panelEl.querySelector('#p2c-st');
    const stTxt = panelEl.querySelector('#p2c-stxt');

    // Status bar
    if (state.limitReached) {
      stEl.className = 'p2c-st limit';
      stEl.textContent = `⛔ ЛИМИТ — ${state.sessionCaught}/${state.orderLimit}`;
    } else if (state.waitingApproval) {
      stEl.className = 'p2c-st pause';
      stEl.textContent = '⏸️ ПАУЗА — Ждёт подтверждения';
    } else if (state.enabled && state.autoClick) {
      stEl.className = 'p2c-st on';
      stEl.textContent = '🟢 ЛОВИТ ЗАКАЗЫ';
    } else {
      stEl.className = 'p2c-st off';
      stEl.textContent = '🔴 НЕ АКТИВЕН';
    }
    stTxt.textContent = state.lastStatus;

    // Progress bar
    panelEl.querySelector('#p2c-caught').textContent = state.sessionCaught;
    panelEl.querySelector('#p2c-target').textContent = state.orderLimit;
    const pct = state.orderLimit > 0 ? Math.min(100, (state.sessionCaught / state.orderLimit) * 100) : 0;
    panelEl.querySelector('#p2c-bar').style.width = pct + '%';

    // Approve button + pending info
    const appBtn = panelEl.querySelector('#p2c-approve');
    const pendDiv = panelEl.querySelector('#p2c-pend');
    if (state.waitingApproval || state.limitReached) {
      appBtn.classList.add('vis');
      appBtn.textContent = state.limitReached
        ? '🔄 НОВЫЙ РАУНД — Ловить ещё'
        : '▶️ ПРОДОЛЖИТЬ — Ловить следующий';
      if (state.pendingOrder) {
        pendDiv.classList.add('vis');
        const o = state.pendingOrder;
        pendDiv.innerHTML = `
          <div style="text-align:center;margin-bottom:6px;font-weight:700;color:#facc15;">⏸️ Пойманный заказ #${state.sessionCaught}:</div>
          ${o.rub ? `<div><span class="lb">Сумма:</span> <span class="vl">${esc(o.rub)} ₽</span></div>` : ''}
          ${o.usdt ? `<div><span class="lb">USDT:</span> <span class="vl">${esc(o.usdt)} USDT</span></div>` : ''}
          ${o.recipient ? `<div><span class="lb">Получатель:</span> <span class="vl">${esc(o.recipient)}</span></div>` : ''}
          ${o.reward ? `<div><span class="lb">Награда:</span> <span class="vl">+${esc(o.reward)} USDT</span></div>` : ''}
        `;
      }
    } else {
      appBtn.classList.remove('vis');
      pendDiv.classList.remove('vis');
    }

    // Order list
    const listEl = panelEl.querySelector('#p2c-list');
    if (state.orders.length === 0) {
      listEl.innerHTML = '<div style="color:#555;text-align:center;padding:8px;">Пока нет заказов</div>';
    } else {
      listEl.innerHTML = state.orders.slice(0, 10).map(o => `
        <div class="p2c-ord">
          <span class="tm">${esc(o.time)}</span>
          ${o.rub ? ` — <span class="am">${esc(o.rub)} ₽</span>` : ''}
          ${o.usdt ? ` / <span class="am">${esc(o.usdt)} USDT</span>` : ''}
          ${o.catchDelay ? ` <span class="dl">(${o.catchDelay}мс)</span>` : ''}
          ${o.recipient ? `<br><span class="rc">→ ${esc(o.recipient)}</span>` : ''}
          ${o.reward ? ` <span style="color:#4ade80;">+${esc(o.reward)} USDT</span>` : ''}
        </div>
      `).join('');
    }
  }

  // ========================== DRAGGING ==========================
  function makeDraggable(el, handle) {
    let dragging = false, ox, oy;
    handle.onmousedown = (e) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    };
    document.onmousemove = (e) => {
      if (!dragging) return;
      el.style.left = Math.max(0, e.clientX - ox) + 'px';
      el.style.top = Math.max(0, e.clientY - oy) + 'px';
      el.style.right = 'auto';
    };
    document.onmouseup = () => { dragging = false; };
  }

  // ========================== KEYBOARD ==========================
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === TOGGLE_KEY) {
      e.preventDefault();
      if (panelEl) panelEl.style.display = panelEl.style.display === 'none' ? '' : '';
      state.enabled = !state.enabled;
      updatePanel();
    }
  });

  // ========================== INIT ==========================
  function init() {
    if (!document.body) { setTimeout(init, 200); return; }

    // Skip if on main telegram page (not mini-app) — only show panel on app.send.tg or if P2C content detected
    const url = window.location.href;
    const isMiniApp = url.includes('send.tg') || url.includes('crypt.bot') || url.includes('cryptobot');
    const isTelegram = url.includes('telegram.org') || url.includes('t.me');

    if (isTelegram && !isMiniApp) {
      // On main telegram — just watch iframes, don't show panel here
      console.log('[P2C Catcher] Main Telegram page — watching iframes only');
      watchIframes();
      return;
    }

    console.log('[P2C Catcher] Mini-app detected — initializing panel');
    createPanel();
    setupObserver(document.body);
    watchIframes();

    setInterval(() => {
      if (state.enabled && state.autoClick && !state.inCooldown && !state.waitingApproval && !state.limitReached) {
        scan();
      }
    }, SCAN_INTERVAL);

    setInterval(updatePanel, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
