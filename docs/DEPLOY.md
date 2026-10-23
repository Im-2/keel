# Deploying Keel

Keel runs 24/7 without anyone's laptop. Everything below is on free plans that need no payment card.

## Live addresses

| What | URL |
|---|---|
| Telegram bot | https://t.me/KeelMezoBot |
| Mini App (Vercel) | https://keel-miniapp.vercel.app |
| Backend: bot, API, keeper, alerts, claim relayer (Render) | https://keel-bot.onrender.com |
| Status page (bot, RPC, keeper balance, last runs, database) | https://keel-bot.onrender.com/status · JSON: `/status.json` |
| Health check | https://keel-bot.onrender.com/healthz |
| Contracts (Mezo testnet, chain 31611) | KeelGuardianFactory `0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49` · KeelPay `0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29` |
| Keeper + relayer wallet (gas only) | `0x048Ea1d824C2E518A687Dd934dCCE6b48ED1E981` |

## How it fits together

```
Telegram ──webhook──▶ Render "keel-bot" (Frankfurt, free) ◀── cron-job.org: GET /cron/tick every minute
                         │  bot + API + keeper + alerts + relayer        (keeps it awake, runs keeper and alerts)
                         │  SQLite cache in /tmp ──every write──▶ Turso "keel" (AWS eu-west-1, Ireland)
                         ▼                                       (rebuilt from Turso on every start)
Mini App (Vercel) ──HTTPS API──▶ keel-bot.onrender.com ──▶ Mezo testnet RPC
```

- **Hosting choice:** Render's free web service needs no card, has a stable HTTPS URL and restarts itself when it crashes.
- **Render's weak spots, and how they're covered:**
  - **It sleeps after 15 idle minutes.** cron-job.org calls it every minute, which keeps it awake and also drives the keeper and alerts. If the timers inside the process ever stop, the jobs still run.
  - **Its disk is erased on every restart or deploy.** The database lives in Turso: the process keeps a local SQLite copy for speed, replays every write to Turso, and rebuilds the local copy from Turso when it starts (`bot/src/db.ts`, `bot/src/mirror.ts`). Before shutting down it waits until the last writes have reached Turso.
- **Region:** Turso is in AWS eu-west-1 (Ireland). Render has no Ireland region, so the service runs in Frankfurt, the nearest one.
- **Telegram:** updates arrive by webhook. The path can't be guessed and every request must carry Telegram's secret header, so only Telegram can post. Long polling is used only when `PUBLIC_URL` is not set (local development).

## Environment (set on Render, never in git)

| Variable | Value |
|---|---|
| `BOT_TOKEN` | secret, from @BotFather |
| `KEEPER_PRIVATE_KEY` | secret. A small-balance key that pays gas for keeper `protect()` calls and claim-link relays. **Not** the deployer key; the deployer key is not on the server |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | secrets, from the Turso dashboard |
| `CRON_SECRET` | secret. `/cron/tick` refuses requests without it |
| `ADMIN_IDS` | `811387215`: who gets "keeper wallet is low" messages |
| `PREMIUM_PAY_TO` | public address that receives x402 premium payments |
| `PUBLIC_URL` | `https://keel-bot.onrender.com` (switches the bot to webhooks) |
| `MINIAPP_URL` | `https://keel-miniapp.vercel.app` |
| `NETWORK`, `BOT_USERNAME`, `NODE_VERSION`, `DB_PATH`, `POLL_MS` | `testnet`, `KeelMezoBot`, `24`, `/tmp/keel.sqlite`, `30000` |
| `KEEPER_MIN_BTC` (optional) | low-balance threshold, default `0.001` |

On Vercel (project `keel-miniapp`): `VITE_API_BASE=https://keel-bot.onrender.com` and `VITE_WC_PROJECT_ID`.

## Keeping the keeper funded

The status page shows the keeper wallet's BTC balance. Below `KEEPER_MIN_BTC` it is flagged **LOW**, and the bot messages every `ADMIN_IDS` user in Telegram, at most every 12 hours. Top it up by sending testnet BTC to `0x048Ea1d824C2E518A687Dd934dCCE6b48ED1E981`. Each protection costs well under 0.0001 BTC of gas.

## How it was set up (reproducible)

1. **Turso:** create database `keel` and a read/write token. Copy existing data with `cd bot && pnpm tsx scripts/migrate-to-turso.ts .keel-data/keel.sqlite` (safe to re-run).
2. **Render:** create a web service from the public repo with `render.yaml`'s settings (free plan, Frankfurt):
   - build: `npx -y pnpm@10.28.0 install --frozen-lockfile --filter @keel/bot...`
   - start: `cd bot && ./node_modules/.bin/tsx src/index.ts`
   - health check: `/healthz`
   - Set the secrets above. Done through Render's API with the account's API key; the dashboard works the same way.
3. **cron-job.org:** one job `GET https://keel-bot.onrender.com/cron/tick?key=<CRON_SECRET>`, every minute, 30 s timeout (created through its API).
4. **Vercel:** set `VITE_API_BASE` to the Render URL, then redeploy. Every push to `main` redeploys both Vercel (Mini App) and Render (backend).

## Day to day

- **Deploy:** `git push` (Render and Vercel both build from `main`).
- **Logs:** Render dashboard → keel-bot → Logs.
- **Check health:** open the status page.
- **Rotate a secret:** change it in Render → Environment, which restarts the service. If you change `CRON_SECRET`, also update the cron-job.org job URL.
- **Run locally:** don't set `PUBLIC_URL`; the bot then uses long polling. Note it takes Telegram updates away from the hosted bot while it runs, so stop it when you're done (the hosted bot re-registers its webhook on its next start).

## Known limits

- **Wake-up delay:** if cron-job.org stopped calling, the service would sleep after 15 minutes, and the next Telegram message would wait about 1 minute while Render wakes it (Telegram retries delivery).
- **Instance size:** Render's free instance is small (about 512 MB, a fraction of a CPU). The bot uses well under that.
- **Free hours:** 750 instance hours a month, enough for exactly one always-on service.
- **Turso's free plan:** an archived database needs a manual "unarchive" after about 10 days of no activity. The every-minute schedule keeps it active.
