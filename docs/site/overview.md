# Overview

Keel is a **BTC-backed dollar account** built on [Mezo](https://mezo.org). You borrow MUSD (Mezo's Bitcoin-backed stablecoin) against your BTC without selling it, a **guardian** contract protects the loan from liquidation, and you can **send, split and claim payments** with anyone. Keel runs as a Telegram bot and Mini App, and as a web app in any browser.

Keel is **non-custodial**. The server never holds keys or funds: it prepares an action (an *intent*), shows you exactly what will happen, and you sign it in your own wallet.

> **Status.** Keel is live on **Mezo testnet** (chain 31611). It is testnet software and has not been audited. Every Keel contract has verified source on the Mezo explorer; see [Contracts and verification](contracts.md).

## Who it's for

- **Bitcoin holders who need dollars** but don't want to sell, give up the upside or trigger a tax event.
- **People already borrowing on Mezo** who want their loan watched and protected while they sleep.
- **Telegram communities, creators and small merchants** who split costs and collect payments in a stable unit.
- **Wallets and apps on Mezo** that want liquidation protection for their own users (planned API).

## The four pillars

### 1. Borrow, with guardrails
Ask in chat ("borrow 1800 at 160%") or use the app. Before you sign, Keel shows:
- the one-time 0.1% fee;
- the fixed interest rate;
- your collateral ratio and liquidation price.

Loans Mezo would reject are blocked before you get to the wallet. See [How borrowing works](borrowing.md).

### 2. Guardian protection
Each loan lives in your own guardian contract.
- You fund a small reserve and choose a trigger, for example "below 170%, bring me back to 180%".
- When the ratio falls below the trigger, **anyone** can call `protect()`, and Keel runs a keeper that does.
- `protect()` can only move your reserve into your own loan. The keeper's tip is capped at 1%.
- **Guardian v2** helps even when the reserve is too small: it rescues as far as the reserve allows and tells you exactly how much BTC to add.

See [Guardian protection](guardian.md).

### 3. Risk alerts
Keel watches three things and offers a one-tap fix for each:
- the distance to liquidation;
- your place in Mezo's redemption queue;
- Recovery Mode.

See [Alerts and notifications](alerts.md).

### 4. Payments
- Send MUSD to any @username or address.
- Split bills with a live card.
- Request payments in a group.
- Send **claim links** to people without a wallet: they claim in one step and Keel pays their gas.

See [Payments](payments.md).

## Where to use it

| Way in | Link | Notes |
|---|---|---|
| Telegram bot | [t.me/KeelMezoBot](https://t.me/KeelMezoBot) | Chat commands and natural language; alerts arrive here |
| Telegram Mini App | [t.me/KeelMezoBot/app](https://t.me/KeelMezoBot/app) | The full app inside Telegram |
| Web app | [keel-miniapp.vercel.app](https://keel-miniapp.vercel.app/#/app) | No Telegram needed: sign in with your wallet |
| Demo mode | [keel-miniapp.vercel.app/?demo=1](https://keel-miniapp.vercel.app/?demo=1#/) | Every screen with sample data, nothing is signed |
| Live stats | [keel-miniapp.vercel.app/stats](https://keel-miniapp.vercel.app/stats) | On-chain numbers: guardians, loans, protections |

## Where to go next

- New here? Start with the [Quick start](quick-start.md).
- Evaluating the project? See the [Wave 2 checklist](../WAVE2_CHECKLIST.md), the [Security model](security.md) and the [Business model](../BUSINESS.md).
- Building on it? See [Developers](developers.md) and [Architecture](architecture.md).
