# Keel status report

Audit date: 23 October 2026. Network: Mezo testnet (chain 31611). Everything below was re-run or re-checked during this audit; nothing is taken from earlier notes without re-verification.

**Legend**
- **Done and proven**: real transactions on Mezo testnet, or a real Telegram message, with evidence below.
- **Built, proven locally**: works against the real MUSD contracts on a local chain, but can't be (or hasn't been) shown on testnet.
- **Built, unproven on phone**: the code and tests pass, but nobody has yet done it by hand in Telegram.
- **Partial** / **Missing**: as stated.

Explorer links: `https://explorer.test.mezo.org/tx/<hash>`.

## 1. Test suites and typechecks (run now)

| Suite | Result |
|---|---|
| `contracts` Keel tests against the real MUSD stack (`KEEL_SOLCJS=1 hardhat test test/keel/*.test.ts`) | **24 passing**, 0 failing |
| `shared` (risk math, readers) | **8 passed** |
| `bot` (handlers, API, alerts, keeper, x402 premium, handoff, parser, chat) | **152 passed** (5 files) |
| Typecheck `shared`, `bot`, `miniapp` (`tsc --noEmit`) | **clean** |
| Local end-to-end (`bot/scripts/e2e-local.ts`, real MUSD contracts on the local chain) | **ALL OK**: borrow, add collateral, repay, fund reserve, protect config, send, claim link + relay, price drop → keeper `protect()` restores 160% → 219.9% |

## 2. Status by spec item

