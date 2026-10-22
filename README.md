# Keel ⚓

**A BTC-backed dollar account inside Telegram, built on Mezo's MUSD. Non-custodial, with a guardian that protects your loan.**

Built for the Mezo Buildathon, Track 2 (access / distribution).

## The problem

Bitcoin holders want dollars without selling. Mezo's MUSD gives them an interest-fixed loan against BTC, but the experience is a DeFi dashboard: pick a ratio, manage hints, watch a price, and hope you are not liquidated or redeemed while you sleep. Most people (and most of Telegram's 1B users) never get past that.

## What Keel does

| | |
|---|---|
| **Borrow in chat** | `/borrow 5000 250` shows the exact fee, interest, ratio and liquidation price, then you sign once in your own wallet. |
| **Guardian auto-protection** | Your loan lives in a per-user guardian contract. If your ratio falls below your trigger, *anyone* (a keeper bot) can top it up from your pre-funded reserve. The keeper can do nothing else. |
| **Redemption-queue alerts** | Mezo redemptions hit the lowest-ratio loans first. Keel scans the queue and tells you how much MUSD sits ahead of you, plus Recovery Mode flips and ratio warnings with hysteresis (no alert spam). |
| **Pay people, even without a wallet** | `/send @friend 25`, group `/request` and `/split`, and **claim links**: escrow MUSD to an ephemeral key, share a link, the recipient creates or connects a wallet and claims gaslessly. |
| **x402 premium alerts** | Pay-per-use in MUSD (no subscription, no card) for near-real-time monitoring, paid with a Permit2 signature through the Mezo x402 facilitator. |

## Mezo / MUSD integration

- **MUSD is the product.** Native BTC is the collateral (18 decimals, `msg.value`); loans open through Mezo's `BorrowerOperations` with hints from `HintHelpers.getApproxHint` + `SortedTroves.findInsertPosition`.
- **Reads** go straight to `TroveManager`, `PriceFeed`, `InterestRateManager`, `SortedTroves` (batched JSON-RPC): ICR, liquidation price, redemption rank, Recovery Mode (TCR < 150%).
- **Protocol constants respected:** MCR 110%, CCR 150%, 0.1% borrow fee, 1,800 MUSD minimum net debt, 200 MUSD gas compensation, fixed interest rate.
- **MUSD is ERC20Permit** (`name "Mezo USD"`, version `"1"`): used for x402 (Permit2 + EIP-2612 gas sponsoring via `facilitator.vativ.io`, CAIP-2 `eip155:31611`).
- Verified against the **real MUSD contracts**: Keel's 24 contract tests and `bot/scripts/e2e-local.ts` run the full stack (open, add collateral, repay, fund reserve, configure, send, claim link, price drop, keeper `protect`).

## Architecture

```
 Telegram user ──► Bot (grammY) ──creates──► intent (DB row) ─┐
      │                                                       │ opens
      │                                                       ▼
      │                                     Mini App (React + wagmi + RainbowKit)
      │                                       review card ► user signs in OWN wallet
      │                                                       │
      ▼                                                       ▼
 Alerts engine ◄── reads ── Mezo (MUSD stack) ◄── tx ── KeelGuardian (per-user clone)
 Keeper (protect()) ───────────────────────────────────► KeelGuardianFactory
 Claim relayer (gas only) ─────────────────────────────► KeelPay (EIP-712 claim links)
 x402 paywall (Hono) ◄── MUSD Permit2 payment ◄── Mini App ── facilitator.vativ.io
```

- `contracts/contracts/keel/` — `KeelGuardian`, `KeelGuardianFactory` (EIP-1167 clones, deterministic addresses), `KeelPay`.
- `shared/` — ABIs, chain config, risk math (ICR, liquidation price, borrow quotes, redemption rank), batched read client.
- `bot/` — Telegram bot, HTTP API (Hono), alerts, keeper, claim relayer, x402 premium.
- `miniapp/` — wallet linking, review-and-sign screens, claim, premium.

