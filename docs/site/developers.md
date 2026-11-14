# Developers

Keel is open source under **GPL-3.0**: [github.com/Im-2/keel](https://github.com/Im-2/keel).

## Repo layout

| Path | Contents |
|---|---|
| `contracts/` | Fork of mezo-org/musd plus Keel's contracts in `contracts/keel/`; Hardhat tests against the real MUSD stack |
| `shared/` | ABIs (generated), deployments, risk maths, chain readers |
| `bot/` | API, Telegram bot, keeper, relayer, block watcher, alerts, stats; testnet scripts in `bot/scripts/` |
| `miniapp/` | React app: Mini App, web app, landing page, docs site |
| `docs/` | Markdown docs (`docs/site/` is what this site renders), status, business model, images |
| `submission/` | Pitch deck (PDF and PPTX), deck source, submission text, landing screenshots |

## Run locally

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp .env.example .env                        # names only; fill in your own values
cp miniapp/.env.example miniapp/.env.local
pnpm --filter @keel/miniapp dev             # app on :5173
pnpm --filter @keel/bot dev                 # bot + API + keeper + watcher on :8787
```

To work on the web app without a Telegram bot, run the API with no Telegram connection:

```bash
cd bot && PORT=8790 npx tsx --env-file=../.env scripts/web-dev.ts
```

## Environment variables (names only)

| Where | Variables |
|---|---|
| Bot / API (required) | `BOT_TOKEN`, `BOT_USERNAME`, `MINIAPP_URL`, `NETWORK` |
| Bot / API (optional) | `MINIAPP_SHORTNAME`, `PUBLIC_URL`, `KEEPER_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `KEEPER_MIN_BTC`, `ADMIN_IDS`, `RPC_URL`, `PORT`, `POLL_MS`, `DB_PATH`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET`, `KEEL_FACTORY`, `KEEL_PAY`, `PREMIUM_PAY_TO`, `PREMIUM_PRICE_MUSD`, `PREMIUM_DAYS`, `X402_FACILITATOR_URL` |
| App (build time) | `VITE_API_BASE`, `VITE_WC_PROJECT_ID`, `VITE_DEMO_VIDEO_URL` (optional; overrides `keel.config.json`) |
| Scripts / deploys | `DEPLOYER_PRIVATE_KEY`, `MATSNET_PRIVATE_KEY` |

Every name is listed in `.env.example`, `bot/.env.example`, `miniapp/.env.example` and `contracts/.env.example`. Never commit `.env`.

## Deploy

```bash
cd contracts && pnpm deploy:keel:v2:testnet       # factory v2 + implementation, KeelPay, KeelPro; previous ones become `legacy`
python contracts/scripts/verify-blockscout.py      # verify every contract on the explorer
```

| Part | Host and settings |
|---|---|
| API and bot | Render web service (`render.yaml`), Turso mirror, a scheduler calling `/cron/tick` |
| App | Vercel (`vercel.json`); the build prerenders the landing page and every docs page |

## Tests

```bash
cd contracts && KEEL_SOLCJS=1 npx hardhat test test/keel/*.test.ts   # 41 tests: v1 + v2 against the real MUSD stack
pnpm --filter @keel/bot test        # 242 tests
pnpm --filter @keel/shared test     # 25 tests
pnpm --filter @keel/miniapp test    # 12 tests
pnpm --filter @keel/miniapp e2e     # Playwright: every landing link at 375px and 1440px (E2E_URL to target a deployment)
```

Testnet end-to-end scripts in `bot/scripts/`, which need funded testnet keys:

| Script | Covers |
|---|---|
| `guardian-v2-testnet.ts` | Full, partial and insufficient v2 rescues |
| `payments-testnet.ts` | Payments |
| `claims-splits-testnet.ts` | Claim links and splits |
| `x402-testnet.ts` | x402 premium |

## API overview

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/config` | public | Network, chain id, deployment addresses |
| `GET /api/stats[?all=1]` | public | On-chain stats (team wallets excluded unless `all=1`) |
| `GET /api/claim/:link`, `POST /api/claim/relay` | link key | Claim-link info and gasless claim |
| `POST /api/web/nonce`, `POST /api/web/session`, `POST /api/web/logout` | public / session | Wallet sign-in for the web app |
| `POST /api/web/telegram` | session | One-time code to attach Telegram to a web account |
| `GET /api/me`, `GET /api/position`, `GET /api/activity`, `GET /api/market` | user | Account, loan and balances, history, price |
| `POST /api/intent`, `GET /api/intent/:id`, `POST /api/intent/:id/complete` | user | Create, read and settle intents |
| `GET/POST /api/splits`, `/api/split/:id[/pay\|remind\|cancel]`, `/api/request/:id/pay` | user | Splits and requests |
| `POST /api/live/token`, `GET /api/live` | user | Short-lived token, then a server-sent events stream |
| `POST /api/nonce`, `POST /api/bind`, `POST /api/disconnect`, `POST /api/handoff` | Telegram | Wallet linking and handoff |

"User" means Telegram `initData` (header `x-telegram-init-data`) or a web session (header `x-keel-session`).

## Contributing

- Open an issue or a pull request on GitHub.
- Keep changes tested: contracts against the real MUSD stack, the API with the in-memory store.
- Never commit secrets. Run gitleaks before pushing.

## License and credits

- **Keel:** GPL-3.0.
- **MUSD:** `contracts/` builds on [MUSD by Mezo / Thesis](https://github.com/mezo-org/musd) (GPL-3.0). Everything under `contracts/contracts/` except `keel/` is vendored unmodified, so Keel's tests run against the real protocol.
- **Fonts and logos:**
  - Onest, the landing font, is SIL OFL 1.1.
  - Wallet logos come from the WalletConnect registry and belong to their owners.

See [NOTICE.md](https://github.com/Im-2/keel/blob/main/NOTICE.md).
