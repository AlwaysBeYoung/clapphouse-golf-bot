# ⛳ Golf Bot — Lomas Bosque Auto-Booker (Madrid)

> **Real Club de Golf Lomas Bosque** — Zero-effort, millisecond-precision TeeOne.golf auto-booker.
> Dark emerald UI for 70+ year-old players. Server-side Playwright engine fires precisely at 20:00:00.050 every evening.
> **100% RAM-only credential storage — nothing persists to disk. GDPR-respectful by design.**

---

## Architecture

```
┌──────────────────────────┐       POST /api/booking        ┌──────────────────────────────┐
│   GitHub Pages (Static)  │  ──────────────────────────▶   │   Render / Railway (Node.js) │
│                          │                                 │                              │
│   docs/index.html        │  ◀── GET /api/booking/:id ──   │   server.js                  │
│   • Senior-friendly UI   │       GET /api/status           │   • Express API              │
│   • localStorage creds   │                                 │   • In-RAM volatile store    │
│   • Countdown timer      │                                 │   • Playwright automation    │
│   • Thursday dual-pick   │                                 │   • Daily scheduler          │
└──────────────────────────┘                                 └──────────────────────────────┘
```

**Daily Automation Schedule (Europe/Madrid time):**

| Time | Event | Description |
|------|-------|-------------|
| **19:59:50** | 🔥 Warm-Up | Playwright engine pre-launches to avoid cold-start latency |
| **20:00:00.050** | ⚡ Strike | All queued bookings execute simultaneously in headless Chromium |
| **20:01:00** | 🧹 Cleanup | Destructive RAM wipe — all credentials, sessions, and data purged |

**Booking Rule:** Every evening at 20:00, the club opens bookings for **D+2** (today + 2 days).
**Thursday Exception:** On Thursdays, both Saturday (D+2) **and** Sunday (D+3) open simultaneously.

---

## Project Structure

```
Golf Bot/
├── package.json          # Node.js dependencies & scripts
├── server.js             # Express API + Playwright automation engine
├── docs/
│   └── index.html        # Senior-accessible frontend (GitHub Pages)
└── README.md             # This file
```

---

## Quick Start (Local Dev)

### Prerequisites
- **Node.js >= 18**
- **npm >= 9**

### 1. Install Dependencies

```bash
cd "Golf Bot"
npm install
```

The `postinstall` script automatically downloads Chromium for Playwright.

### 2. Run Locally

```bash
npm start
# Or: node server.js
```

Open **http://localhost:3000** on your phone or desktop browser.

### 3. Test the Automation

```bash
# Simulate a booking submission
curl -X POST http://localhost:3000/api/booking \
  -H "Content-Type: application/json" \
  -d '{
    "username": "test@example.com",
    "password": "test123",
    "hoyos": "18",
    "jugadores": "4",
    "hora": "08:00",
    "targetDays": ["sabado"]
  }'

# Check status
curl http://localhost:3000/api/status
```

---

## Deployment Guide

### Part A: Backend on Render.com (Free Tier, 24/7)

Render's free tier keeps your Node.js server running indefinitely — perfect for this use case.

#### Step 1: Push to GitHub

Create a GitHub repository and push this entire `Golf Bot/` folder:

```bash
cd "Golf Bot"
git init
git add .
git commit -m "Initial commit: Golf Bot auto-booker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/golf-bot.git
git push -u origin main
```

#### Step 2: Create Render Web Service

