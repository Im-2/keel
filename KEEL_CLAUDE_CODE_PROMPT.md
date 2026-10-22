# Paste this into Claude Code (run it inside the unzipped `keel/` folder)

You are building **Keel**, a Telegram bot + Mini App for the Mezo Buildathon (Track 2: access/distribution). Keel is a non-custodial, BTC-backed dollar account inside Telegram, built on Mezo's MUSD. Goal: win. Judging: Mezo Integration 30, Product & Business Viability 30, Technical 20, UX 10, Materials 10. Move fast, build for real, no planning documents; just write code, run it, commit often.

## Already built (do not redo; read it first)
- `contracts/`: fork of mezo-org/musd (GPL-3.0, see NOTICE.md) plus `contracts/contracts/keel/`:
  - `KeelGuardian.sol` (per-user clone owning the trove; owner functions; permissionless keeper `protect()` with tip cap, cooldown and reserve-only funding; `protectionStatus()`),
  - `KeelGuardianFactory.sol`,
  - `KeelPay.sol` (EIP-712 escrowed claim links, relayable, cancel/refund).
  - 24 passing tests against the real MUSD stack (`pnpm test:keel`, compile with `KEEL_SOLCJS=1` if solc download is blocked).
  - `scripts/dev-chain.ts` (local chain with seeded troves + demo user), `scripts/set-price.ts`, `scripts/deploy-keel.ts`.
- `shared/` (`@keel/shared`): generated ABIs, chains (testnet 31611 / mainnet 31612 / local), addresses, risk math (ICR, liquidation price, quoteBorrow, redemption rank), batched read client (readSystem/readTrove/scanTroves/findGuardian/readGuardian). Tests pass.
- `bot/` (`@keel/bot`): config, Telegram initData validation, SQLite store (node:sqlite), ChainService, message formatters, parse helpers (`parse.ts`), and a first draft of `src/bot.ts` (grammY commands). **Known issue to fix first:** `ctx.match` is `string | RegExpMatchArray`; add a helper `args(ctx)` that returns a string for command handlers and make `tsc --noEmit` clean. Check `Store` method names used in bot.ts (`createIntent`, `findByUsername`, `createRequest`, `getRequest`, `setRequestMessage`, `updateSettings`, `getKv`) against `db.ts` and add any that are missing.

## Architecture rules
- The bot never holds user keys. It creates "intents" (DB rows); the Mini App opens `/#/i/<id>` and the user signs in their own wallet. Wallet binding = signed message + Telegram initData HMAC.
- Mezo: native BTC is collateral (18 decimals, msg.value). MCR 110%, CCR 150%, borrow fee 0.1%, min net debt 1,800 MUSD, $200 gas comp. Hints via HintHelpers.getApproxHint + SortedTroves.findInsertPosition. MUSD is ERC20Permit (name "Mezo USD", version "1").

## Remaining work, in order
1. **Bot finish**: `api.ts` (Hono: nonce, bind, intent fetch/complete, claim relay via a gas-only relayer key, healthz), `alerts.ts` (poll loop with hysteresis: ICR warn/danger, redemption exposure, Recovery Mode flip, Guardian `Protected` events, incoming MUSD transfers), `keeper.ts` (scan factory guardians, call `protect()` when `protectionStatus().canProtect`), `index.ts` (wire it up, long polling for dev). Handler tests with a stubbed Telegram API via `bot.handleUpdate`.
2. **Mini App** (`miniapp/`: Vite + React + wagmi + viem + RainbowKit/`@mezo-org/passport`, `@telegram-apps/sdk` or the raw WebApp object, hash routing):
   - screens: link wallet (sign), position/risk gauge, borrow (create guardian then `openTrove` with computed hints), repay, add collateral, protection settings, fund reserve, send, create claim link (ephemeral key stays client-side; share `t.me/<bot>?start=claim_<key>`), claim screen (recipient connects or creates a wallet, signs `Claim(link,to)`, bot relays), pay a request.
   - Every tx screen shows a confirmation card: fee, interest, ICR, liquidation price.
3. **x402 premium alerts**: pay-per-use in MUSD (check `@x402/evm`, `@x402/express`; facilitator `facilitator.vativ.io`, CAIP-2 `eip155:31611` / `eip155:31612`). Premium = faster polling / extra channels. Verify packages exist before relying on them; if not, stub behind an interface and say so.
4. **Deploy and verify**: `pnpm deploy:keel:testnet` (needs a funded deployer key in `.env`), put addresses in `shared/deployments/`, run the bot against Mezo testnet (RPC `https://rpc.test.mezo.org`), verify end to end: link, borrow, price drop or extra borrow triggers `protect`, alert arrives, claim link works.
5. **Submission assets**: README (problem, architecture diagram, how Mezo/MUSD is integrated, security model, run instructions), deck outline, 2-minute demo video script, AKINDO form text. Cite the reused MUSD code (open source, GPL-3.0).

## Pitch to keep in view
Keel turns BTC into usable dollars inside Telegram without selling it, and protects the loan automatically. Differentiators: guardian auto-protection, redemption-queue alerts, group payments and claim links for people without wallets, all non-custodial.

## Needs from me (ask me, don't invent)
BOT_TOKEN (BotFather), a public HTTPS URL for the Mini App (tunnel), a deployer private key with testnet BTC, WalletConnect project id.

Start by getting `bot/` to typecheck and its tests green, commit, then move down the list.
