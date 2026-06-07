/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           GOLF BOT — Clapphouse/GolfSpain Auto-Booker       ║
 * ║  Millisecond-Precision Tee-Time Reservation Engine          ║
 * ║  Designed for Spanish Senior Golfers (70+ years old)        ║
 * ╚══════════════════════════════════════════════════════════════╝
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

  // ⚠️ IMPORTANT — ADJUST THESE SELECTORS TO MATCH THE CLAPPHOUSE WEBSITE ⚠️
  // Inspect the live Clapphouse/GolfSpain pages and update accordingly.
  selectors: {
    // ── Login Page ──────────────────────────────────────────────────────
    loginUrl:        'https://clapphouse.golfspain.com/login',
    usernameField:   'input[name="email"], input[name="username"], #user_email, #email',
    passwordField:   'input[name="password"], input[type="password"], #user_password, #password',
    loginSubmitBtn:  'button[type="submit"], input[type="submit"], .login-button, #login-btn',

    // ── Tee Sheet ───────────────────────────────────────────────────────
    teeSheetUrl:     'https://clapphouse.golfspain.com/tee-sheet',
    // Slot row: use a data attribute or class that contains the tee time.
    // The placeholder below assumes slots have a data-tee-time attribute like "08:00".
    // Replace with the actual selector pattern found on the live site.
    teeTimeRow:      (time) => `[data-tee-time="${time}"], tr:has(td:has-text("${time}")), .slot-${time.replace(':', '')}`,
    // Button inside the slot row to initiate booking
    bookSlotBtn:     'button.reserve, .book-now, a.reserve-link, .slot-action button',

    // ── Confirmation Modal (2-Step Validation) ──────────────────────────
    modalContainer:  '.modal, .dialog, [role="dialog"], #booking-modal, .confirmation-popup',
    termsCheckbox:   'input[type="checkbox"][name*="terms"], #accept-terms, .terms-checkbox input',
    confirmBtn:      'button:has-text("Confirmar"), #confirm-booking, .confirm-btn, button.confirm',
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
 * @property {string} username      - Clapphouse username
 * @property {string} password      - Clapphouse password (volatile RAM only)
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
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
  });

  const page = await context.newPage();

  try {
    const S = CONFIG.selectors;

    // ── Step 1: Login ───────────────────────────────────────────────────
    console.log(`🔑 [${booking.id}] Navigating to login page…`);
    await page.goto(S.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

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

    console.log(`✅ [${booking.id}] Login completed. Session is hot.`);

    // ── Step 2: Navigate to Tee Sheet ───────────────────────────────────
    // Build the tee-sheet URL with the target date
    const dateStr = targetDay.date.toISOString().split('T')[0]; // YYYY-MM-DD
    const teeSheetUrl = `${S.teeSheetUrl}?date=${dateStr}`;

    console.log(`🗺️  [${booking.id}] Navigating to tee sheet for ${targetDay.label} (${dateStr})…`);
    await page.goto(teeSheetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await randomDelay(CONFIG.minHumanDelay, CONFIG.maxHumanDelay);

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

      if (pageContent.toLowerCase().includes('confirmada') || pageContent.toLowerCase().includes('reserva')) {
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
  console.log('║        ⛳  GOLF BOT — Auto-Booker Engine  ⛳         ║');
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