1. Go to **[render.com](https://render.com)** → **New** → **Web Service**
2. Connect your GitHub repo (`YOUR_USERNAME/golf-bot`)
3. Configure:

   | Setting | Value |
   |---------|-------|
   | **Name** | `golf-bot` |
   | **Runtime** | Node |
   | **Build Command** | `npm install && npx playwright install --with-deps chromium` |
   | **Start Command** | `node server.js` |
   | **Instance Type** | Free |

4. **Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `TZ` | `Europe/Madrid` |
   | `PORT` | `3000` (Render sets this automatically) |

5. Click **Create Web Service**

⏳ Render takes 3–5 minutes on first deploy (Playwright Chromium download). Subsequent deploys are faster.

#### Step 3: Note Your Backend URL

Once deployed, Render gives you a URL like:
```
https://golf-bot.onrender.com
```
**Copy this — you'll need it for the frontend.**

> ⚠️ **Render Free Tier Note:** Free services spin down after 15 minutes of inactivity. The first request after inactivity takes ~30–60 seconds to wake up. However, because the automation runs at fixed times (19:59:50 and 20:00:00), the server **must be awake** at those times. Consider:
> - Using a free uptime monitor like **[UptimeRobot](https://uptimerobot.com)** to ping `https://golf-bot.onrender.com/api/status` every 5 minutes.
> - Or upgrading to Render's **Starter** plan ($7/month) for always-on service.

---

### Part B: Frontend on GitHub Pages (Free, Fast CDN)

#### Step 1: Update Backend URL

Edit `docs/index.html` and change the `BACKEND_URL` constant near the top of the `<script>` block:

```javascript
// Replace this line:
const BACKEND_URL = window.location.origin;

// With your Render URL:
const BACKEND_URL = 'https://golf-bot.onrender.com';
```

#### Step 2: Enable GitHub Pages

1. Go to your GitHub repo → **Settings** → **Pages**
2. Under **Source**, select **Deploy from a branch**
3. Branch: `main`, Folder: `/docs`
4. Click **Save**

GitHub will give you a URL like:
```
https://YOUR_USERNAME.github.io/golf-bot/
```

#### Step 3: (Alternative) Deploy Entire Site as GitHub Pages

The frontend will be served directly from the root URL since GitHub Pages deploys the `/docs` folder.

---

### Part C: Linking Frontend ↔ Backend

Once both are deployed:

1. Open your GitHub Pages URL on your phone
2. Enter your TeeOne / Lomas Bosque credentials
3. Configure your booking preferences
4. Tap **"GUARDAR Y CONFIGURAR RESERVA AUTOMÁTICA"**
5. The frontend sends your booking to the Render backend
6. At 20:00, the Playwright engine executes the booking
7. Your credentials are wiped from RAM at 20:01

---

## ⚠️ Important: Verify TeeOne Selectors

The automation engine uses CSS selectors to interact with the TeeOne platform. Login selectors have been verified from the actual HTML. Calendar and booking selectors use fallback chains. Before going live:

1. Log into TeeOne and navigate to the calendar page
2. Right-click → **Inspect** on the calendar grid, time slots, booking form, and confirmation elements
3. Update the `CONFIG.selectors` object in `server.js` if the fallback chains don't match

The current selectors use **fallback chains** (multiple selectors separated by commas) so there's a good chance they work out of the box. Test thoroughly with a non-critical booking first.

---

## Security & Privacy Model

| Concern | Implementation |
|---------|---------------|
| **Credential storage** | `localStorage` on user's device only (AES-like browser encryption) |
| **Server-side storage** | Volatile JavaScript `Map()` in RAM — wiped every day at 20:01 |
| **Transmission** | HTTPS (both GitHub Pages and Render enforce TLS) |
| **Logging** | Server logs booking IDs only — never usernames or passwords |
| **GDPR** | No database. No persistent storage. No third-party data sharing. Full right-to-deletion (data self-destructs daily). |
| **Code audit** | 100% open-source on GitHub for family/technical review |

---

## FAQ

### Q: What if my booking fails?
A: The status page shows the exact failure reason. You can resubmit — it will queue for the next evening's 20:00 cycle.

### Q: Can I book for multiple days?
A: On **Thursdays**, yes — you can select Saturday, Sunday, or both. On other days, the system books D+2 only.

### Q: What happens if someone else grabs the slot first?
A: The automation fires at 20:00:00.050 with millisecond precision, giving you the best possible chance. However, if another player (or bot) is faster, the booking will fail gracefully and notify you.

### Q: Is this legal?
A: This tool automates the booking process at human-like speeds (100–300ms random delays). It does not bypass any security measures or CAPTCHAs. It simply ensures you don't have to sit at a screen at exactly 20:00.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML5 + CSS3 + ES2020 JavaScript (zero frameworks — fastest load, least complexity for seniors) |
| Backend | Node.js + Express |
| Automation | Playwright (headless Chromium) |
| Hosting | GitHub Pages (frontend) + Render/Railway (backend) |
| Storage | `localStorage` (client) + in-RAM `Map()` (server — wiped daily) |

---

## License

MIT — Free for personal and commercial use.

---

**Built with ❤️ for Spanish senior golfers. ¡Buen juego! ⛳**