## Security model

- **The bot never holds user keys.** It creates *intents*; the Mini App shows a confirmation card (fee, interest, ratio, liquidation price) and the user signs in their own wallet. The server checks the receipt came from the user's linked wallet before marking an intent done.
- **Wallet binding** = a signed nonce message (single use, 10 min) **plus** Telegram `initData` HMAC verification on every authenticated call.
- **Guardian:** only the owner can move funds out. The public `protect()` can only (a) add collateral from the *reserve*, or (b) repay from the *MUSD reserve*, subject to a cooldown, a tip capped at 1%, and a target of at most 500%. Keepers cannot withdraw, borrow, or redirect anything. Ownership transfer is two-step.
- **Claim links:** the ephemeral private key lives only in the link. The signature binds the destination (`Claim(link, to)`), so the relayer or a mempool observer cannot redirect funds. Senders can cancel any time; expired links refund to the sender. With a BotFather *Direct Link* (`MINIAPP_SHORTNAME`) the key goes straight to the Mini App via `startapp` and never reaches the bot.
- **Premium:** x402 payments are verified and settled by the facilitator; the bot only learns that a payment succeeded.
- Fund-moving guardian functions are `nonReentrant`; the reserve is separate from collateral the owner locked, and protection only spends what the owner put in the reserve.
- Not audited. Testnet software; do not put funds you cannot lose on mainnet.

## Reused code (open source, GPL-3.0)

`contracts/` is a fork of [mezo-org/musd](https://github.com/mezo-org/musd) (GPL-3.0). Everything under `contracts/contracts/` except `keel/` is Mezo / Thesis' code, vendored unmodified so Keel's tests run against the real protocol. Keel's own contracts are also GPL-3.0. See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).

## Run it

Requirements: Node 22+, pnpm 10.

```bash
pnpm install

# 1. Local chain with seeded MUSD troves (optional, for development)
cd contracts && KEEL_SOLCJS=1 pnpm dev:chain         # terminal 1
cd bot && pnpm tsx scripts/e2e-local.ts               # terminal 2: end-to-end check

# 2. Tests
pnpm --filter @keel/shared test
pnpm --filter @keel/bot test && pnpm --filter @keel/bot typecheck
cd contracts && pnpm test:keel
```

### Deploy to Mezo testnet

```bash
cd contracts
cp .env.example .env                  # set MATSNET_PRIVATE_KEY (funded with testnet BTC)
pnpm deploy:keel:testnet              # writes shared/deployments/testnet.json
```

### Run the bot + Mini App

```bash
cp bot/.env.example bot/.env          # BOT_TOKEN, BOT_USERNAME, MINIAPP_URL, KEEPER_PRIVATE_KEY, ...
cp miniapp/.env.example miniapp/.env  # VITE_WC_PROJECT_ID
pnpm --filter @keel/miniapp build     # the bot serves miniapp/dist
pnpm --filter @keel/bot start         # API + bot + alerts + keeper on :8787
# expose :8787 over HTTPS (any tunnel) and set MINIAPP_URL to that URL
```

In BotFather: `/newbot`, then `/newapp` (optional Direct Link short name → `MINIAPP_SHORTNAME`) pointing at `MINIAPP_URL`.

## Business viability

- **Distribution is the moat:** Telegram's reach plus group payments and claim links turn every payment into an onboarding event for MUSD (a recipient needs no wallet to receive).
- **Revenue:** (1) x402 premium alerts, paid in MUSD; (2) a keeper tip (≤1% of the amount applied) on each protection, already built into the guardian; (3) later, an opt-in small fee on claim-link creation and group payments.
- **Why it helps Mezo:** more borrowers (lower friction), fewer liquidations (guardians keep loans healthy, which is good for system TCR), and more MUSD velocity (payments).

## Roadmap

Withdraw / close-loan screens in the Mini App, stability-pool savings, fiat off-ramp partners, multi-keeper network with open keeper registration, mainnet launch after audit.
