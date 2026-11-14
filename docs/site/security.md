# Security model

Keel is **testnet software and has not been audited.** This page says what Keel protects against, how, and what it doesn't.

## Non-custodial by construction

- **Keel never holds keys or funds.** The server creates an *intent* (for example "borrow 1,800 MUSD at 160%"). The app shows the exact amounts, fee, ratio and liquidation price, and you sign the transaction in **your own wallet**.
- **Intents are completed only after the server checks the confirmed receipt:** the transaction succeeded and was **sent by your linked wallet**. A transaction hash from someone else can't complete your intent.
- **Payments show as sent only once they're confirmed on-chain** (three confirmations). The block watcher keeps a persisted cursor, overlaps 30 blocks and deduplicates events, so a restart or a reorg doesn't lose or double-count anything.

## Identity and data isolation

- **Telegram:** `initData` HMAC on every request, including expiry checks.
- **Web:** signed single-use nonce; a 12-hour session holding only a wallet address; the account is resolved server-side on every request. Telegram `initData` takes precedence if both are sent.
- **Per-user isolation is audited and regression-tested:**
  - every endpoint answers only with the caller's data;
  - ids, addresses and headers sent by the client are ignored;
  - intents, splits and live streams are scoped to their owner.
- **Wallet linking:** one wallet, one account. Moving a wallet needs a fresh signature and an explicit takeover, and the previous account is told.
- **Web-only accounts** live in their own id range, so they can never collide with a Telegram user or group.

## Guardian contract

- **Owner-only fund control:** only the owner can withdraw the reserve or the collateral, borrow, close, refinance, configure or transfer ownership (two steps).
- **The keeper can only** move reserve funds into the owner's own loan:
  - only below the trigger;
  - with a cooldown;
  - with a tip of at most 1%;
  - toward a target of at most 500%.
- **Re-entrancy:** every fund-moving function is `nonReentrant`. A test shows a malicious keeper contract can't re-enter `protect()` through its tip.
- **Protocol share:** at most 50% of the tip, enforced in both the factory and the guardian. The owner never pays more than the tip.
- **The implementation is immutable** (minimal-proxy clones). The factory admin can change only the treasury address and the share, within the cap. The admin can't touch any guardian, loan, reserve or setting.

## Claim links

- **The key lives only in the link,** never on Keel's server.
- **The claim signature binds the destination,** so the relayer or a mempool observer can't redirect funds.
- **Expiry refunds the sender,** and the sender can cancel at any time.

## Secrets

The bot token and the keeper, relayer and deployer keys exist only as host environment variables. They've never been in git: the full history was scanned with gitleaks plus an exact-value search.

## Threats and known limitations (candidly)

| Risk | Today | Mitigation |
|---|---|---|
| **Keeper downtime** | Keel runs one keeper. If it stops, protections don't happen. | `protect()` is permissionless: anyone can run a keeper. An open keeper network is on the roadmap. |
| **Relayer runs out of gas** | Claims pause (links stay valid). | Admins get an alert; low-balance checks run. |
| **Server compromise** | An attacker could create misleading intents or messages. | They still can't move funds: every transaction is shown in full and signed in your wallet. Read the review screen before signing. |
| **Phishing a claim link** | Anyone with the link can claim it. | Share links only with the intended person; cancel unclaimed links. |
| **Small reserve** | Protection may be partial or impossible. | v2 reports the exact BTC to add, and alerts tell you before and when it happens. |
| **Price oracle / MUSD protocol risk** | Keel inherits Mezo's oracle and MUSD's rules. | Out of Keel's control; Keel follows the protocol's rules exactly. |
| **Smart-contract bugs** | Not audited. | 41 contract tests against the real MUSD stack; an audit before mainnet. |
| **Free hosting** | The API sleeps when idle on the free plan. | A scheduler pings it; the first request after sleep can take up to a minute. |
