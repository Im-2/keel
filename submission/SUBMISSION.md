# Keel: Mezo Buildathon Wave 2 submission

**Project:** Keel · **Track:** access / distribution

**One-liner:** Your BTC-backed dollar account. Borrow MUSD on Mezo without selling, stay protected from liquidation automatically, and send, split and claim payments, in Telegram or in any browser.

## Links

| What | Link |
|---|---|
| Web app (no Telegram needed) | https://keel-miniapp.vercel.app |
| Telegram Mini App | https://t.me/KeelMezoBot/app |
| Read-only demo (sample data) | https://keel-miniapp.vercel.app/?demo=1 |
| Live stats (on-chain) | https://keel-miniapp.vercel.app/stats |
| Pitch deck | https://keel-miniapp.vercel.app/keel-deck.pdf (also `submission/keel-deck.pdf`, `.pptx`) |
| Code | https://github.com/Im-2/keel |
| Business model | https://github.com/Im-2/keel/blob/main/docs/BUSINESS.md |
<!-- video --><!-- /video -->| Docs | https://keel-miniapp.vercel.app/docs |
| Wave 2 checklist (evidence for each judge point) | https://keel-miniapp.vercel.app/docs/wave2 |

## Contracts on Mezo testnet (all verified on explorer.test.mezo.org)

| Contract | Address |
|---|---|
| KeelGuardianFactory v2 | 0x85579beE60dc659e014610e57935379F8A9B79E1 |
| KeelGuardian v2 implementation | 0xCCF76173D1F312b3b5c3e55A6dDBD8046f30E8eF |
| KeelPay v2 | 0x3777b89a32cD85FfA0a49b062CDb80e66E66740d |
| KeelPro | 0x59b1CEB919378C59FB5F3D735f81c353aA1D8654 |
| KeelGuardianFactory v1 | 0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49 |
| KeelGuardian v1 implementation | 0x07F411F2EE6AC7BA758ab234FC20Eb6F5f13445D |
| KeelPay v1 | 0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29 |

## Updates in this Wave

<!-- paste-ready; under 3,000 characters -->
We worked through the Wave 1 feedback point by point.

Web link without Telegram: keel-miniapp.vercel.app now opens a landing page, and "Open web app" signs in with any wallet (MetaMask or WalletConnect) by signing a server nonce. Every screen works there: borrow, repay, collateral, protection, reserve, send, claim links, splits and history. A read-only demo with sample data lets judges see everything without testnet BTC. Sessions carry only the wallet address and the server resolves the account on every request (15 new tests). A web account can attach Telegram later for alerts.

Partial rescue: we read MUSD's BorrowerOperations. In Normal Mode, any adjustment that leaves ICR under 110% is rejected; in Recovery Mode, top-ups and repayments are allowed at any ratio. Guardian v2's protect() never fails just because the reserve is small. It applies the best BTC top-up plus MUSD repayment in one adjustment and returns Full or Partial (with a PartialRescue event). When Mezo would reject anything the reserve can afford, it moves nothing, pays no tip and emits InsufficientReserve with the exact BTC to add. The bot turns that into "add X BTC" alerts with a one-tap button. 17 new contract tests run against the real MUSD stack. v2 is deployed; existing v1 guardians and links keep working.

Verified sources: all 7 Keel contracts (both factories, both implementations, both KeelPay contracts, and KeelPro) show verified source on the Mezo explorer.

Firmer revenue: a protocol share of every keeper tip now goes on-chain to Keel's treasury (20% today, hard-capped at 50%; the owner still pays at most 1%). The KeelPro subscription contract is live. docs/BUSINESS.md adds merchant checkout (0.3-0.5%, P2P stays free), team plans and Guardian API licensing, with sizing, unit economics and a sensitivity table.

Real protections: /stats reads everything on-chain. So far there are 4 keeper protections, 2 triggered by real BTC price moves, with oracle price and ICR before and after for each. Honestly, every guardian so far is the team's own. A new "Set to test" button puts the trigger just under your ratio so outside testers can watch a real price dip set the keeper off.

Also new: a pitch deck and a redesigned landing page. 320 tests pass.
