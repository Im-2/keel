# Keel: submission assets

## AKINDO form text

**Project name:** Keel

**One-liner:** A non-custodial BTC-backed dollar account inside Telegram, built on Mezo's MUSD, with a guardian that protects your loan automatically.

**Track:** 2, access / distribution.

**What it does:** Keel lets anyone borrow MUSD against their Bitcoin from a Telegram chat. The bot quotes the loan (fee, fixed interest, ratio, liquidation price) and the user signs once in their own wallet in a Mini App. A per-user guardian contract owns the loan; if the ratio drops below a trigger, any keeper can top it up from a reserve the user pre-funded, and can do nothing else. Keel also watches the redemption queue and Recovery Mode and sends early alerts, and lets users pay each other in MUSD by @handle, split bills in groups, or send **claim links** to people who have no wallet yet. Premium near-real-time alerts are sold pay-per-use in MUSD over x402.

**How it uses Mezo:** Native BTC collateral via `BorrowerOperations.openTrove` (with `HintHelpers` + `SortedTroves` hints), MUSD as the unit of account for loans, payments, escrow and x402 payments (ERC20Permit + Permit2), live reads of `TroveManager` / `PriceFeed` / `InterestRateManager` for risk math and redemption-queue exposure, deployed on Mezo testnet (31611).

**Why it can be a business:** Telegram distribution plus claim links make every payment an onboarding event; revenue from x402 premium alerts, the guardian keeper tip (capped at 1%), and later small payment fees.

**Open source / reuse:** `contracts/` forks mezo-org/musd (GPL-3.0) vendored unmodified for integration testing; Keel's own contracts (`contracts/contracts/keel/`) are GPL-3.0. Repo: https://github.com/Im-2/keel

**Links to fill in:** Telegram bot: `t.me/<BOT_USERNAME>` · Demo video: `<url>` · Deployed contracts: see `shared/deployments/testnet.json`.

## Deck outline (8 slides)

1. **Title:** Keel. Your Bitcoin, spendable and safe, inside Telegram.
2. **Problem:** BTC holders want dollars without selling; loans are a dashboard chore; liquidation and redemption risk hits sleeping users.
3. **Solution:** Borrow in chat, guardian protection, redemption alerts, pay anyone.
4. **Demo flow:** screenshots: /borrow quote, review-and-sign card, guardian protected alert, claim link.
5. **How it works:** architecture diagram (README). Non-custodial: bot makes intents, user signs.
6. **Mezo integration:** the list in README; real-stack tests and e2e script.
7. **Business:** distribution via groups and claim links; revenue streams; why Mezo wins (more borrowers, fewer liquidations, more MUSD velocity).
8. **Security and roadmap:** keeper can only top up from reserve; two-step ownership; claim signatures bind recipient; roadmap and ask.

## 2-minute demo video script

**0:00 – 0:15 · Hook.** "I hold Bitcoin and I need dollars today, but I don't want to sell. This is Keel, inside Telegram." *(Show the chat with the bot.)*

**0:15 – 0:45 · Borrow.** Type `/borrow 5000 250`. "Keel quotes the exact fee, the fixed interest, my ratio and the price where I'd be liquidated. Nothing happens until I sign." Tap *Review & sign*, show the confirmation card, confirm in the wallet. "5,000 MUSD, in my wallet."

**0:45 – 1:15 · Guardian.** `/protect 180 220`, fund the reserve. "My loan lives in a guardian contract. If Bitcoin drops, a keeper can top up my ratio from my reserve, and can do nothing else." Run the price-drop (`set-price`) or let the keeper tick: show the Telegram message "🛡 Guardian protected your loan: ratio 178% → 220%" with the transaction link.

**1:15 – 1:35 · Alerts.** Show `/position` with the redemption queue line and `/alerts`. "Keel watches the redemption queue and Recovery Mode, so I hear about risk before it reaches me."

**1:35 – 1:55 · Pay anyone.** `/send @friend 25` to a friend without a wallet → claim link → friend taps it, creates a wallet, claims with no gas. In a group: `/split 90 @a @b` and the checkmarks fill in.

**1:55 – 2:00 · Close.** "Keel: non-custodial MUSD for every Telegram user, built on Mezo."

*Recording tips:* use two Telegram accounts (borrower + friend), keep the chain on testnet with the keeper running, and pre-fund the demo wallet.
