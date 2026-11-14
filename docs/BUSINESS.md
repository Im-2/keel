# Keel: business model

Keel is a BTC-backed dollar account on Mezo: borrow MUSD against Bitcoin, keep the loan safe with a guardian, and pay anyone, in Telegram or the browser. This page explains who pays Keel, for what, and how big it can get. **Every number below is either read from the chain or an assumption labelled as one.** Keel has no paying users yet. Today every guardian on testnet belongs to the team (see [live stats](https://keel-miniapp.vercel.app/stats)).

## Who it's for

| Segment | Need | Why Keel |
|---|---|---|
| **Bitcoin holders who need dollars** (primary) | Spend without selling BTC; no tax event, keep upside | A 0.1% fee, fixed-rate MUSD loan from a chat, with the loan protected while they sleep |
| **Holders who already borrow on Mezo** | Liquidation and redemption risk, constant monitoring | Guardian auto-protection plus alerts on liquidation, redemption-queue position and Recovery Mode |
| **Telegram communities, creators and small merchants** | Collect and split payments in a stable unit | Split cards, payment requests and claim links in the chat they already run |
| **Wallets and apps on Mezo** | Protection for their own users without building a keeper network | Guardian protection via API or white label |

## Revenue streams

### 1. Protocol share of the keeper tip (live in the contract)
- **How it works:** when a guardian protects a loan, the owner pays a keeper tip, at most 1% of the amount applied. The owner sets the tip; the default is 0.2%.
- **Keel's share:** `KeelGuardianFactoryV2` sends a share of that tip to Keel's treasury, on-chain.
- **Hard caps:** the share can never exceed **50% of the tip**. The cap is enforced in both the factory and the guardian (`MAX_PROTOCOL_SHARE_BPS`).
- **Cost to the owner:** unchanged. The share comes out of the tip, not on top of it.
- **Today:** the share is set to 20%. Every fee shows up as a `ProtocolFeePaid` event and on the stats page's revenue panel.
- **Contract:** [`0x85579beE60dc659e014610e57935379F8A9B79E1`](https://explorer.test.mezo.org/address/0x85579beE60dc659e014610e57935379F8A9B79E1).

### 2. Keel Pro (subscription contract live, features partly built)
- **Free tier:**
  - one guardian;
  - standard keeper;
  - alerts checked every few minutes;
  - all payments.
- **Pro:**
  - alerts checked every few seconds (already built as the x402 premium);
  - priority keepers;
  - multi-channel alerts;
  - auto-rebalancing strategies (for example, keep the ratio between 170% and 200% using both reserves);
  - higher limits on links and splits.
- **Price:** 5 MUSD per 30 days, or 0.25% per year of protected debt for large loans, whichever is higher.
- **Contract:** `KeelPro` [`0x59b1CEB919378C59FB5F3D735f81c353aA1D8654`](https://explorer.test.mezo.org/address/0x59b1CEB919378C59FB5F3D735f81c353aA1D8654).
  - It takes MUSD straight to the treasury, and time stacks on top of an active subscription.
  - Anyone can pay for any wallet, which covers gifts and team plans.
  - The price is hard-capped at 100 MUSD per 30 days.

### 3. Merchant, creator and community checkout (planned)
- Payment links and checkout for sellers carry **0.3–0.5% per payment**.
- **Person-to-person sends, splits between friends and claim links stay free.** They are how the network grows: every claim link brings a new person onto MUSD.

### 4. Team and DAO treasury plans (planned)
- Shared expense tracking, recurring splits and group payouts for teams, DAOs and clubs.
- About 20–50 MUSD per workspace per month.

### 5. API and white-label Guardian (planned)
- Other Mezo wallets and apps plug in guardian protection and Keel's keeper for their users.
- Either a revenue share of the protocol fee (for example, half to the integrator) or a flat 500–2,000 MUSD per month per integrator.

## Market sizing (top-down, with assumptions)

| Input | Value | Source / assumption |
|---|---|---|
| Telegram monthly users | ~1 billion | Telegram's public statements (2025) |
| People holding crypto | ~560 million | Triple-A global estimate (2024); order-of-magnitude only |
| Share of crypto holders who hold BTC | assume 50% | Assumption |
| Share of BTC holders who would borrow against it in a year | assume 2% | Assumption; borrowing is a minority behaviour |
| Share of those Keel could reach through Telegram and Mezo in 3 years | assume 1% | Assumption |
| **Reachable borrowers** | **~56,000** | 560M × 50% × 2% × 1% |

We treat this as a ceiling to sanity-check the model, not a forecast.

## Unit economics per active borrower (assumptions)

| Assumption | Value |
|---|---|
| Average loan | 5,000 MUSD at ~180% (≈ $9,000 BTC collateral) |
| Protections per year | 3, each adding ~6% of collateral (≈ $540 applied) |
| Keeper tip / Keel share | 0.2% / 20% |
| Pro adoption | 15% of borrowers at 60 MUSD per year |
| Merchant checkout | 5% of users sell, 3,000 MUSD per year of volume each, 0.4% fee |

Per average active borrower per year:
- protocol share: 3 × $540 × 0.2% × 20% = **$0.65**
- Pro: 15% × 60 = **$9.00**
- checkout: 5% × 3,000 × 0.4% = **$0.60**
- **Total ≈ $10.25 per user per year.**

**Costs:**
- Keeper and relayer gas on Mezo: cents per action.
- Hosting: about $50–300 per month at this scale.
- The main cost is people.

The protocol share is small per user. It matters at volume and through integrators (stream 5). It's also the stream that grows automatically with protected debt.

### Sensitivity: annual revenue (USD)

| Active borrowers | Pro 5% | Pro 15% | Pro 30% |
|---|---|---|---|
| 1,000 | 4,250 | 10,250 | 19,250 |
| 10,000 | 42,500 | 102,500 | 192,500 |
| 50,000 | 212,500 | 512,500 | 962,500 |

Each cell is borrowers × ($0.65 protocol share + $0.60 checkout + Pro% × $60).

**Not included:**
- team plans;
- API licensing;
- larger loans: protocol fees scale linearly with protected debt, so at a 25,000 MUSD average loan the protocol share alone is about $3.25 per user per year.

## Why it's good for Mezo
- **More borrowers:** borrowing becomes a chat message instead of a dashboard.
- **Fewer liquidations:** guardians top loans up before 110%, which keeps the system ratio healthy.
- **More MUSD velocity:** sends, splits and claim links put MUSD in front of people who don't have it yet.

## What has to be true (risks)
- **Real third-party users.** Today only the team has used Keel on testnet. The landing page, web app and "set to test" helper exist so outside testers can try a real price-triggered protection.
- **Audits before mainnet.** The guardian contracts move user funds; the protocol share and KeelPro caps are enforced in code, but nothing is audited yet.
- **Keeper reliability.** Protection is only as good as the keeper. Because `protect()` is permissionless, anyone can run one, and stream 5 pays integrators to do so.
