# Keel: submission assets

## AKINDO form text

**Project name:** Keel

**One-liner:** Your BTC-backed dollar account inside Telegram. Borrow MUSD on Mezo, get auto-protection from liquidation, and send, split and claim payments with anyone.

**Track:** 2, access / distribution.

**What it does (four pillars):**
1. **Borrow, with guardrails.** Borrow MUSD against BTC from chat or the Mini App. The quote shows the 0.1% fee, fixed interest, ratio and liquidation price; loans Mezo would reject are blocked before signing. The user signs in their own wallet; Keel never holds keys or funds.
2. **Guardian protection.** Each loan lives in a per-user guardian contract. If the ratio falls below the user's trigger, a permissionless keeper calls `protect()` and tops it up from a reserve the user funded. It can do nothing else.
3. **Risk alerts.** Liquidation, redemption-queue rank and Recovery Mode, each with one-tap buttons that open a ready-made fix.
4. **Payments.** Send MUSD to any @username, split bills and request payments in groups, and send escrowed **claim links** to people with no wallet (gasless claim, refund after 72h). Balances, activity and history update live.

Also working: natural-language chat (rule-based, no LLM) and x402 pay-per-use premium alerts in MUSD.

**How it uses Mezo:** Native BTC collateral through `BorrowerOperations` (hints from `HintHelpers` + `SortedTroves`), called from the user's guardian. MUSD is the unit for loans, payments, splits, claim-link escrow and x402 (ERC20Permit + Permit2). Live reads of `TroveManager` / `PriceFeed` / `InterestRateManager` / `SortedTroves` drive risk maths, redemption-queue exposure and Recovery Mode checks. Mezo's rules (110% MCR, 150% CCR, 1,800 MUSD minimum, 200 MUSD gas reserve) are built into every quote. Deployed on Mezo testnet (31611): factory `0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49`, KeelPay `0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29`.

**Why it can be a business:** Telegram distribution plus claim links and splits make every payment an onboarding event for MUSD. Revenue: x402 premium alerts, the guardian keeper tip (capped at 1%), and later small payment fees. For Mezo: more borrowers, fewer liquidations, more MUSD velocity.

**Open source / reuse:** `contracts/` forks mezo-org/musd (GPL-3.0), vendored unmodified for integration testing; Keel's own contracts (`contracts/contracts/keel/`) are GPL-3.0. See NOTICE.md.

**Links:** Bot: https://t.me/KeelMezoBot · Mini App: https://t.me/KeelMezoBot/app · Repo: https://github.com/Im-2/keel · Demo video: `<url>` · Deck: `<url>`

## Updates in this Wave (1,753 characters, limit 3,000)

Since the last wave Keel went from a borrowing bot to a full BTC-backed dollar account in Telegram, organised around four pillars.

Borrow with guardrails: borrow MUSD against BTC from chat or the Mini App. Every quote shows fee, fixed interest, ratio and liquidation price, and unsafe loans (under the 1,800 MUSD minimum, under 110%, or under 150% in Recovery Mode) are blocked before signing. Repay follows Mezo's minimum-debt rule.

Guardian protection: each loan sits in a per-user guardian contract. A permissionless keeper calls protect() when the ratio crosses the user's trigger and tops it up from a reserve the user funded, and it can do nothing else. Proven on testnet: 159.9% to 179.9% in about a minute.

Risk alerts: liquidation, redemption-queue rank and Recovery Mode, each with one-tap buttons that open a ready-to-sign fix.

Payments, new this wave:
- Send MUSD to any @username. Success is shown only after on-chain confirmation, and the recipient gets a Telegram notice.
- Bill splits (equal, custom or percent) and group requests, with live cards, Pay buttons, reminders and on-chain payment matching.
- Escrowed claim links for people without a wallet: they open straight in the Mini App, the claim is gasless, and unclaimed links refund after 72h.
- Live balances, real-time activity and one unified history.

Reliability and trust:
- A block watcher with 3 confirmations, a persisted cursor and deduplicated events.
- A notification outbox.
- A per-user data-isolation audit.
- Official wallet logos for WalletConnect inside Telegram.

Proof: 285 automated tests plus testnet end-to-end runs (payments 17/17, claim links and splits 29/29, x402 premium settlement). Deployed 24/7 (Render + Turso + Vercel) at t.me/KeelMezoBot/app.

## Deck outline (8 slides)

1. **Title:** Keel. Your Bitcoin, spendable and safe, inside Telegram.
2. **Problem:** BTC holders want dollars without selling; loans are a dashboard chore; liquidation and redemption risk hits sleeping users.
3. **Solution:** four pillars: borrow with guardrails, guardian protection, risk alerts, payments (send, split, claim links).
4. **Demo flow:** screenshots in `docs/images`: borrow review, guardian top-up 160% → 180%, send to @username, split card, claim link claimed.
5. **How it works:** architecture diagram (README). Non-custodial: bot makes intents, user signs.
6. **Mezo integration:** the list in README; real-stack tests and e2e script.
7. **Business:** distribution via groups and claim links; revenue streams; why Mezo wins (more borrowers, fewer liquidations, more MUSD velocity).
8. **Security and roadmap:** keeper can only top up from reserve; two-step ownership; claim signatures bind recipient; roadmap and ask.

## Demo video

The final narration script is [`demvid/script.md`](../demvid/script.md). The rendered video is kept out of git; upload `keel-demo-upload.mp4` and paste its link above.
