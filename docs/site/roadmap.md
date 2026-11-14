# Roadmap and changelog

## Roadmap

| When | What |
|---|---|
| **Now** | Outside testers on Mezo testnet running guardians, with protections triggered by real price moves (tracked on [/stats](https://keel-miniapp.vercel.app/stats)) |
| **Next** | Keel Pro features: priority keepers, multi-channel alerts, auto-rebalancing strategies. Also withdraw-collateral and Stability Pool screens, and merchant checkout links |
| **Then** | A third-party audit of the guardian, KeelPay and KeelPro, then launch on Mezo mainnet |
| **Scale** | An open keeper network, a Guardian API and white label for other Mezo wallets, team and DAO plans |

## Changelog

### Wave 2

- **Web app without Telegram:**
  - a landing page;
  - sign-in with any wallet: a signed nonce gives a 12-hour session that holds only the wallet address;
  - every app screen in the browser;
  - a read-only demo mode;
  - "Connect Telegram" for alerts.
- **Guardian v2:**
  - partial rescue instead of revert;
  - an `Insufficient` result and `InsufficientReserve` event with the exact BTC shortfall;
  - BTC and MUSD applied in one adjustment;
  - the protocol share of the keeper tip, hard-capped.

  Deployed alongside v1; existing guardians and links keep working. 17 new contract tests.
- **Alerts:** "your reserve can't fully protect your loan, add X BTC", "your guardian can't act yet", and partial-rescue notices.
- **Verified sources:** all 7 Keel contracts are verified on the Mezo explorer.
- **Revenue:** the protocol share of keeper tips is live on-chain; KeelPro subscriptions are deployed; [business model](../BUSINESS.md).
- **Stats:** [/stats](https://keel-miniapp.vercel.app/stats) reads everything from the chain:
  - guardians and loans;
  - every protection, with the BTC price at that block and whether a price move or the owner triggered it;
  - revenue.

  Team wallets are excluded by default.
- **"Set to test":** a trigger just under your ratio, so testers can watch a real price move set off the keeper.
- **Materials:** a pitch deck, these docs, and a redesigned landing page.

### Wave 1

- **Borrowing:** borrow MUSD against BTC from chat or the Mini App, with guardrails (fee, interest, ratio, liquidation price, Mezo's minimums).
- **Guardian v1:** a per-user contract with a permissionless keeper. Proven on testnet: 159.9% → 179.9%.
- **Alerts:** liquidation, redemption queue and Recovery Mode, with one-tap fixes.
- **Payments:**
  - send to @username;
  - bill splits and group requests with on-chain matching;
  - escrowed claim links with a gasless claim.
- **Account:** live balances and history (SSE), natural-language chat, x402 premium alerts.
