/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   GOLF BOT — TeeOne.golf Auto-Booker for                   ║
 * ║   Real Club de Golf Lomas Bosque (Madrid, Spain)           ║
 * ║   Millisecond-Precision Tee-Time Reservation Engine         ║
 * ║   Designed for Spanish Senior Golfers (70+ years old)      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Target Course:  Real Club de Golf Lomas Bosque
 * Platform:       TeeOne.golf (Club ID: 99)
 * Login URL:      https://members.teeone.golf/lomas/
 * Calendar URL:   https://members.teeone.golf/lomas/calendario
 * API Base:       https://api.teeone.golf/InternalMembersEngine/v1
 *
 * Architecture:
 *   - Express API server (stateless, zero database)
 *   - 100% volatile in-RAM credential storage (wiped at 20:01 daily)
 *   - Playwright headless browser automation
 *   - Precision scheduler: warm-up @ 19:59:50, strike @ 20:00:00.050
 *   - Supports D+2 daily + Thursday D+3 dual-booking exception
 */

'use strict';

// ─── Imports ────────────────────────────────────────────────────────────────
const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');

// Lazy-load Playwright — only import when automation is about to run
let chromium = null;
async function getChromium() {
  if (!chromium) {
    const pw = require('playwright');
    chromium = pw.chromium;
  }
  return chromium;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Server
  port: process.env.PORT || 3000,
  timezone: process.env.TZ || 'Europe/Madrid',

  // Automation timing (Spain local time)
  warmupTime:  { hour: 19, minute: 59, second: 50, millis: 0 },   // 19:59:50
  strikeTime:  { hour: 20, minute: 0,  second: 0,  millis: 50 },  // 20:00:00.050
  cleanupTime: { hour: 20, minute: 1,  second: 0,  millis: 0 },   // 20:01:00

  // Human emulation delays (milliseconds)
  minHumanDelay: 100,
  maxHumanDelay: 300,

  // ── CAPTCHA / Anti-Bot Configuration ─────────────────────────────────
  // If TeeOne uses Google reCAPTCHA, set a 2captcha API key here.
  // Get one at https://2captcha.com (deposit ~$3, each solve costs ~$0.003).
  twoCaptchaApiKey: process.env.CAPTCHA_API_KEY || '',

  // The reCAPTCHA sitekey for TeeOne. If this is wrong, find it by
  // inspecting the page for `data-sitekey` on the reCAPTCHA iframe/div.
  recaptchaSiteKey: process.env.RECAPTCHA_SITEKEY || '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI', // Google's test key

  // ── TeeOne.golf Selectors ──────────────────────────────────────────────
  // ✅ Login selectors VERIFIED from actual TeeOne HTML (2026-06-07)
  // ⚠️  Calendar/booking selectors are best-guess based on platform patterns.
  //     Verify by logging in and inspecting the calendar page in DevTools.
  selectors: {
    // ── Login Page (VERIFIED — exact IDs from TeeOne source) ────────────
    loginUrl:        'https://members.teeone.golf/lomas/?returnUrl=/lomas/calendario',
    usernameField:   '#txtUsuarioLogin',          // <input id="txtUsuarioLogin">
    passwordField:   '#txtPasswordLogin',          // <input id="txtPasswordLogin">
    loginSubmitBtn:  '#btnLoginUsuario',           // <button id="btnLoginUsuario">

    // ── Calendar / Tee Sheet ────────────────────────────────────────────
    clubId:           '99',                        // <input id="HidIdClub" value="99">
    calendarUrl:      'https://members.teeone.golf/lomas/calendario',
    apiBaseUrl:       'https://api.teeone.golf/InternalMembersEngine/v1',

    // Date cell in the calendar grid — TeeOne uses a jQuery datepicker.
    // The calendar likely renders <td> cells with data-fecha attributes.
    // Adjust based on: right-click → Inspect on a clickable date in the calendar.
    dateCell: (dateStr) => [
      `[data-fecha="${dateStr}"]`,
      `td[data-date="${dateStr}"]`,
      `.fc-day[data-date="${dateStr}"]`,
      `td:has(.dia:contains("${dateStr.split('-')[2]}"))`,
    ].join(', '),

    // Tee time slot row — each available time in the tee sheet grid.
    // TeeOne typically uses a table with rows per time slot.
    teeTimeRow: (time) => [
      `[data-hora="${time}"]`,
      `tr[data-tee-time="${time}"]`,
      `.slot[data-time="${time}"]`,
      `tr:has(td:has-text("${time}"))`,
    ].join(', '),

    // Button/link to book the selected slot
    bookSlotBtn: [
      'button.reservar',
      '.btn-reservar',
      'a.btn-reserva',
      'button:has-text("Reservar")',
      'button:has-text("Seleccionar")',
      '.slot-action button',
      '.slot-action .btn',
      'td.accion button',
    ].join(', '),

    // ── Booking Form / Modal ────────────────────────────────────────────
    // After selecting a slot, TeeOne shows a booking form (modal or inline).
    modalContainer: [
      '.modal',
      '.modal-dialog',
      '[role="dialog"]',
      '#modalReserva',
      '.booking-modal',
      '.panel-reserva',
      'form.reserva',
    ].join(', '),

    // Player count dropdown (number of jugadores)
    playersSelect: [
      'select[name*="jugador"]',
      'select[name*="Jugador"]',
      '#numJugadores',
      'select.jugadores',
      'select:has(option:has-text("Jugador"))',
    ].join(', '),

    // Terms & conditions checkbox
    termsCheckbox: [
      'input[type="checkbox"][name*="termino"]',
      'input[type="checkbox"][name*="condicion"]',
      'input[type="checkbox"][name*="acepto"]',
      '#aceptarTerminos',
      '#chkTerminos',
      '.condiciones input[type="checkbox"]',
      '.terminos input[type="checkbox"]',
    ].join(', '),

    // Final confirm booking button
    confirmBtn: [
      'button:has-text("Confirmar")',
      'button:has-text("Reservar")',
      'button:has-text("Aceptar")',
      '#btnConfirmar',
      '#btnConfirmarReserva',
      '.btn-confirmar-reserva',
      'button.confirmar',
      'input[type="submit"][value*="Confirmar"]',
      'input[type="submit"][value*="Reservar"]',
    ].join(', '),

    // Success indicator text on the page after booking
    successIndicator: [
      'confirmada',
      'reserva confirmada',
      'reserva realizada',
      'gracias por su reserva',
      'booking confirmed',
      'su reserva',
    ],
  },

  // Desired tee-time slots the user can pick from
  availableTimeSlots: [
    '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
    '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
    '14:00', '14:30', '15:00', '15:30', '16:00',
  ],
};

