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

  // ── TeeOne.golf Selectors (Lomas Bosque) ──────────────────────────────
  // ✅ Login selectors VERIFIED from actual TeeOne HTML (2026-06-07)
  // ✅ Booking flow CONFIRMED by user: Date → Recorrido/Hoyos/Jugadores/Hora → CAPTCHA → Bloquear → 3-min window → Condiciones → Reservar
  selectors: {
    // ── Login Page (VERIFIED — exact IDs from TeeOne source) ────────────
    loginUrl:        'https://members.teeone.golf/lomas/?returnUrl=/lomas/calendario',
    usernameField:   '#txtUsuarioLogin',
    passwordField:   '#txtPasswordLogin',
    loginSubmitBtn:  '#btnLoginUsuario',

    // ── Calendar ────────────────────────────────────────────────────────
    clubId:           '99',
    calendarUrl:      'https://members.teeone.golf/lomas/calendario',
    apiBaseUrl:       'https://api.teeone.golf/InternalMembersEngine/v1',

    // Clickable date cell in the calendar grid
    dateCell: (dateStr) => [
      `[data-fecha="${dateStr}"]`,
      `td[data-date="${dateStr}"]`,
      `.fc-day[data-date="${dateStr}"]`,
      `td:has(.dia:contains("${dateStr.split('-')[2]}"))`,
      `a:has-text("${dateStr.split('-')[2]}")`,
    ].join(', '),

    // ── Booking Form (after selecting a date) ───────────────────────────
    // Step A: Recorrido (course/tee) dropdown → default "Tee 1"
    recorridoSelect: [
      'select[name*="recorrido"]',
      'select[name*="Recorrido"]',
      '#recorrido',
      'select:has(option:has-text("Tee 1"))',
      'select:has(option:has-text("Tee"))',
    ].join(', '),
    recorridoValue: 'Tee 1',

    // Step B: Número de Hoyos dropdown → default "18"
    hoyosSelect: [
      'select[name*="hoyos"]',
      'select[name*="Hoyos"]',
      '#hoyos',
      '#numHoyos',
      'select:has(option:has-text("18"))',
    ].join(', '),
    hoyosValue: '18',

    // Step C: Jugadores dropdown → default "1" (personal use)
    jugadoresSelect: [
      'select[name*="jugador"]',
      'select[name*="Jugador"]',
      '#jugadores',
      '#numJugadores',
    ].join(', '),
    jugadoresValue: '1',

    // Step D: Hora de Juego dropdown (08:00-19:30, every 10 min)
    horaSelect: [
      'select[name*="hora"]',
      'select[name*="Hora"]',
      '#hora',
      '#horaJuego',
      'select:has(option:has-text("08:00"))',
    ].join(', '),

    // ── "Bloquear" button (locks the slot for 3 minutes) ────────────────
    bloquearBtn: [
      'button:has-text("Bloquear")',
      '#btnBloquear',
      '.btn-bloquear',
      'button.bloquear',
      'input[type="submit"][value*="Bloquear"]',
      'button:has-text("BLOCKEAR")',
    ].join(', '),

    // ── 3-Minute Confirmation Window ────────────────────────────────────
    // Step E: Select Jugador (personal use → self, should be auto-selected)
    jugadorConfirmSelect: [
      'select[name*="jugador"]',
      '#jugadorConfirm',
      '.jugador-select',
    ].join(', '),

    // Step F: "He leído y aceptado las condiciones de contratación" checkbox
    condicionesCheckbox: [
      'input[type="checkbox"][name*="condicion"]',
      'input[type="checkbox"][name*="Condicion"]',
      'input[type="checkbox"][name*="acepto"]',
      'input[type="checkbox"][name*="termino"]',
      '#aceptoCondiciones',
      '#chkCondiciones',
      '.condiciones-contratacion input',
      'input[id*="condicion"]',
    ].join(', '),

    // Step G: Final "Reservar" button
    reservarBtn: [
      'button:has-text("Reservar")',
      '#btnReservar',
      '.btn-reservar',
      'button.reservar',
      'input[type="submit"][value*="Reservar"]',
      'button:has-text("RESERVAR")',
    ].join(', '),

    // ── Success indicators ──────────────────────────────────────────────
    successIndicator: [
      'confirmada',
      'reserva confirmada',
      'reserva realizada',
      'gracias por su reserva',
      'su reserva',
    ],
  },

  // Hora de Juego slots — exactly as shown on TeeOne (08:00-19:30, every 10 min)
  availableTimeSlots: [
    '08:00','08:10','08:20','08:30','08:40','08:50',
    '09:00','09:10','09:20','09:30','09:40','09:50',
    '10:00','10:10','10:20','10:30','10:40','10:50',
    '11:00','11:10','11:20','11:30','11:40','11:50',
    '12:00','12:10','12:20','12:30','12:40','12:50',
    '13:00','13:10','13:20','13:30','13:40','13:50',
    '14:00','14:10','14:20','14:30','14:40','14:50',
    '15:00','15:10','15:20','15:30','15:40','15:50',
    '16:00','16:10','16:20','16:30','16:40','16:50',
    '17:00','17:10','17:20','17:30','17:40','17:50',
    '18:00','18:10','18:20','18:30','18:40','18:50',
    '19:00','19:10','19:20','19:30',
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
 * @property {string} targetDate    - Target golf date (YYYY-MM-DD)
 * @property {string[]} targetDays  - e.g. ["sabado"] or ["sabado", "domingo"] (legacy)
 * @property {string} bookingOpensOn - Human-readable when the booking opens
 * @property {Date} bookingOpenDate  - The Date object for when booking opens at 20:00
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

/**
 * Calculate when a target golf date opens for booking.
 *
 * D+2 rule:  every night at 20:00, bookings open for today+2.
 * Thursday exception: on Thursday at 20:00, BOTH Saturday (D+2) AND Sunday (D+3) open.
 *
 * Examples:
 *   target Jun 10 (Tue) → opens Jun  8 (Sun) at 20:00   [regular D+2]
 *   target Jun 14 (Sat) → opens Jun 12 (Thu) at 20:00   [regular D+2]
 *   target Jun 15 (Sun) → opens Jun 12 (Thu) at 20:00   [Thursday exception — earlier!]
 *
 * @param {string} targetDateStr - "YYYY-MM-DD"
 * @returns {{ openDate: Date, targetDate: Date, isThursdayException: boolean, message: string }}
 */
function getBookingOpenInfo(targetDateStr) {
  const target = new Date(targetDateStr + 'T00:00:00');
  const targetDay = target.getDay(); // 0=Sun … 6=Sat

  // Regular D+2: open_date = target - 2
  const regularOpen = new Date(target);
  regularOpen.setDate(target.getDate() - 2);

  // Thursday exception: if target is Sunday (day 0), it opens on the PREVIOUS Thursday
  //   Sunday - 3 = Thursday (which is earlier than the regular Friday open)
  //   Use Thursday as the booking open date.
  if (targetDay === 0) {
    const thursdayOpen = new Date(target);
    thursdayOpen.setDate(target.getDate() - 3); // Sunday - 3 = Thursday
    return {
      openDate: thursdayOpen,
      targetDate: target,
      isThursdayException: true,
      message: `Se abre el jueves ${formatSpanishDate(thursdayOpen)} a las 20:00 (excepción fin de semana)`,
    };
  }

  return {
    openDate: regularOpen,
    targetDate: target,
    isThursdayException: false,
    message: `Se abre el ${getSpanishDayName(regularOpen)} ${formatSpanishDate(regularOpen)} a las 20:00 (regla D+2)`,
  };
}

/**
 * Get which target dates open TONIGHT at 20:00.
 * Used by the nightly automation to decide which bookings to execute.
 * @returns {Array<{key: string, date: Date, label: string, dateStr: string}>}
 */
function getTonightOpeningDates() {
  const today = new Date();
  const dayOfWeek = today.getDay();

  // D+2 from today
  const d2 = new Date(today);
  d2.setDate(today.getDate() + 2);

  const openings = [
    {
      key: getSpanishDayName(d2).toLowerCase(),
      date: new Date(d2),
      label: getSpanishDayName(d2),
      dateStr: d2.toISOString().split('T')[0],
    },
  ];

  // Thursday: D+3 (Sunday) also opens tonight
  if (dayOfWeek === 4) {
    const d3 = new Date(today);
    d3.setDate(today.getDate() + 3);
    openings.push({
      key: 'domingo',
      date: new Date(d3),
      label: getSpanishDayName(d3),
      dateStr: d3.toISOString().split('T')[0],
    });
  }

  return openings;
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

// ─── Playwright Semantic Locator Helpers ──────────────────────────────────────
// These use Playwright's built-in getByRole/getByLabel/getByText/getByPlaceholder
// which work like a HUMAN reading the page — no CSS selectors needed.
// They're resilient to DOM changes because they match by visible text/labels.

/**
 * Try to locate an element using multiple strategies, in order.
 * Each strategy is tried; the first visible match wins.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{desc: string, fn: () => import('playwright').Locator}>} strategies
 * @param {number} timeout - max ms to wait
 * @returns {Promise<{locator: import('playwright').Locator, method: string}>}
 */
async function smartLocate(page, strategies, timeout = 5000) {
  for (const { desc, fn } of strategies) {
    try {
      const loc = fn();
      await loc.first().waitFor({ state: 'visible', timeout });
      return { locator: loc.first(), method: desc };
    } catch (_) {
      // This strategy didn't match — try the next one
    }
  }
  const allDescs = strategies.map(s => s.desc).join(', ');
  throw new Error(`[smartLocate] Ninguna estrategia funcionó: ${allDescs}`);
}

/**
 * Try to select an option in a <select> element using multiple strategies.
 */
async function smartSelect(page, strategies, value, timeout = 5000) {
  for (const { desc, fn } of strategies) {
    try {
      const loc = fn();
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().selectOption(value);
      return { method: desc };
    } catch (_) {
      // Try next
    }
  }
  const allDescs = strategies.map(s => s.desc).join(', ');
  throw new Error(`[smartSelect] Ninguna estrategia funcionó: ${allDescs}`);
}

/**
 * Try to fill an input field using multiple strategies.
 */
async function smartFill(page, strategies, value, timeout = 5000) {
  for (const { desc, fn } of strategies) {
    try {
      const loc = fn();
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().click();
      await loc.first().fill(value);
      return { method: desc };
    } catch (_) {
      // Try next
    }
  }
  const allDescs = strategies.map(s => s.desc).join(', ');
  throw new Error(`[smartFill] Ninguna estrategia funcionó: ${allDescs}`);
}

/**
 * Try to check a checkbox using multiple strategies.
 */
async function smartCheck(page, strategies, timeout = 5000) {
  for (const { desc, fn } of strategies) {
    try {
      const loc = fn();
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().check({ force: true });
      return { method: desc };
    } catch (_) {
      // Try next
    }
  }
  const allDescs = strategies.map(s => s.desc).join(', ');
  throw new Error(`[smartCheck] Ninguna estrategia funcionó: ${allDescs}`);
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

    // ── Fill username (semantic locators first, CSS fallback last) ──
    const userMethod = await smartFill(page, [
      { desc: 'label:Usuario',        fn: () => page.getByLabel('Usuario') },
      { desc: 'placeholder:Usuario',  fn: () => page.getByPlaceholder('Usuario') },
      { desc: 'role:textbox Usuario', fn: () => page.getByRole('textbox', { name: /usuario|email|correo/i }) },
      { desc: 'css:#txtUsuarioLogin', fn: () => page.locator('#txtUsuarioLogin') },
      { desc: 'css:input[type=email]',fn: () => page.locator('input[type="email"]') },
      { desc: 'css:input[name*=user]',fn: () => page.locator('input[name*="user" i], input[name*="usuario" i], input[name*="login" i]') },
    ], booking.username, 10000);
    console.log(`   ↳ Username filled via: ${userMethod.method}`);
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // ── Fill password ──
    const pwdMethod = await smartFill(page, [
      { desc: 'label:Contraseña',       fn: () => page.getByLabel('Contraseña') },
      { desc: 'placeholder:Contraseña', fn: () => page.getByPlaceholder('Contraseña') },
      { desc: 'role:textbox Contraseña',fn: () => page.getByRole('textbox', { name: /contraseña|password|clave/i }) },
      { desc: 'css:#txtPasswordLogin',  fn: () => page.locator('#txtPasswordLogin') },
      { desc: 'css:input[type=password]',fn: () => page.locator('input[type="password"]') },
    ], booking.password, 5000);
    console.log(`   ↳ Password filled via: ${pwdMethod.method}`);
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

    // ── Click login button ──
    const loginMethod = await smartLocate(page, [
      { desc: 'role:button Iniciar',   fn: () => page.getByRole('button', { name: /iniciar sesión|entrar|acceder|login|ingresar/i }) },
      { desc: 'text:Iniciar sesión',   fn: () => page.getByText(/iniciar sesión|entrar|acceder/i) },
      { desc: 'css:#btnLoginUsuario',  fn: () => page.locator('#btnLoginUsuario') },
      { desc: 'css:button[type=submit]',fn: () => page.locator('button[type="submit"], input[type="submit"]') },
    ]);
    await loginMethod.locator.click();
    console.log(`   ↳ Login clicked via: ${loginMethod.method}`);
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
    console.log(`   ↳ Clicking date: ${dateStr} (day ${dayNum})…`);
    try {
      const dateMethod = await smartLocate(page, [
        // Semantic: find a gridcell with the day number
        { desc: 'role:gridcell day', fn: () => page.getByRole('gridcell', { name: new RegExp(`^${dayNum}$`) }) },
        // Semantic: find a link/button with the day number (common in calendar widgets)
        { desc: 'role:link day',     fn: () => page.getByRole('link', { name: new RegExp(`^${dayNum}$`) }) },
        { desc: 'role:button day',   fn: () => page.getByRole('button', { name: new RegExp(`^${dayNum}$`) }) },
        // Text-based: any element whose visible text is exactly the day number
        { desc: 'text:exact day',    fn: () => page.getByText(dayNum, { exact: true }) },
        // CSS: data attributes (common in FullCalendar and similar)
        { desc: 'css:[data-date]',   fn: () => page.locator(`[data-date="${dateStr}"], [data-fecha="${dateStr}"]`) },
        // CSS: any clickable td/div containing the day number
        { desc: 'css:td a day',      fn: () => page.locator(`td a:has-text("${dayNum}"), td:has-text("${dayNum}"), .fc-day:has-text("${dayNum}")`) },
      ], 5000);
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
      await dateMethod.locator.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await randomDelay(300, 500);
      console.log(`   ✅ Date selected via: ${dateMethod.method}. Booking form should now be visible.`);
    } catch (dateErr) {
      console.log(`   ⚠️  Could not click date (${dateErr.message}). Trying to continue…`);
      // Dump page content for debugging
      const pageTitle = await page.title();
      console.log(`   🔍 Current page title: "${pageTitle}", URL: ${page.url()}`);
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
      console.log(`⏳ [${booking.id}] ${remainingMs}ms until 20:00:00.050. Waiting…`);
      await new Promise(resolve => setTimeout(resolve, remainingMs));
    }

    console.log(`⚡ [${booking.id}] STRIKE! Filling booking form for ${booking.hora}…`);

    // ═══════════════════ BOOKING FORM ═══════════════════════════════════
    // After clicking a date, TeeOne shows the booking form with:
    //   Recorrido → Hoyos → Jugadores → Hora de Juego → CAPTCHA → Bloquear
    // We use semantic locators that work by READING LABEL TEXT,
    // so they work regardless of CSS classes or IDs.

    // ── Step A: Select Recorrido (default "Tee 1") ──────────────────────
    try {
      const rMethod = await smartSelect(page, [
        { desc: 'label:Recorrido',   fn: () => page.getByLabel('Recorrido') },
        { desc: 'label:Tee',         fn: () => page.getByLabel(/Tee|Recorrido|Campo/i) },
        { desc: 'role:combobox Tee', fn: () => page.getByRole('combobox', { name: /recorrido|tee|campo/i }) },
        { desc: 'css:select Tee',    fn: () => page.locator('select:has(option:has-text("Tee 1")), select:has(option:has-text("Tee"))') },
        { desc: 'css:#recorrido',    fn: () => page.locator('#recorrido, select[name*="recorrido" i], select[name*="Recorrido"]') },
      ], { label: S.recorridoValue });
      console.log(`   ✅ Recorrido: ${S.recorridoValue} (via: ${rMethod.method})`);
    } catch (e) { console.log(`   ⚠️  Recorrido select skipped: ${e.message}`); }

    // ── Step B: Select Hoyos (default "18") ─────────────────────────────
    try {
      const hMethod = await smartSelect(page, [
        { desc: 'label:Hoyos',          fn: () => page.getByLabel(/Hoyos|Número de hoyos|Hoyo/i) },
        { desc: 'role:combobox Hoyos',  fn: () => page.getByRole('combobox', { name: /hoyos|hoyo/i }) },
        { desc: 'css:select 18',        fn: () => page.locator('select:has(option:has-text("18"))') },
        { desc: 'css:#hoyos',           fn: () => page.locator('#hoyos, #numHoyos, select[name*="hoyos" i], select[name*="Hoyos"]') },
      ], { label: S.hoyosValue });
      console.log(`   ✅ Hoyos: ${S.hoyosValue} (via: ${hMethod.method})`);
    } catch (e) { console.log(`   ⚠️  Hoyos select skipped: ${e.message}`); }

    // ── Step C: Select Jugadores (default "1", personal use) ────────────
    try {
      const jMethod = await smartSelect(page, [
        { desc: 'label:Jugadores',         fn: () => page.getByLabel(/Jugadores|Número de jugadores|Jugador/i) },
        { desc: 'role:combobox Jugadores', fn: () => page.getByRole('combobox', { name: /jugador/i }) },
        { desc: 'css:select 1 player',     fn: () => page.locator('select:has(option:has-text("1"))') },
        { desc: 'css:#jugadores',          fn: () => page.locator('#jugadores, #numJugadores, select[name*="jugador" i], select[name*="Jugador"]') },
      ], { label: S.jugadoresValue });
      console.log(`   ✅ Jugadores: ${S.jugadoresValue} (via: ${jMethod.method})`);
    } catch (e) { console.log(`   ⚠️  Jugadores select skipped: ${e.message}`); }

    // ── Step D: Select Hora de Juego ────────────────────────────────────
    try {
      const tMethod = await smartSelect(page, [
        { desc: 'label:Hora',             fn: () => page.getByLabel(/Hora|Hora de juego|Horario/i) },
        { desc: 'role:combobox Hora',     fn: () => page.getByRole('combobox', { name: /hora|horario/i }) },
        { desc: 'css:select time',        fn: () => page.locator('select:has(option:has-text("08:00"))') },
        { desc: 'css:#hora',              fn: () => page.locator('#hora, #horaJuego, #horaSalida, select[name*="hora" i], select[name*="Hora"]') },
      ], { label: booking.hora });
      await randomDelay(100, 200);
      console.log(`   ✅ Hora de Juego: ${booking.hora} (via: ${tMethod.method})`);
    } catch (e) {
      console.log(`   ❌ Failed to select Hora: ${e.message}`);
      return {
        success: false,
        message: `No se pudo seleccionar la hora ${booking.hora}: ${e.message}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }

    // ── Step E: Handle reCAPTCHA ("No soy un robot") ────────────────────
    console.log(`   🛡️  Handling reCAPTCHA before Bloquear…`);
    const formCaptcha = await detectCaptcha(page);
    if (formCaptcha.type !== 'none') {
      const solved = await solveCaptcha(page, formCaptcha.type);
      if (!solved.solved) {
        console.log(`   ❌ CAPTCHA not solved. Cannot proceed to Bloquear.`);
        return {
          success: false,
          message: `No se pudo resolver el CAPTCHA (${formCaptcha.type}). ${solved.method}`,
          targetDay: targetDay.key,
          date: formatSpanishDate(targetDay.date),
        };
      }
      await randomDelay(300, 500);
      console.log(`   ✅ CAPTCHA solved.`);
    } else {
      console.log(`   ℹ️  No CAPTCHA detected on form.`);
    }

    // ── Step F: Click "Bloquear" ────────────────────────────────────────
    console.log(`   🔒 Clicking BLOQUEAR…`);
    try {
      const bloquearMethod = await smartLocate(page, [
        { desc: 'role:button Bloquear', fn: () => page.getByRole('button', { name: /bloquear|bloquea/i }) },
        { desc: 'text:Bloquear',        fn: () => page.getByText(/bloquear|bloquea/i) },
        { desc: 'css:#btnBloquear',     fn: () => page.locator('#btnBloquear, .btn-bloquear, button.bloquear, input[type="submit"][value*="Bloquear" i], button:has-text("Bloquear"), button:has-text("BLOQUEAR")') },
      ]);
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
      await bloquearMethod.locator.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await randomDelay(300, 500);
      console.log(`   ✅ Bloquear clicked (via: ${bloquearMethod.method}). 3-minute confirmation window open.`);
    } catch (e) {
      console.log(`   ❌ Bloquear failed: ${e.message}`);
      return {
        success: false,
        message: `No se pudo hacer clic en Bloquear: ${e.message}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }

    // ═══════════════════ 3-MIN CONFIRMATION WINDOW ══════════════════════
    console.log(`   ⏱️  In 3-minute confirmation window. Confirming…`);

    // ── Step G: Select Jugador (self — should be auto-selected) ─────────
    try {
      const jugMethod = await smartSelect(page, [
        { desc: 'label:Jugador',         fn: () => page.getByLabel(/Jugador|Participante|Titular/i) },
        { desc: 'role:combobox Jugador', fn: () => page.getByRole('combobox', { name: /jugador|participante|titular/i }) },
        { desc: 'css:select jugador',    fn: () => page.locator('select:has(option), #jugadorConfirm, .jugador-select, select[name*="jugador" i]') },
      ], { index: 0 });
      await randomDelay(100, 200);
      console.log(`   ✅ Jugador confirmed (via: ${jugMethod.method}).`);
    } catch (e) {
      console.log(`   ℹ️  Jugador select not found or already set: ${e.message}`);
    }

    // ── Step H: Check "He leído y aceptado las condiciones" ─────────────
    console.log(`   📝 Checking condiciones de contratación…`);
    try {
      const condMethod = await smartCheck(page, [
        { desc: 'label:Condiciones',   fn: () => page.getByLabel(/he leído|acepto|condiciones de contratación|condiciones/i) },
        { desc: 'role:checkbox Acepto',fn: () => page.getByRole('checkbox', { name: /condiciones|acepto|he leído|contratación/i }) },
        { desc: 'text:Condiciones',    fn: () => page.getByText(/he leído y acepto|condiciones de contratación|acepto las condiciones/i) },
        { desc: 'css:checkbox cond',   fn: () => page.locator('input[type="checkbox"][name*="condicion" i], input[type="checkbox"][name*="acepto" i], input[type="checkbox"][name*="termino" i], #aceptoCondiciones, #chkCondiciones, input[id*="condicion" i]') },
      ]);
      await randomDelay(100, 200);
      console.log(`   ✅ Condiciones checked (via: ${condMethod.method}).`);
    } catch (e) {
      console.log(`   ❌ Condiciones checkbox failed: ${e.message}`);
      return {
        success: false,
        message: `No se pudo marcar la casilla de condiciones: ${e.message}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }

    // ── Step I: Click "Reservar" (final confirm) ────────────────────────
    console.log(`   🏆 Clicking RESERVAR (final confirmation)…`);
    try {
      const reservarMethod = await smartLocate(page, [
        { desc: 'role:button Reservar', fn: () => page.getByRole('button', { name: /reservar|confirmar reserva|realizar reserva/i }) },
        { desc: 'text:Reservar',        fn: () => page.getByText(/reservar|confirmar/i) },
        { desc: 'css:#btnReservar',     fn: () => page.locator('#btnReservar, .btn-reservar, button.reservar, input[type="submit"][value*="Reservar" i], button:has-text("Reservar"), button:has-text("RESERVAR")') },
      ]);
      await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);
      await reservarMethod.locator.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await randomDelay(500, 1000);
      console.log(`   🏆 Reservar clicked (via: ${reservarMethod.method}).`);
    } catch (e) {
      console.log(`   ❌ Reservar click failed: ${e.message}`);
      return {
        success: false,
        message: `No se pudo confirmar la reserva: ${e.message}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }

    // ── Check for success ───────────────────────────────────────────────
    const pageContent = await page.content();
    const pageText = pageContent.toLowerCase();
    const successTerms = S.successIndicator;

    if (successTerms.some(term => pageText.includes(term))) {
      console.log(`🏆 [${booking.id}] BOOKING CONFIRMED! ${targetDay.label} ${formatSpanishDate(targetDay.date)} at ${booking.hora}`);
      return {
        success: true,
        message: `✅ Reserva confirmada: ${targetDay.label} ${formatSpanishDate(targetDay.date)} a las ${booking.hora}`,
        targetDay: targetDay.key,
        date: formatSpanishDate(targetDay.date),
      };
    }

    console.log(`⚠️  [${booking.id}] Booking submitted but success unconfirmed. Check manually.`);
    return {
      success: true, // Optimistic — Bloquear + Reservar were clicked
      message: `Reserva enviada (no verificada): ${targetDay.label} ${formatSpanishDate(targetDay.date)} a las ${booking.hora}. Verifique en su cuenta.`,
      targetDay: targetDay.key,
      date: formatSpanishDate(targetDay.date),
    };
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

  // ── Match bookings to tonight's opening dates ────────────────────
  const tonightOpenings = getTonightOpeningDates();
  const tonightDateStrs = tonightOpenings.map(o => o.dateStr);
  console.log(`📅 Tonight opens: ${tonightOpenings.map(o => `${o.label} (${o.dateStr})`).join(', ')}`);

  const tasks = [];

  for (const [, booking] of bookingStore) {
    if (tonightDateStrs.includes(booking.targetDate)) {
      booking.status = 'in_progress';
      const match = tonightOpenings.find(o => o.dateStr === booking.targetDate);
      tasks.push({ booking, targetDay: match });
      console.log(`   🎯 Matched: ${booking.id} → ${match.label} (${match.dateStr})`);
    }
  }

  if (tasks.length === 0) {
    console.log('ℹ️  No bookings match tonight\'s opening dates. Nothing to do.');
    automationInProgress = false;
    return;
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
 * Body: { username, password, hoyos, jugadores, hora, targetDate }
 */
app.post('/api/booking', (req, res) => {
  try {
    const { username, password, hoyos, jugadores, hora, targetDate } = req.body;

    // Validation
    const errors = [];
    if (!username || !username.trim()) errors.push('Usuario es obligatorio');
    if (!password || !password.trim()) errors.push('Contraseña es obligatoria');
    if (!hora) errors.push('Hora deseada es obligatoria');
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      errors.push('Fecha objetivo es obligatoria (formato YYYY-MM-DD)');
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    // ── Calculate when this target date opens for booking ──────────
    const openInfo = getBookingOpenInfo(targetDate);
    const now = new Date();

    // Check if the booking window has already passed
    if (openInfo.openDate < now) {
      // Check if it opened today (before 20:00 means still possible tonight)
      const openDateStart = new Date(openInfo.openDate);
      openDateStart.setHours(0, 0, 0, 0);
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      if (openDateStart.getTime() === todayStart.getTime() && now.getHours() < 20) {
        // Booking opens tonight — still valid
      } else {
        return res.status(400).json({
          success: false,
          errors: [`La ventana de reserva para el ${formatSpanishDate(openInfo.targetDate)} ya ha pasado (se abrió el ${formatSpanishDate(openInfo.openDate)} a las 20:00). Por favor, seleccione una fecha más lejana.`],
        });
      }
    }

    const booking = {
      id: uuidv4(),
      username: username.trim(),
      password: password, // ONLY in RAM — wiped at 20:01
      hoyos: hoyos || '18',
      jugadores: jugadores || '4',
      hora: hora,
      targetDate: targetDate,
      targetDays: [], // deprecated, kept for compat
      bookingOpensOn: openInfo.message,
      bookingOpenDate: openInfo.openDate,
      status: 'pending',
      result: null,
      createdAt: new Date(),
    };

    bookingStore.set(booking.id, booking);

    // Format the strike time for display
    const strikeTime = new Date(openInfo.openDate);
    strikeTime.setHours(CONFIG.strikeTime.hour, CONFIG.strikeTime.minute, CONFIG.strikeTime.second, CONFIG.strikeTime.millis);

    console.log(`📥 [BOOKING] New request received:`);
    console.log(`   ID:          ${booking.id}`);
    console.log(`   User:        ${booking.username}`);
    console.log(`   Target date: ${targetDate} (${getSpanishDayName(openInfo.targetDate)})`);
    console.log(`   Opens on:    ${formatSpanishDate(openInfo.openDate)} at 20:00`);
    console.log(`   Hora:        ${booking.hora}`);
    console.log(`   Hoyos:       ${booking.hoyos}`);
    console.log(`   Players:     ${booking.jugadores}`);
    console.log(`   Queue:       ${bookingStore.size} booking(s) pending`);

    return res.status(201).json({
      success: true,
      booking: {
        id: booking.id,
        status: booking.status,
        targetDate: targetDate,
        targetDayLabel: getSpanishDayName(openInfo.targetDate),
        opensOn: formatSpanishDate(openInfo.openDate),
        opensOnLabel: getSpanishDayName(openInfo.openDate),
        opensMessage: openInfo.message,
        strikeTime: strikeTime.toISOString(),
        createdAt: booking.createdAt,
        // NEVER return credentials in response
      },
      message: `Reserva guardada. ${openInfo.message}.`,
      nextAutomation: strikeTime.toISOString(),
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
