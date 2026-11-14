# Wave 2 checklist

Each point of the Wave 1 judge feedback, with its status and the evidence behind it. Statuses:
- **Done and proven:** shown on Mezo testnet or on the live site, with links.
- **Done, not yet proven on-chain:** built and tested, but the on-chain run is still outstanding.
- **Not done:** with the reason.

Commit links point to [github.com/Im-2/keel](https://github.com/Im-2/keel/commits/main).

| # | Judge point | Status |
|---|---|---|
| 1 | A web link judges can open without Telegram | **Done and proven** |
| 2 | `protect()` does a partial rescue instead of reverting | **Done and proven in tests and on testnet for v1 partial top-ups; the v2 on-chain run is not done yet** (needs testnet BTC, see 2d) |
| 3 | Verify the sources on the Mezo explorer | **Done and proven** (7 of 7) |
| 4 | A firmer revenue model | **Done**: protocol share live on-chain; KeelPro deployed; full model documented |
| 5 | A pitch deck | **Done** |
| 6 | Real third-party users and protections from actual price moves | **Tracking ready and honest; the users are not there yet** |

## 1. A web link without Telegram: done and proven

| Evidence | |
|---|---|
| Live URL | [keel-miniapp.vercel.app](https://keel-miniapp.vercel.app): the landing page; **Open web app** goes to wallet sign-in; [demo mode](https://keel-miniapp.vercel.app/?demo=1#/) with sample data; [docs](https://keel-miniapp.vercel.app/docs); [stats](https://keel-miniapp.vercel.app/stats) |
| How it works | A signed single-use nonce gives a 12-hour session holding only the wallet address; the account is resolved server-side on every request. See [Web mode](site/web-mode.md) |
| Tests | `bot/test/web-auth.test.ts`: **15 tests** covering nonce message, replay, wrong signer, nonce for another address, expiry, logout, isolation (client-supplied ids and addresses ignored), initData precedence, Telegram-only routes refused, intents for web users, the Telegram link and merge, and unlinking ending sessions. All pass (bot suite: 242/242) |
| End to end | A real wallet signed in through the browser (injected test wallet) and reached the dashboard with its own data. In a fresh incognito Chrome: `/` shows the landing page, `#/app` the sign-in, `?demo=1` the demo, `/stats` the stats, and Telegram launch data still goes straight to the app |
| Link QA | Playwright clicks every landing link at 375px and 1440px against production; see [docs/QA.md](QA.md) |
| Commits | [097b340](https://github.com/Im-2/keel/commit/097b340) web mode · [2bb1075](https://github.com/Im-2/keel/commit/2bb1075) landing and stats · [248fc44](https://github.com/Im-2/keel/commit/248fc44) clickable cards · [e3f129d](https://github.com/Im-2/keel/commit/e3f129d) docs site |

**Limitation:** alerts are Telegram messages. A web-only account must use **Connect Telegram** to receive them.

## 2. Partial rescue instead of revert

### 2a. What Mezo allows (read from the MUSD source)
In `BorrowerOperations._adjustTrove`:
- **Normal Mode** requires the resulting ICR to be at least 110% (and TCR at least 150%) for **any** adjustment.
- **Recovery Mode** allows a pure top-up and/or repayment at any ratio.
- A repayment must also leave net debt at or above `minNetDebt`.

So a top-up that can't lift a loan back over 110% is rejected by Mezo itself, not by Keel.

### 2b. The change: done
`KeelGuardianV2.protect()` returns a `Result`:
- `Full` (0) and `Partial` (1): funds move. `Partial` adds `PartialRescue(…, btcShortfall)`.
- `Insufficient` (2): when nothing Mezo would accept is affordable, it moves nothing, pays no tip, leaves the cooldown free, **doesn't revert**, and emits `InsufficientReserve(icr, btcShortfallToMCR, btcShortfallToTarget, recoveryMode)`.

BTC and MUSD are applied in one `adjustTrove`. `previewProtect()` returns the plan without sending anything. See [Guardian protection](site/guardian.md).

### 2c. Proven in tests against the real MUSD stack: done
`contracts/test/keel/KeelGuardianV2.test.ts`, **17 passing** (41 Keel contract tests in total):
- factory v2 clones a V2 implementation deterministically, once per owner;
- hard-caps the protocol share at 50% of the tip, and only the admin can change it;
- transfers admin in two steps;
- **full rescue:** restores the target and pays the keeper its tip minus the treasury's 20% share;
- pays no protocol share when the treasury is unset;
- **partial rescue:** applies the whole reserve, emits `PartialRescue` with the exact shortfall, and the shortfall really completes it;
- combines BTC and MUSD in one adjustment when BTC alone would leave the loan under 110%;
- **impossible rescue (Normal Mode, below 110%):** moves nothing, pays no tip, keeps the cooldown free, and reports the BTC needed to clear 110%. The same test shows Mezo itself rejecting the sub-110% top-up;
- respects MUSD's minimum net debt: a minimum-size loan can only be repaid down to the minimum;
- **Recovery Mode:** allows a partial top-up even if the loan stays under 110%;
- treats a dust reserve as nothing to do (no revert, no tip);
- an insufficient result can repeat (no cooldown); a rescue can't (cooldown applies);
- at the maximum (1% tip, 50% share) the owner pays exactly 1% of what was applied;
- a keeper contract can't re-enter `protect()` through its tip;
- only the owner controls funds and settings;
- it still reverts when not eligible: disabled, no trove, healthy;
- KeelPro takes MUSD straight to the treasury, stacks time, and caps the price.

The bot side is also tested: the "reserve can't fully protect your loan" and "your guardian can't act yet" alerts (with the exact BTC plus 2%), and the partial-rescue notice (`bot/test/alerts-keeper-api.test.ts`).

### 2d. v2 on Mezo testnet: deployed and verified, but the rescue runs are **not done yet**

**Deployed and verified (deploy transactions):**
- KeelGuardianFactoryV2: [0x98faa485…](https://explorer.test.mezo.org/tx/0x98faa485442c69b933ffe547d57bcc2f9eb0653532384d1bef06ac7ff339d0bf)
- KeelPay v2: [0xdfcd666f…](https://explorer.test.mezo.org/tx/0xdfcd666fe08f3ad1bbdf5dd767203120ed57a19f6a17d1b8211d1b649da245db)
- KeelPro: [0x5bd17e59…](https://explorer.test.mezo.org/tx/0x5bd17e59ce1dd6e2f963a89a75bca2f3faa028210a37804bccf078ee0a16b217)

The keeper, bot, API and app support v1 and v2 side by side.

**What's ready:** `bot/scripts/guardian-v2-testnet.ts` runs the three rescues on one fresh loan, through the production code paths (Mini App plans, the keeper key, the bot's alert engine):
- (c) insufficient, with an empty reserve;
- (b) partial, with about 30% of the shortfall;
- (a) full, after adding the reported shortfall.

**Why it hasn't run:** the team's deployer wallet holds 0.0006 testnet BTC. One minimum MUSD loan needs about 0.05 BTC, and the Mezo faucet is behind a CAPTCHA that only a person can complete.

**To finish it:**
1. Send about **0.06 testnet BTC** from [the faucet](https://faucet.test.mezo.org) to the test wallet `0xf44c91FFE03bb6e540253706338e196f6c3D3001`. It's listed as a team wallet, so `/stats` won't count it as a user.
2. Run `cd bot && npx tsx --env-file=../.env scripts/guardian-v2-testnet.ts`.
3. The transaction hashes are written to `.keel-data/guardian-v2-e2e.json` and appear on [/stats](https://keel-miniapp.vercel.app/stats) (tick "include the team's wallets").

| Run | Transaction | Result |
|---|---|---|
| (c) insufficient (empty reserve) | *pending: needs testnet BTC* | |
| (b) partial (small reserve) | *pending* | |
| (a) full (reserve topped up by the reported shortfall) | *pending* | |

### 2e. What testnet already shows (v1): proven
v1 guardians on testnet, read on-chain by [/stats](https://keel-miniapp.vercel.app/stats). All four are team wallets:

| Transaction | Result | Ratio | BTC price | Trigger |
|---|---|---|---|---|
| [0x297323ed…](https://explorer.test.mezo.org/tx/0x297323edc0a2000ec4137fe0fd521fbe9f78ea651511e0bbaf6ce967f8a35c2e) | full | 160.0% → 180.0% | $81,168 | owner (trigger set above the ratio) |
| [0x50e028be…](https://explorer.test.mezo.org/tx/0x50e028be8cf6cb971f06762e275d7e9a96c2eb151baa5a547c23880353076a19) | full | 160.0% → 180.0% | $80,500 | owner |
| [0x343eaafc…](https://explorer.test.mezo.org/tx/0x343eaafcf9d1bdf3938f4bc2ccae67c96d2a9de96b5b01a78b98dac1a9e345e3) | partial | 169.9% → 170.2% | $76,248 | **BTC price move** |
| [0xabba0640…](https://explorer.test.mezo.org/tx/0xabba06409de091defae74c7cf7fe71d2dc1c1c2160ab120ba250c931ff98bb7d) | partial | 146.3% → 146.4% | $65,477 | **BTC price move** |

The two price-triggered protections were real market moves, and they were partial because those reserves were nearly empty. That is exactly the case v2 now reports explicitly, with the BTC to add.

## 3. Verified sources on the Mezo explorer: done and proven (7 of 7)

Each page shows "Contract source code verified (exact match)": solc 0.8.24+commit.e11b9ed9, optimizer on with 100 runs, EVM london, GPL-3.0. Each was confirmed through the explorer API (`is_verified: true`).

| Contract | Verified page | Screenshot |
|---|---|---|
| KeelGuardianFactoryV2 | [0x85579beE…79E1](https://explorer.test.mezo.org/address/0x85579beE60dc659e014610e57935379F8A9B79E1?tab=contract) | [factory-v2.png](images/verified/factory-v2.png) |
| KeelGuardianV2 implementation | [0xCCF76173…E8eF](https://explorer.test.mezo.org/address/0xCCF76173D1F312b3b5c3e55A6dDBD8046f30E8eF?tab=contract) | [guardian-v2-impl.png](images/verified/guardian-v2-impl.png) |
| KeelPay v2 | [0x3777b89a…740d](https://explorer.test.mezo.org/address/0x3777b89a32cD85FfA0a49b062CDb80e66E66740d?tab=contract) | [keelpay-v2.png](images/verified/keelpay-v2.png) |
| KeelPro | [0x59b1CEB9…8654](https://explorer.test.mezo.org/address/0x59b1CEB919378C59FB5F3D735f81c353aA1D8654?tab=contract) | [keelpro.png](images/verified/keelpro.png) |
| KeelGuardianFactory v1 | [0x44AA5CBb…2E49](https://explorer.test.mezo.org/address/0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49?tab=contract) | [factory-v1.png](images/verified/factory-v1.png) |
| KeelGuardian v1 implementation | [0x07F411F2…445D](https://explorer.test.mezo.org/address/0x07F411F2EE6AC7BA758ab234FC20Eb6F5f13445D?tab=contract) | [guardian-v1-impl.png](images/verified/guardian-v1-impl.png) |
| KeelPay v1 | [0xa0C53049…EE29](https://explorer.test.mezo.org/address/0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29?tab=contract) | [keelpay-v1.png](images/verified/keelpay-v1.png) |

**How:** `contracts/scripts/verify-blockscout.py`, which submits the standard-JSON input to Blockscout's verification API. Commit [297535e](https://github.com/Im-2/keel/commit/297535e).

## 4. A firmer revenue model: done

- **On-chain today:** a protocol share of every keeper tip goes to the treasury.
  - It is 20% now, **hard-capped at 50%** in both `KeelGuardianFactoryV2` and `KeelGuardianV2`.
  - The owner never pays more than the tip, which is itself capped at 1%.
  - Every payment is a `ProtocolFeePaid` event, shown in the [/stats](https://keel-miniapp.vercel.app/stats) revenue panel.
  - **Limitation:** no fee has been collected yet, because no v2 guardian has been protected (see 2d).
- **KeelPro subscription contract:** deployed and verified. It pays MUSD straight to the treasury and the price is hard-capped. The Pro features in the app aren't built yet.
- **Documented:** [Business model](BUSINESS.md) covers:
  - target users;
  - market sizing with stated assumptions;
  - unit economics and a sensitivity table;
  - five streams: tip share, Pro, merchant checkout at 0.3–0.5% (P2P stays free), team and DAO plans, and Guardian API licensing.

  It is on slide 10 of the deck.
- Commits: [8c91e7f](https://github.com/Im-2/keel/commit/8c91e7f) · [77d887b](https://github.com/Im-2/keel/commit/77d887b).

## 5. A pitch deck: done

- **12 slides:** problem, solution, live screenshots, architecture, the Mezo/MUSD integration (contracts and functions), the Guardian and keeper explained visually, payments, traction (real numbers from `/api/stats`), business model, roadmap, team.
- **Where:** [PDF](https://keel-miniapp.vercel.app/keel-deck.pdf) · [PPTX](https://keel-miniapp.vercel.app/keel-deck.pptx), also in `submission/` and `docs/keel-deck.pdf`.
- **Source:** `submission/deck/` (`deck.html`, `build.mjs`, `build-pptx.py`). Commit [d20601b](https://github.com/Im-2/keel/commit/d20601b).

## 6. Real third-party users and price-triggered protections: tracking ready; users not there yet

- **[/stats](https://keel-miniapp.vercel.app/stats)** reads everything on-chain:
  - guardians on every factory;
  - owners and open loans;
  - every protection, with the BTC price at that block, the ratio before and after, and whether **a price move or the owner's own change** triggered it;
  - revenue.

  Team and test wallets (listed in `shared/deployments/testnet.json` → `teamWallets`, plus the keeper and treasury) are **excluded by default**, with a toggle to include them.
- **Today:** **0 guardians from outside the team**. Both guardians, all four protections and the upcoming v2 test wallet are the team's own.
- **For testers:**
  - the web app and demo mode remove the Telegram requirement;
  - **Set to test** on the Protection screen puts the trigger one point under the current ratio, so a real oracle dip triggers the keeper;
  - [Quick start](site/quick-start.md) walks through it.
- **Recruiting testers is the team's job** and isn't done yet.