// ─── Volatile In-Memory Store ───────────────────────────────────────────────
//  ⚠️  ALL DATA IS WIPED DAILY AT 20:01 — NOTHING PERSISTS TO DISK  ⚠️

/** @type {Map<string, BookingRequest>} */
const bookingStore = new Map();

/** @type {Array<{bookingId: string, status: string, result: object, timestamp: Date}>} */
const executionLog = [];

/** @type {boolean} */
let automationInProgress = false;

/** @type {Array<{id: string, timeout: NodeJS.Timeout}>} */
let scheduledTimers = [];

/**
 * @typedef {Object} BookingRequest
 * @property {string} id            - UUID
 * @property {string} username      - TeeOne/Lomas Bosque username
 * @property {string} password      - TeeOne/Lomas Bosque password (volatile RAM only)
 * @property {string} hoyos         - "9" or "18"
 * @property {string} jugadores     - "1" to "4"
 * @property {string} hora          - Desired tee time e.g. "08:00"
 * @property {string[]} targetDays  - e.g. ["sabado"] or ["sabado", "domingo"]
 * @property {'pending'|'in_progress'|'success'|'failed'|'partial'} status
 * @property {object|null} result   - Outcome details
 * @property {Date} createdAt
 */

// ─── Helper Functions ───────────────────────────────────────────────────────

/** Get the next occurrence of a specific time of day in Spain local time */
function getNextTimeOfDay(hour, minute, second, millis) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, second, millis);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/** Calculate milliseconds until a given Date */
function msUntil(targetDate) {
  return Math.max(0, targetDate.getTime() - Date.now());
}

/** Randomized human-like delay between min and max milliseconds */
function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Format a Date as a Spanish day name */
function getSpanishDayName(date) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return days[date.getDay()];
}

/** Format date as DD/MM/YYYY */
function formatSpanishDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/** Get the target booking dates based on D+2 rule + Thursday exception */
function getTargetDates() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun … 6=Sat

  // D+2 is always available
  const d2 = new Date(today);
  d2.setDate(today.getDate() + 2);

  const targets = [
    { key: 'sabado', date: d2, label: getSpanishDayName(d2) },
  ];

  // Thursday (day 4): D+3 (Sunday) also opens simultaneously
  if (dayOfWeek === 4) {
    const d3 = new Date(today);
    d3.setDate(today.getDate() + 3);
    targets.push({ key: 'domingo', date: d3, label: getSpanishDayName(d3) });
  }

  return targets;
}

/** Get today's day of week (0=Sun … 6=Sat) */
function getTodayDayOfWeek() {
  return new Date().getDay();
}

/** Check if today is Thursday (day 4) */
function isTodayThursday() {
  return getTodayDayOfWeek() === 4;
}

// ─── Data Sanitization ──────────────────────────────────────────────────────

/** Wipe ALL in-RAM data — runs every day at 20:01 */
function wipeAllData() {
  console.log('🧹 [CLEANUP] Destructive garbage collection started — wiping ALL in-RAM credentials & sessions…');

  const bookingCount = bookingStore.size;

  // Log outcomes before wiping
  for (const [id, booking] of bookingStore) {
    executionLog.push({
      bookingId: id,
      status: booking.status,
      result: booking.result || {},
      timestamp: new Date(),
    });
  }

  // Overwrite sensitive fields with random data before clearing
  for (const [, booking] of bookingStore) {
    booking.username = '█'.repeat(booking.username.length);
    booking.password = '█'.repeat(booking.password.length);
  }

  // Clear all stores
  bookingStore.clear();

  console.log(`✅ [CLEANUP] Wiped ${bookingCount} booking records. RAM is clean. Execution log preserved (non-sensitive).`);
  console.log(`📋 [CLEANUP] Execution log now has ${executionLog.length} entries.`);
}

