# Moving the Keel backend off Render's free quota

Why: see the 2026-11-19 incident in [RELIABILITY.md](RELIABILITY.md). The backend is one Node process (bot, API, keeper, alerts). Its data lives in Turso, so it can move without losing anything.

## Option A, quickest if you have a card: upgrade the one service
Render dashboard, service `keel-bot`, Settings, Instance Type: Starter (about 7 USD a month, billed by the second). Adding a payment method un-suspends it at once and removes the sleep. Nothing else changes.

## Option B, no card: Hugging Face Spaces (Docker)
1. Create a free account at huggingface.co, then New Space: SDK **Docker**, hardware CPU basic (free), visibility Public (so the code stays open; secrets are not exposed).
2. In the Space, Settings, Variables and secrets, add (secrets, not variables): `BOT_TOKEN`, `KEEPER_PRIVATE_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET`, `ADMIN_IDS`, `PREMIUM_PAY_TO`; and variables: `NETWORK=testnet`, `MINIAPP_URL=https://keel-miniapp.vercel.app`, `BOT_USERNAME=KeelMezoBot`, `POLL_MS=30000`, `PORT=7860`, and `PUBLIC_URL=https://<your-user>-<space-name>.hf.space`.
3. Push the repo to the Space (`git remote add space https://huggingface.co/spaces/<user>/<space>`; the root `Dockerfile` is used). The Space README needs this header: `sdk: docker` and `app_port: 7860`.
4. Tell the assistant the new URL. It then (a) sets `VITE_API_BASE` in Vercel and redeploys, (b) points the cron-job.org job and the uptime workflow at it, (c) re-enables the job.
Free Spaces sleep after a period without traffic, so keep the pingers.

## Option C: a second Render workspace
A new workspace has its own 750 hours. Create it with a different login, deploy `render.yaml` there and give Keel the only free service in it. (Check Render's terms before relying on this.)

## After any move
- Telegram webhook is re-registered automatically on start (`PUBLIC_URL`).
- cron-job.org job: `GET <new-url>/cron/tick?key=<CRON_SECRET>` every minute; second job: `GET <new-url>/healthz` every 5 minutes.
- Update `docs/DEPLOY.md`, `render.yaml` and the Vercel variable `VITE_API_BASE`.
