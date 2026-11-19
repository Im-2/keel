# Reliability: how Keel stays up with every personal computer off

**Nothing runs on a personal computer.** Everything below is hosted.

| Part | Where it runs | Notes |
|---|---|---|
| Website, landing, `/docs`, `/stats`, `/status`, deck PDF, web app, demo mode | Vercel (static CDN) | Pages render without any backend call. |
| Bot, API, keeper, alerts, claim relayer | Render, free plan, Frankfurt (`keel-bot.onrender.com`) | The free plan sleeps after 15 idle minutes; a cold start takes about 30 to 60 seconds. |
| Database | Turso (mirrors the bot's local SQLite) | |
| Chain | Mezo testnet public RPC | |

`VITE_API_BASE` in Vercel (production and preview) is `https://keel-bot.onrender.com`. No tunnel, no watchdog, no localhost.

## What keeps the backend awake and the keeper running
1. **cron-job.org** job "Keel keeper + alerts + keep-awake": `GET /cron/tick` every minute. It wakes the host, runs the keeper, alerts and block watcher. It has failure and "job disabled" notifications switched on.
2. **GitHub Actions `uptime`** (`.github/workflows/uptime.yml`): every 5 minutes, independent of cron-job.org, it requests the site, `/docs`, `/healthz` and `/api/stats` (retrying while the host wakes). It fails visibly (and emails the repo owner) when something is down. If the repository secrets `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_IDS` exist, it also messages the admins on Telegram, at most about every 30 minutes.

## Free-hours math (Render)
A month has 720 to 744 hours; the free pool is 750 hours **per workspace**, shared by every free web service in it. One service kept awake 24/7 uses nearly all of it. So on Render free: either one always-on service and nothing else running, or several services that are allowed to sleep. Keel needs the former, so the reliable options are: pay for one Starter instance (needs a card), or host the backend where there is no such quota (see [MIGRATE_BACKEND.md](MIGRATE_BACKEND.md)).

## Watchdog and alerts
- In-process (every minute): keeper not completed a run for 10 minutes or last run failed; block watcher stuck; the process cannot answer its own `/healthz`; keeper wallet balance low (existing). Each alert goes to `ADMIN_IDS` on Telegram at most once an hour per kind.
- External (works when the process is dead): GitHub Actions `uptime` every 5 minutes (fails and emails the repo owner; Telegram too when the secrets exist) and cron-job.org failure notifications.
- `/healthz` does no database or RPC work. `/cron/tick` answers 200 at once, runs the keeper, alerts and block watcher in the background (a job already running is skipped), and never answers 5xx. The keeper reads the chain every run and the block watcher resumes from its stored cursor, so a missed tick is caught up by the next one.

## What the pages do when the backend is asleep
- The landing page, docs and deck are static files: they paint immediately.
- Live numbers (landing stats band, `/stats`) first show `stats-snapshot.json`, a static copy baked at build time (and refreshed every 6 hours by `.github/workflows/refresh-snapshot.yml`), with the note "Live data is waking up, showing the latest snapshot". Live values replace it once the backend answers.
- `/status` is static too; it shows "waking up" for the server and fills in bot, RPC, keeper and database health when the server answers.
- The web app shows "Waking up the server, about 30 seconds" and retries by itself (with a "Try again now" button). Demo mode and `/stats` start from the config baked into the snapshot, so they never wait.

## Incident log
- **2026-11-19 (outage, root cause: Render's monthly free-hours quota):** at 12:25:15 UTC Render suspended **all six free services in the workspace at the same instant** (`suspender: billing`, event "Monthly Quota Exceeded"). Free web services share one pool of 750 instance-hours per month for the whole workspace. Keel is kept awake around the clock by its keep-alive (about 744 h in a 31-day month), so it can never fit in that pool next to five other free services. Every request since then gets an instant `503` from Render's edge (not a crash: no deploy failed, nothing restarted). cron-job.org saw 26 consecutive 503s and disabled the job. A suspended-for-billing service cannot be resumed through the API (HTTP 400); it comes back when the quota resets on the 1st of the month, or immediately if the workspace adds a payment method. Fixes shipped: watchdog alerts, a tick that can never 5xx, a container image for a host without Render's quota (`Dockerfile`, [MIGRATE_BACKEND.md](MIGRATE_BACKEND.md)), and honest wake/offline screens.
- **2026-11-17:** the cron-job.org keep-alive job had been **disabled since 2026-10-31** (last run that day). Without it, the free Render service slept and the first request waited for a cold start, which made the web app look broken. Re-enabled; failure notifications added; second independent monitor added.

## Things to know
- Mirror host: the site is on `vercel.app` only. `netlify.toml` and `miniapp/public/_headers` are included so the same repo can be connected to Netlify or Cloudflare Pages in a few clicks (needs a login by the owner).
- A custom domain needs to be bought; free options are only provider subdomains.
- Render free plan allows about 750 instance hours a month, enough for one always-on service.