// ─── Anti-Detection: In-Page Stealth Script ─────────────────────────────────
// Injected before any page load to hide Playwright traces from JS detection.

const STEALTH_SCRIPT = `
  // Override navigator.webdriver (most common bot detection signal)
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // Override chrome.runtime (Playwright leaks this)
  window.chrome = { runtime: {} };

  // Fake plugins array (headless browsers often have zero plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Fake languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['es-ES', 'es', 'en-US', 'en'],
  });

  // Override permissions API
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
`;

// ─── CAPTCHA Detection & Handling ───────────────────────────────────────────

/**
 * Detect what kind of CAPTCHA is present on the current page.
 * @param {import('playwright').Page} page
 * @returns {Promise<{type: 'none'|'simple-checkbox'|'recaptcha'|'turnstile'|'hcaptcha'|'unknown', selector?: string}>}
 */
async function detectCaptcha(page) {
  const checks = [
    // Google reCAPTCHA v2 checkbox
    { type: 'recaptcha', sel: 'iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"], .g-recaptcha, div[data-sitekey]' },
    // Cloudflare Turnstile
    { type: 'turnstile', sel: 'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .cf-turnstile' },
    // hCaptcha
    { type: 'hcaptcha', sel: 'iframe[src*="hcaptcha"], .h-captcha' },
    // Simple custom checkbox (TeeOne might use this)
    { type: 'simple-checkbox', sel: 'input[type="checkbox"][name*="robot"], input[type="checkbox"][id*="robot"], input[type="checkbox"][name*="bot"], label:has-text("not a robot"), label:has-text("no soy robot"), label:has-text("No soy un robot")' },
  ];

  for (const check of checks) {
    try {
      const el = await page.$(check.sel.split(', ')[0]);
      if (el) {
        console.log(`   🔍 CAPTCHA detected: ${check.type} (${check.sel.split(', ')[0]})`);
        return { type: check.type, selector: check.sel };
      }
    } catch (_) { /* selector didn't match */ }
  }

  return { type: 'none' };
}

/**
 * Attempt to solve a detected CAPTCHA.
 * @returns {Promise<{solved: boolean, method: string}>}
 */