| # | Feature | Status | Evidence | What's left |
|---|---|---|---|---|
| 1a | Borrow in chat with a confirmation card (0.1% fee, fixed interest, ratio, liquidation price). Nothing runs until the user signs | **Done and proven** | Bot card (`borrowCard`) and Mini App review rows show all four. Testnet loan opened with exactly this code: guardian `0xa4648dbf…`, `openTrove` `0x815f88e8…` (1,800 MUSD at 160%) | A borrow signed by you on your phone |
| 1b | Uses BorrowerOperations, hint helpers, price feed | **Done and proven** | `openTrove` goes through the guardian into BorrowerOperations. Hints come from `HintHelpers.getApproxHint` + `SortedTroves.findInsertPosition` (`miniapp/src/lib/plan.ts`). Price comes from `PriceFeed.fetchPrice`. Same testnet txs as 1a | — |
| 1c | 1,800 MUSD minimum and Recovery Mode in the UX | **Done** (fixed in this audit) | Quote now has `blocking`: under the minimum, under 110%, or **under 150% in Recovery Mode** → no sign button (new tests). **Bug found and fixed:** repay used to allow paying down to 200 MUSD, which Mezo rejects. Now partial repay is capped at `debt − 200 − minNetDebt`, and "repay everything" closes the loan. Testnet: invalid 50 MUSD repay refused with the real 1.83 MUSD maximum; valid partial repay approve `0x3364d8e7…`, repay `0xe14794f2…` | — |
| 1d | Repay / add collateral | **Done and proven** | Testnet: add collateral `0x89442091…`, repay above | — |
| 1e | Close loan (pay off everything) | **Partial** | New "close" action in the bot, Mini App and chat. `closeTrove` is covered by contract tests. Not run on testnet: the demo wallet has 1,794 MUSD and needs 1,801.83 (the fee and interest). The Mini App says exactly that | Close a loan on testnet once a wallet holds enough MUSD |
| 2a | Send MUSD to a @handle | **Done and proven** | Send plan on testnet `0x1d7971bf…`. @handle → address, and fallback to a claim link for unlinked users, covered by bot tests | Send to a real second Telegram user |
| 2b | Split a bill / request payment in a group | **Built, unproven on phone** | Group post, live ✅/⏳ list, pay-from-DM flow and group message edits are all covered by tests. A payment is a plain MUSD transfer (proven in 2a) | Try it in a real Telegram group with two accounts |
| 2c | Claim link for someone with no wallet | **Done and proven** | `bot/scripts/claimlink-testnet.ts`, run on testnet:<br>• create: approve `0xa5fced78…`, escrow `0x89092758…`<br>• **gasless claim** by the bot's relayer `0x29c84497…` to a fresh wallet that holds 2 MUSD and **0 BTC**<br>• sender cancel: escrow `0x5242bd5d…`, cancel `0xc7fe6dc9…`<br>• short-expiry link `0x867f4d63…`: a stranger was refused (`NotSender`) before expiry, then refunded the sender after expiry `0xe55f73b6…`<br>• stranded link refunded `0x765db983…` | Claim a link on a phone that has no wallet |
| 2d | x402 gasless pay-per-use premium alerts in MUSD | **Done and proven** (after 3 fixes) | `bot/scripts/x402-testnet.ts` runs the production route code against `facilitator.vativ.io`:<br>• 402 with correct requirements (1 MUSD, `eip155:31611`, Permit2)<br>• paid retry → **200**, Premium active<br>• settlement `0xe8d33ffd…`, **sent by the facilitator** (`0x23fe…f957`); payer −1 MUSD, payee +1 MUSD, payer paid no gas<br>Bugs fixed: (1) facilitator sync was off, so the live endpoint returned 500; (2) EIP-2612 gas-sponsoring extension was missing, so payment failed with `permit2_allowance_required`; (3) the Mini App's paid retry dropped the payment header (it turned the `Request` into the string `"[object Request]"`) | Pay for Premium from the Mini App on a phone |
| 3a | Alert: ratio near liquidation | **Done and proven** | `bot/scripts/alert-live-test.ts`: the real AlertEngine read the demo wallet's real testnet loan (181.9%) and delivered "🟠 Heads up…" to Telegram chat 811387215 with one-tap buttons. Hysteresis and mute covered by tests | — |
| 3b | Alert: likely redemption target | **Done and proven** | Same live run: "⚠️ Redemption exposure… rank 201/298" with buttons, from the real redemption queue (298 troves scanned) | — |
| 3c | Alert: Recovery Mode starts | **Built, proven locally** | `bot/scripts/recovery-local.ts`: real MUSD contracts, BTC dropped until the system ratio was 145.5% → "🚨 Recovery Mode is ON… inside the danger zone" with buttons, then "Recovery Mode is over" after recovery. Also covered by unit tests | Can't be forced on a shared testnet |
| 3d | One-tap protect button in the alert | **Done** (added in this audit) | Every risk alert now carries Mini App buttons that open a ready-made review screen: "🛡 Add X BTC → target%", "💵 Repay Y MUSD" (only when Mezo's minimum allows it), "🔋 Fund reserve", or "🤖 Turn on auto-protection". Delivered live (3a/3b). Amounts covered by tests | Tap one on a phone and sign |
| 3e | Automatic keeper action | **Done and proven** | Testnet: `/protect 170 180` on a 159.9% loan → the running keeper called `protect()` `0x297323ed…`, 159.9% → 179.9% from the reserve. **Bug found and fixed:** two earlier keeper attempts ran out of gas on-chain (`0xdd23852d…`, `0xef13444a…`, 97% gas used); keeper and relayer now add a 50% margin and a floor | — |
| 3f | Guardian contract | **Done and proven** | 24 contract tests; testnet factory `0x44AA5CBb…`, KeelPay `0xa0C53049…`, demo guardian `0x277BD894…` (configure `0xce638524…`/`0x41070fd8…`, fund reserve `0x735e9284…`) | Audit by a third party before mainnet |
| 4 | Mini App signing flow | **Done and proven** for the transaction code; **built, unproven on phone** for signing | Every testnet tx above (borrow, add, repay, fund, protect config, send, claim link) went through the Mini App's own `buildPlan` steps. **Bugs found and fixed:** Mezo's public RPC (a) can price cheap calls under the EIP-7623 floor it then enforces, and (b) lags between nodes, so the step after an approve was priced as a revert and ran out of gas on-chain (`0x3d0c85a3…`). Every Mini App tx now simulates until the node catches up, then sends with a margin and a 150k floor | Sign a borrow on your phone |
| 5 | Wallet connect inside Telegram | **Done and proven** (connect + link) | You connected MetaMask on your phone. The live database shows wallet `0xaeD0…8DbD` bound to your Telegram account through the signed-nonce flow. The "open in wallet browser" handoff is covered by tests | Sign a transaction (not just the link message) over WalletConnect |
| 6 | Natural-language chat | **Built, unproven on phone** | Rule-based parser, no LLM: 92 parser tests (phrasings, typos, wrong input). 23 chat-flow tests: echo before any intent, clarifying questions, "Did you mean", answers from live data, group mentions. Running in the live bot | Try the phrases below on your phone |

## 3. Bugs found and fixed in this audit

1. **Repay could be rejected by Mezo.** It allowed repaying below the 1,800 MUSD minimum net debt, and "repay everything" did exactly that. Now: cap partial repays, close the loan for a full payoff, and the same rule applies to the alert buttons.
2. **x402 premium was broken in production.** Facilitator sync was off (HTTP 500), there was no gas sponsoring (`permit2_allowance_required`), and the Mini App dropped the payment header.
3. **Keeper and relayer ran out of gas.** Two real failed transactions; fixed with a margin and a floor.
4. **The Mini App could run out of gas after an approve.** Caused by RPC lag and Mezo's EIP-7623 floor; fixed by simulate-then-estimate plus a floor.
5. **Recovery Mode borrows under 150% were only warned about, not blocked.** Now blocked.
6. **Alerts had no one-tap action.** Now every risk alert has one.

## 4. Known limits

- **Hosting:** the bot, keeper and API run on one Windows machine behind a Cloudflare quick tunnel. The tunnel died once overnight. When it restarts its URL changes, and `VITE_API_BASE` must be updated in Vercel followed by a push. A permanent host or named tunnel is needed for a reliable demo.
- **Demo wallet funds:** it holds only ~0.0033 BTC, so it can't open another loan. Your wallet holds 0.05 BTC and no loan yet.
- **x402 facilitator hash lookup:** the hash it returns can't be looked up with `eth_getTransactionByHash` on the public RPC, but it is on chain and visible on the explorer.
- **Recovery Mode:** can only be demonstrated locally.
- **Audit:** the contracts are not audited.

## 5. Reproduce

```bash
pnpm --filter @keel/bot test && pnpm --filter @keel/bot typecheck
cd contracts && KEEL_SOLCJS=1 npx hardhat test test/keel/*.test.ts
cd bot && pnpm tsx scripts/claimlink-testnet.ts        # needs DEPLOYER_PRIVATE_KEY + KEEPER_PRIVATE_KEY in .env
cd bot && pnpm tsx scripts/x402-testnet.ts
cd bot && pnpm tsx scripts/plan-testnet.ts add_collateral 0.0002
cd contracts && KEEL_SOLCJS=1 pnpm dev:chain           # then: cd bot && pnpm tsx scripts/recovery-local.ts
```

## 6. What to test on your phone

Everything here starts in a private chat with @KeelMezoBot. Your wallet has 0.05 BTC.

1. **Chat questions:** send `how safe is my loan?` (it says you have no loan), `what are the fees?`, `what is MUSD?`, `borow 2000` (expect "Did you mean…?"), `purple monkey` (expect "I didn't get that" with examples).
2. **Borrow:** send `borrow 1800 at 160%` → **Yes, continue** → check the card (fee, interest, ratio, liquidation price) → **Review & sign** → approve in MetaMask, which opens by itself. Expect "✅ Loan opened". You now hold 1,800 MUSD.
3. **Protection:** send `fund 0.005` → sign. Then `protect me at 170` → **Yes** → sign. Within about a minute: "🛡 Guardian protected your loan", ratio ~160% → ~180%.
4. **Alerts:** send `alerts`, tap **170%**. On the next check you should get "🟠 Heads up" with **🛡 Add … BTC** buttons. Tap one and it opens the review screen.
5. **Claim link:** send `claimlink 5` → sign → **Share in Telegram** → open the link from another account or device → **Create a wallet and claim**. Expect "Claimed" with no gas paid.
6. **Premium:** open the Mini App → Premium → **Pay with MUSD** → sign the permit. Expect "Premium is on".
7. **Repay rules:** send `repay 100`. Your loan is at the minimum, so expect "can't be partly repaid… close the loan".
8. **Group:** add the bot to a group, then send `@KeelMezoBot split 30 with @friend1 @friend2 for lunch` → **Yes**. The other members tap **Pay with Keel**.

**Note on the earlier test alerts:** their buttons were built from the demo wallet's loan. In your own wallet the review screen will say "no open loan" until you borrow (step 2).
