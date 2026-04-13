// =====================================================
// login.js — One-time interactive login to Telegram Web
// =====================================================
// Run this ONCE on initial setup to log in:
//   node login.js
//
// This opens a VISIBLE browser so you can:
//   1. Scan QR code or enter phone number
//   2. Complete 2FA if needed
//   3. Navigate to the P2C orders page
//   4. Press Ctrl+C when done — session is saved
// =====================================================

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || './chrome-data');

(async () => {
  // Ensure data dir exists
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('='.repeat(60));
  console.log('  P2C Catcher — Telegram Login');
  console.log('='.repeat(60));
  console.log('');
  console.log('A browser window will open. Log in to Telegram Web:');
  console.log('  1. Scan QR code with your Telegram app');
  console.log('  2. Or enter your phone number');
  console.log('  3. Complete 2FA if prompted');
  console.log('  4. Navigate to: https://app.send.tg/p2c/orders');
  console.log('  5. When done, press Ctrl+C here to save session');
  console.log('');
  console.log(`Session will be saved to: ${USER_DATA_DIR}`);
  console.log('='.repeat(60));

  const browser = await puppeteer.launch({
    headless: false,  // always visible for login
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,720',
      // If running on VPS with VNC:
      ...(process.env.VNC_DISPLAY ? [`--display=${process.env.VNC_DISPLAY}`] : []),
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );

  const targetUrl = process.env.P2C_URL || 'https://app.send.tg/p2c/orders';
  console.log(`\nOpening: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('\n✅ Browser is open. Complete login, then press Ctrl+C to save.\n');

  // Keep alive until Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\nSaving session and closing...');
    await browser.close();
    console.log('✅ Session saved. You can now run: npm start');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
})();