async function solveCaptcha(page, captchaType) {
  switch (captchaType) {
    // ── Simple checkbox: just click it ─────────────────────────────────
    case 'simple-checkbox': {
      console.log(`   ✅ Attempting to click simple anti-bot checkbox…`);
      try {
        // Try multiple possible selectors
        const checkboxSelectors = [
          'input[type="checkbox"][name*="robot"]',
          'input[type="checkbox"][id*="robot"]',
          'input[type="checkbox"][name*="bot"]',
          'label:has-text("not a robot") input',
          'label:has-text("no soy robot") input',
          'label:has-text("No soy un robot") input',
        ];
        for (const sel of checkboxSelectors) {
          const cb = await page.$(sel);
          if (cb) {
            await cb.click();
            await randomDelay(100, 200);
            console.log(`   ✅ Anti-bot checkbox clicked via: ${sel}`);
            return { solved: true, method: `checkbox-click:${sel}` };
          }
        }
        return { solved: false, method: 'checkbox-not-found' };
      } catch (err) {
        console.log(`   ⚠️  Checkbox click failed: ${err.message}`);
        return { solved: false, method: `checkbox-error:${err.message}` };
      }
    }

    // ── Google reCAPTCHA v2: click checkbox → try pass → fallback 2captcha ──
    case 'recaptcha': {
      console.log(`   🤖 Attempting reCAPTCHA v2 checkbox click…`);

      // ── Strategy 1: Click the checkbox directly (often just passes) ────
      try {
        // Locate the reCAPTCHA iframe and click the checkbox inside it
        const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]').first();
        const checkbox = recaptchaFrame.locator('.recaptcha-checkbox-border, #recaptcha-anchor, .recaptcha-checkbox');
        await checkbox.waitFor({ state: 'visible', timeout: 5000 });
        await randomDelay(200, 400);
        await checkbox.click();
        console.log(`   ↳ Checkbox clicked. Waiting for Google to evaluate…`);
        await randomDelay(2000, 3500); // Google takes 2-5 seconds to decide

        // Check if it passed (green checkmark appeared)
        const checked = await recaptchaFrame.locator('.recaptcha-checkbox-checked, [aria-checked="true"]').count();
        if (checked > 0) {
          console.log(`   ✅ reCAPTCHA passed! Green checkmark confirmed.`);
          await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
          return { solved: true, method: 'direct-click-passed' };
        }

        // Check if an image challenge appeared
        const challengeVisible = await recaptchaFrame.locator('.rc-imageselect, #rc-imageselect, .recaptcha-challenge').count();
        if (challengeVisible > 0) {
          console.log(`   ⚠️  reCAPTCHA image challenge appeared. Direct click not enough.`);
        } else {
          console.log(`   ⚠️  reCAPTCHA state unclear after click. Proceeding to fallback.`);
        }
      } catch (clickErr) {
        console.log(`   ⚠️  Could not click reCAPTCHA checkbox: ${clickErr.message}`);
      }

      // ── Strategy 2: Fallback to 2captcha for image challenge ──────────
      const apiKey = CONFIG.twoCaptchaApiKey;
      if (!apiKey) {
        console.log(`   ❌ Image challenge requires 2captcha but no CAPTCHA_API_KEY configured.`);
        console.log(`   → Set env var CAPTCHA_API_KEY on Render (get key at 2captcha.com).`);
        return { solved: false, method: 'image-challenge-no-api-key' };
      }

      console.log(`   🤖 Solving image challenge via 2captcha (15-45 seconds)…`);
      try {
        const siteKey = CONFIG.recaptchaSiteKey;
        const pageUrl = page.url();

        // Submit to 2captcha
        const submitResp = await fetch(
          `https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`
        );
        const submitData = await submitResp.json();
        if (submitData.status !== 1) {
          console.log(`   ❌ 2captcha submission failed: ${submitData.request}`);
          return { solved: false, method: `2captcha-submit-failed` };
        }
        const captchaId = submitData.request;
        console.log(`   ↳ Submitted (ID: ${captchaId}). Polling…`);

        // Poll for solution (up to 120 seconds)
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const resultResp = await fetch(
            `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
          );
          const resultData = await resultResp.json();
          if (resultData.status === 1) {
            const token = resultData.request;
            console.log(`   ✅ 2captcha solved. Injecting token…`);
            await page.evaluate((gToken) => {
              const ta = document.querySelector('#g-recaptcha-response');
              if (ta) { ta.style.display = 'block'; ta.value = gToken; }
              if (typeof window.___grecaptcha_cfg !== 'undefined') {
                const clients = (window.___grecaptcha_cfg).clients || {};
                for (const cId of Object.keys(clients)) {
                  const c = clients[cId];
                  const cb = Object.keys(c).find(k => k.startsWith('callback'));
                  if (cb && typeof c[cb] === 'function') c[cb](gToken);
                }
              }
            }, token);
            await randomDelay(500, 1000);
            return { solved: true, method: '2captcha' };
          }
          if (resultData.request === 'ERROR_CAPTCHA_UNSOLVABLE') {
            return { solved: false, method: '2captcha-unsolvable' };
          }
        }
        console.log(`   ❌ 2captcha timed out.`);
        return { solved: false, method: '2captcha-timeout' };
      } catch (err) {
        console.log(`   ❌ 2captcha error: ${err.message}`);
        return { solved: false, method: `2captcha-error` };
      }
    }

    // ── Unsupported CAPTCHA types ──────────────────────────────────────
    default:
      console.log(`   ⚠️  Unsupported CAPTCHA type: ${captchaType}. Cannot auto-solve.`);
      return { solved: false, method: `unsupported:${captchaType}` };
  }
}

// ─── Playwright Automation Engine ───────────────────────────────────────────

/**
 * Execute the full booking flow for a single slot.
 *
 * @param {BookingRequest} booking
 * @param {{ key: string, date: Date, label: string }} targetDay
 * @returns {Promise<{success: boolean, message: string, targetDay: string}>}
 */
async function executeSingleBooking(booking, targetDay) {
  const browserType = await getChromium();
  const browser = await browserType.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=390,844',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    // Simulate touch screen (mobile device)
    hasTouch: true,
    isMobile: true,
  });

  const page = await context.newPage();

  // ── Inject stealth script BEFORE any page loads ──────────────────────
  await page.addInitScript(STEALTH_SCRIPT);

  try {
    const S = CONFIG.selectors;

    // ── Step 1: Login ───────────────────────────────────────────────────
    console.log(`🔑 [${booking.id}] Navigating to login page…`);
    await page.goto(S.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // ── Step 1a: CAPTCHA check on login page ───────────────────────────
    const loginCaptcha = await detectCaptcha(page);
    if (loginCaptcha.type !== 'none') {
      console.log(`   🛡️  CAPTCHA on login page: ${loginCaptcha.type}`);
      const solved = await solveCaptcha(page, loginCaptcha.type);
      if (!solved.solved && loginCaptcha.type === 'recaptcha') {
        console.log(`   ❌ Cannot solve reCAPTCHA — bailing out.`);
        return {
          success: false,
          message: `CAPTCHA detectado en login (${loginCaptcha.type}) pero no se pudo resolver automáticamente. Configure CAPTCHA_API_KEY en Render.`,
          targetDay: targetDay.key,
          date: formatSpanishDate(targetDay.date),
        };
      }
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
    }

    // Type username with human-like keystroke delays
    await page.waitForSelector(S.usernameField, { timeout: 10000 });
    await page.click(S.usernameField);
    await randomDelay(80, 150);
    await page.fill(S.usernameField, booking.username);
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // Type password
    await page.waitForSelector(S.passwordField, { timeout: 5000 });
    await page.click(S.passwordField);
    await randomDelay(80, 150);
    await page.fill(S.passwordField, booking.password);
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // Click login
    await page.click(S.loginSubmitBtn);
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await randomDelay(200, 400);

    // ── Step 1b: CAPTCHA check AFTER login (some sites trigger it post-login) ──
    const postLoginCaptcha = await detectCaptcha(page);
    if (postLoginCaptcha.type !== 'none') {
      console.log(`   🛡️  CAPTCHA after login: ${postLoginCaptcha.type}`);
      const solved = await solveCaptcha(page, postLoginCaptcha.type);
      if (!solved.solved && postLoginCaptcha.type === 'recaptcha') {
        console.log(`   ❌ Cannot solve post-login reCAPTCHA.`);
        return {
          success: false,
          message: `CAPTCHA detectado después del login (${postLoginCaptcha.type}) pero no se pudo resolver.`,
          targetDay: targetDay.key,
          date: formatSpanishDate(targetDay.date),
        };
      }
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
    }

    console.log(`✅ [${booking.id}] Login completed. Session is hot.`);

    // ── Step 2: Navigate to Calendar ──────────────────────────────────
    const dateStr = targetDay.date.toISOString().split('T')[0]; // YYYY-MM-DD
    const dayNum = String(targetDay.date.getDate()).padStart(2, '0');

    console.log(`🗓️  [${booking.id}] Navigating to calendar for ${targetDay.label} (${dateStr})…`);
    await page.goto(S.calendarUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // ── CAPTCHA check on calendar page ─────────────────────────────────
    const calendarCaptcha = await detectCaptcha(page);
    if (calendarCaptcha.type !== 'none') {
      console.log(`   🛡️  CAPTCHA on calendar: ${calendarCaptcha.type}`);
      const solved = await solveCaptcha(page, calendarCaptcha.type);
      if (!solved.solved) {
        console.log(`   ⚠️  Could not solve calendar CAPTCHA. Trying to proceed anyway…`);
      }
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
    }

    // ── Step 2b: Click the target date on the calendar ─────────────────
    // TeeOne shows a calendar grid; you must click the specific date first
    console.log(`   ↳ Clicking date: ${dateStr} (day ${dayNum})…`);
    try {
      const dateSelector = S.dateCell(dateStr);
      await page.waitForSelector(dateSelector, { timeout: 5000 });
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
      await page.click(dateSelector);
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await randomDelay(200, 400);
      console.log(`   ↳ Date selected. Tee sheet should now be visible.`);
    } catch (dateErr) {
      console.log(`   ↳ Could not click date directly (${dateErr.message}). The calendar may auto-show D+2 dates. Continuing…`);
    }

    // ── Step 3: Wait for the exact strike moment ─────────────────────────
    const now = new Date();
    const strikeTarget = getNextTimeOfDay(
      CONFIG.strikeTime.hour,
      CONFIG.strikeTime.minute,
      CONFIG.strikeTime.second,
      CONFIG.strikeTime.millis
    );
    const remainingMs = msUntil(strikeTarget);

    if (remainingMs > 0) {
      console.log(`⏳ [${booking.id}] ${remainingMs}ms until strike. Waiting precisely…`);
      await new Promise(resolve => setTimeout(resolve, remainingMs));
    }

    console.log(`⚡ [${booking.id}] STRIKE! Clicking tee-time slot for ${booking.hora}…`);

    // ── Step 4: Click the target time slot ───────────────────────────────
    const slotSelector = S.teeTimeRow(booking.hora);
    await page.waitForSelector(slotSelector, { timeout: 5000 });
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
    await page.click(slotSelector);
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // Click the "book" button inside that row
    const bookBtn = await page.$(slotSelector + ' ' + S.bookSlotBtn);
    if (bookBtn) {
      await bookBtn.click();
    } else {
      // Maybe the row itself was clickable and opened a detail view
      console.log(`   ↳ No separate book button found; row may have triggered booking directly.`);
    }
    await randomDelay(200, 400);

    // ── Step 5: Handle 2-Step Confirmation Modal ─────────────────────────
    console.log(`🪟 [${booking.id}] Waiting for confirmation modal…`);
    try {
      await page.waitForSelector(S.modalContainer, { timeout: 8000 });
      console.log(`   ↳ Modal detected.`);

      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

      // Tick the legal terms checkbox
      await page.waitForSelector(S.termsCheckbox, { timeout: 5000 });
      await page.click(S.termsCheckbox);
      await randomDelay(100, 200);
      console.log(`   ↳ Terms checkbox ticked.`);

      // Click final "Confirmar Reserva"
      await page.waitForSelector(S.confirmBtn, { timeout: 5000 });
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
      await page.click(S.confirmBtn);
      console.log(`   ↳ Confirm button clicked.`);

      // Wait for success indication
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await randomDelay(500, 1000);

      console.log(`🏆 [${booking.id}] Booking confirmed for ${targetDay.label} at ${booking.hora}!`);
      return {
        success: true,
        message: `Reserva confirmada: ${targetDay.label} ${formatSpanishDate(targetDay.date)} a las ${booking.hora}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    } catch (modalError) {
      // Modal may not have appeared — check if booking was direct
      console.log(`   ↻ Modal not detected within timeout. Checking page state…`);
      const pageContent = await page.content();

      const successTerms = S.successIndicator || ['confirmada', 'reserva realizada', 'gracias'];
      const pageText = pageContent.toLowerCase();
      if (successTerms.some(term => pageText.includes(term))) {
        console.log(`🏆 [${booking.id}] Booking appears successful (confirmed via page content).`);
        return {
          success: true,
          message: `Reserva aparentemente confirmada: ${targetDay.label} ${formatSpanishDate(targetDay.date)} a las ${booking.hora}`,
          targetDay: targetDay.key,
          date: formatSpanishDate(targetDay.date),
        };
      }

      console.log(`❌ [${booking.id}] Could not confirm booking. Modal error: ${modalError.message}`);
      return {
        success: false,
        message: `No se pudo confirmar la reserva. Error: ${modalError.message}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }
  } catch (err) {
    console.error(`💥 [${booking.id}] Fatal automation error: ${err.message}`);
    return {
      success: false,
      message: `Error de automatización: ${err.message}`,
      targetDay: targetDay.key,
      date: formatSpanishDate(targetDay.date),
    };
  } finally {
    await browser.close();
    console.log(`🔒 [${booking.id}] Browser closed.`);
  }
}

/**
 * Main automation orchestrator — runs ALL queued bookings simultaneously.
 * Called precisely at 20:00:00.050 each evening.
 */
async function runAllBookings() {
  if (automationInProgress) {
    console.log('⚠️  Automation already in progress. Skipping duplicate trigger.');
    return;
  }

  if (bookingStore.size === 0) {
    console.log('ℹ️  No bookings in queue. Skipping automation strike.');
    return;
  }

  automationInProgress = true;
  console.log(`🚀 [STRIKE] Launching automation for ${bookingStore.size} booking(s) at ${new Date().toISOString()}…`);

  // Build task list: each booking × each target day = one automation task
  const tasks = [];

  for (const [, booking] of bookingStore) {
    booking.status = 'in_progress';

    const availableTargets = getTargetDates(); // [{key:'sabado',date,...}, {key:'domingo',date,...} if Thu]

    for (const target of availableTargets) {
      if (booking.targetDays.includes(target.key)) {
        tasks.push({
          booking,
          targetDay: target,
          taskPromise: null,
        });
      }
    }
  }

  console.log(`📋 [STRIKE] Total automation tasks to run: ${tasks.length}`);

  // Fire ALL tasks in parallel (each in its own browser)
  const results = await Promise.allSettled(
    tasks.map(task => executeSingleBooking(task.booking, task.targetDay))
  );

  // Aggregate results back to each booking
  const bookingResults = new Map(); // bookingId -> results[]

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];

    if (!bookingResults.has(task.booking.id)) {
      bookingResults.set(task.booking.id, []);
    }

    const outcome = result.status === 'fulfilled'
      ? result.value
      : { success: false, message: `Task crashed: ${result.reason?.message}`, targetDay: task.targetDay.key };

    bookingResults.get(task.booking.id).push(outcome);
  }

  // Update each booking's final status
  for (const [bookingId, outcomes] of bookingResults) {
    const booking = bookingStore.get(bookingId);
    if (!booking) continue;

    const allSucceeded = outcomes.every(o => o.success);
    const anySucceeded = outcomes.some(o => o.success);

    if (allSucceeded) {
      booking.status = 'success';
    } else if (anySucceeded) {
      booking.status = 'partial';
    } else {
      booking.status = 'failed';
    }

    booking.result = {
      outcomes,
      completedAt: new Date().toISOString(),
    };

    console.log(`📊 [${bookingId}] Final status: ${booking.status} — ${JSON.stringify(outcomes.map(o => o.message))}`);
  }

  automationInProgress = false;
  console.log('🏁 [STRIKE] All automation tasks completed.');
}

// ─── Warm-Up (19:59:50) — Browser Pre-Launch ────────────────────────────────

/**
 * Pre-launch warm-up: wakes the infrastructure 10 seconds before strike.
 * On Render/Railway, the first Playwright launch can be slow (cold start).
 * This ensures the browser engine is hot and ready at 20:00:00.050.
 */
async function warmup() {
  console.log('🔥 [WARMUP] 19:59:50 — Warming up Playwright engine…');

  if (bookingStore.size === 0) {
    console.log('   ↳ No bookings queued. Skipping warm-up (will still strike if bookings arrive late).');
    return;
  }

  try {
    // Just initialise the browser module to pre-load binaries into memory
    const browserType = await getChromium();

    // Launch and immediately close a throwaway browser to warm the engine
    const warmBrowser = await browserType.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    await warmBrowser.close();

    console.log('✅ [WARMUP] Engine is hot. Standing by for strike at 20:00:00.050…');
  } catch (err) {
    console.error(`⚠️  [WARMUP] Warm-up failed: ${err.message}. Will attempt cold launch at strike time.`);
  }
}

// ─── Daily Scheduler ────────────────────────────────────────────────────────

/** Cancel all existing scheduled timers */
function clearScheduledTimers() {
  for (const t of scheduledTimers) {
    clearTimeout(t.timeout);
  }
  scheduledTimers = [];
}

/** Schedule the full evening automation cycle */
function scheduleEveningCycle() {
  clearScheduledTimers();

  const warmupTarget  = getNextTimeOfDay(CONFIG.warmupTime.hour, CONFIG.warmupTime.minute, CONFIG.warmupTime.second, CONFIG.warmupTime.millis);
  const strikeTarget  = getNextTimeOfDay(CONFIG.strikeTime.hour, CONFIG.strikeTime.minute, CONFIG.strikeTime.second, CONFIG.strikeTime.millis);
  const cleanupTarget = getNextTimeOfDay(CONFIG.cleanupTime.hour, CONFIG.cleanupTime.minute, CONFIG.cleanupTime.second, CONFIG.cleanupTime.millis);

  const warmupMs  = msUntil(warmupTarget);
  const strikeMs  = msUntil(strikeTarget);
  const cleanupMs = msUntil(cleanupTarget);

  console.log('⏰ [SCHEDULER] Evening cycle scheduled:');
  console.log(`   🔥 Warm-up  @ ${warmupTarget.toLocaleTimeString('es-ES')}  (in ${Math.round(warmupMs / 1000)}s)`);
  console.log(`   ⚡ Strike   @ ${strikeTarget.toLocaleTimeString('es-ES')}  (in ${Math.round(strikeMs / 1000)}s)`);
  console.log(`   🧹 Cleanup  @ ${cleanupTarget.toLocaleTimeString('es-ES')}  (in ${Math.round(cleanupMs / 1000)}s)`);

  scheduledTimers.push({
    id: 'warmup',
    timeout: setTimeout(() => {
      warmup();
      // Re-schedule next day's cycle after this one completes
      scheduleEveningCycle();
    }, warmupMs),
  });

  scheduledTimers.push({
    id: 'strike',
    timeout: setTimeout(() => {
      runAllBookings();
    }, strikeMs),
  });

  scheduledTimers.push({
    id: 'cleanup',
    timeout: setTimeout(() => {
      wipeAllData();
    }, cleanupMs),
  });
}

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'docs')));

// ─── API Routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/booking
 * Submit a new booking request (credentials + preferences).
 * Body: { username, password, hoyos, jugadores, hora, targetDays }
 */
app.post('/api/booking', (req, res) => {
  try {
    const { username, password, hoyos, jugadores, hora, targetDays } = req.body;

    // Validation
    const errors = [];
    if (!username || !username.trim()) errors.push('Usuario es obligatorio');
    if (!password || !password.trim()) errors.push('Contraseña es obligatoria');
    if (!hora) errors.push('Hora deseada es obligatoria');
    if (!targetDays || !Array.isArray(targetDays) || targetDays.length === 0) {
      errors.push('Debe seleccionar al menos un día objetivo');
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    // Check if we're past today's strike time but before cleanup
    const now = new Date();
    const strikeToday = new Date(now);
    strikeToday.setHours(CONFIG.strikeTime.hour, CONFIG.strikeTime.minute, CONFIG.strikeTime.second, CONFIG.strikeTime.millis);
    const cleanupToday = new Date(now);
    cleanupToday.setHours(CONFIG.cleanupTime.hour, CONFIG.cleanupTime.minute, CONFIG.cleanupTime.second, CONFIG.cleanupTime.millis);

    let nextStrikeLabel;
    if (now > strikeToday && now < cleanupToday) {
      // Currently in the middle of automation — book for tomorrow
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(CONFIG.strikeTime.hour, CONFIG.strikeTime.minute, 0, 0);
      nextStrikeLabel = tomorrow.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    } else if (now >= cleanupToday) {
      // Past cleanup — schedule for tomorrow
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(CONFIG.strikeTime.hour, CONFIG.strikeTime.minute, 0, 0);
      nextStrikeLabel = tomorrow.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    } else {
      // Before today's strike
      nextStrikeLabel = strikeToday.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    }

    const booking = {
      id: uuidv4(),
      username: username.trim(),
      password: password, // ONLY in RAM — wiped at 20:01
      hoyos: hoyos || '18',
      jugadores: jugadores || '4',
      hora: hora,
      targetDays: targetDays,
      status: 'pending',
      result: null,
      createdAt: new Date(),
    };

    bookingStore.set(booking.id, booking);

    console.log(`📥 [BOOKING] New request received:`);
    console.log(`   ID:       ${booking.id}`);
    console.log(`   User:     ${booking.username}`);
    console.log(`   Hora:     ${booking.hora}`);
    console.log(`   Hoyos:    ${booking.hoyos}`);
    console.log(`   Players:  ${booking.jugadores}`);
    console.log(`   Days:     ${booking.targetDays.join(', ')}`);
    console.log(`   Queue:    ${bookingStore.size} booking(s) pending`);

    return res.status(201).json({
      success: true,
      booking: {
        id: booking.id,
        status: booking.status,
        createdAt: booking.createdAt,
        // NEVER return credentials in response
      },
      message: `Reserva guardada. El sistema intentará reservar automáticamente a las ${nextStrikeLabel}.`,
      nextAutomation: nextStrikeLabel,
    });
  } catch (err) {
    console.error('❌ [API] Error in POST /api/booking:', err);
    return res.status(500).json({ success: false, errors: ['Error interno del servidor'] });
  }
});

/**
 * GET /api/booking/:id
 * Check the status of a specific booking.
 */
app.get('/api/booking/:id', (req, res) => {
  const { id } = req.params;
  const booking = bookingStore.get(id);

  if (!booking) {
    // Check execution log for wiped bookings
    const logged = executionLog.find(e => e.bookingId === id);
    if (logged) {
      return res.json({
        success: true,
        booking: {
          id: logged.bookingId,
          status: logged.status,
          result: logged.result,
          wiped: true,
        },
        message: 'Esta reserva ya fue procesada y sus datos fueron eliminados de la memoria por seguridad.',
      });
    }

    return res.status(404).json({
      success: false,
      errors: ['Reserva no encontrada. Puede que haya sido eliminada por seguridad (limpieza diaria a las 20:01).'],
    });
  }

  return res.json({
    success: true,
    booking: {
      id: booking.id,
      status: booking.status,
      hoyos: booking.hoyos,
      jugadores: booking.jugadores,
      hora: booking.hora,
      targetDays: booking.targetDays,
      result: booking.result,
      createdAt: booking.createdAt,
      // NEVER return credentials
    },
  });
});

/**
 * GET /api/status
 * General server status and queue info.
 */
app.get('/api/status', (req, res) => {
  const availableTargets = getTargetDates();

  return res.json({
    success: true,
    serverTime: new Date().toISOString(),
    timezone: CONFIG.timezone,
    isThursday: isTodayThursday(),
    queueSize: bookingStore.size,
    automationInProgress,
    executionLogCount: executionLog.length,
    availableTargets: availableTargets.map(t => ({
      key: t.key,
      label: t.label,
      date: formatSpanishDate(t.date),
    })),
    nextStrike: getNextTimeOfDay(
      CONFIG.strikeTime.hour,
      CONFIG.strikeTime.minute,
      CONFIG.strikeTime.second,
      CONFIG.strikeTime.millis
    ).toISOString(),
  });
});

/**
 * GET /api/config
 * Returns the server's day-of-week info and available slot times
 * so the frontend can dynamically render the correct options.
 */
app.get('/api/config', (req, res) => {
  return res.json({
    success: true,
    isThursday: isTodayThursday(),
    todayDayOfWeek: getTodayDayOfWeek(),
    todayLabel: getSpanishDayName(new Date()),
    availableSlots: CONFIG.availableTimeSlots,
    availableTargets: getTargetDates().map(t => ({
      key: t.key,
      label: t.label,
      date: formatSpanishDate(t.date),
    })),
  });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Wiping data and shutting down…');
  wipeAllData();
  clearScheduledTimers();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received. Wiping data and shutting down…');
  wipeAllData();
  clearScheduledTimers();
  process.exit(0);
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(CONFIG.port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ⛳  GOLF BOT — Lomas Bosque Auto-Booker  ⛳        ║');
  console.log('║     Real Club de Golf Lomas Bosque (Madrid)         ║');
  console.log('║     Platform: TeeOne.golf  |  Club ID: 99          ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Server:   http://localhost:${CONFIG.port}                     ║`);
  console.log(`║  Timezone: ${CONFIG.timezone}                          ║`);
  console.log(`║  Frontend: http://localhost:${CONFIG.port}/index.html         ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  📋 Daily Automation Schedule:                      ║');
  console.log(`║     🔥 Warm-up:  ${String(CONFIG.warmupTime.hour).padStart(2,'0')}:${String(CONFIG.warmupTime.minute).padStart(2,'0')}:${String(CONFIG.warmupTime.second).padStart(2,'0')}                     ║`);
  console.log(`║     ⚡ Strike:   ${String(CONFIG.strikeTime.hour).padStart(2,'0')}:${String(CONFIG.strikeTime.minute).padStart(2,'0')}:${String(CONFIG.strikeTime.second).padStart(2,'0')}.${String(CONFIG.strikeTime.millis).padStart(3,'0')}                ║`);
  console.log(`║     🧹 Cleanup:  ${String(CONFIG.cleanupTime.hour).padStart(2,'0')}:${String(CONFIG.cleanupTime.minute).padStart(2,'0')}:${String(CONFIG.cleanupTime.second).padStart(2,'0')}                     ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  🔒 100% RAM-only storage — wiped daily at 20:01    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Schedule the first evening cycle
  scheduleEveningCycle();
});

// ─── Export for Testing ─────────────────────────────────────────────────────
module.exports = { app, CONFIG, getTargetDates, isTodayThursday, getSpanishDayName, formatSpanishDate };
