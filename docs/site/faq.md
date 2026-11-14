# FAQ

## Is Keel custodial?
**No.** Keel never holds your keys or funds. The server prepares a transaction, you review it, and you sign it in your own wallet. Your loan is owned by **your** guardian contract, which only you can withdraw from. See [Security model](security.md).

## Why is the minimum loan 1,800 MUSD?
That's **Mezo's** rule, not Keel's. MUSD requires at least 1,800 MUSD of net debt per loan, plus a refundable 200 MUSD gas reserve. Small loans would cost more to liquidate than they're worth. Keel builds the minimum into every quote. See [How borrowing works](borrowing.md).

## What does it cost?
- **Mezo** charges a one-time 0.1% borrowing fee and a fixed interest rate (1% APR on testnet at the time of writing).
- **Keel** charges nothing to borrow, send, split or claim.
- **When the guardian protects your loan,** the keeper gets a tip you set yourself: 0.2% by default, never more than 1% of the amount applied. In v2, a share of that tip goes to Keel's treasury; you never pay more than the tip.
- **Gas** is paid in BTC and is tiny on Mezo. Keel pays the gas for claiming a claim link.

## What happens if my reserve runs out?
- **With Guardian v2,** the keeper applies as much as the reserve allows (a *partial rescue*) and Keel tells you exactly how much BTC to add to finish the job.
- **If your loan is already under 110%** in Normal Mode, Mezo rejects any top-up that doesn't lift it back over 110%. The guardian then does nothing, charges nothing, and reports the BTC needed. Keel sends you an alert with a one-tap button to add it.
- **Before any of this happens,** Keel warns you when your reserve couldn't fully cover a rescue.

## Can the keeper steal my funds?
No. `protect()` can only move your reserve into **your own** loan, only below your trigger, with a cooldown and a capped tip. Withdrawals are owner-only.

## What if Keel's keeper goes down?
`protect()` is permissionless, so anyone can run a keeper. Today Keel runs the only one. An open keeper network is on the roadmap.

## Which networks?
**Mezo testnet** (chain id 31611) today. Mainnet comes after a third-party audit.

## Do I need Telegram?
No. The web app works in any browser with MetaMask or WalletConnect. Telegram adds chat commands and alerts. See [Web mode](web-mode.md).

## Can I send MUSD to someone without a wallet?
Yes, with a **claim link**. The MUSD is escrowed, they open the link, create or connect a wallet and claim it gaslessly. Unclaimed links refund after 72 hours. See [Payments](payments.md).

## Is it audited?
Not yet. There are 41 contract tests against the real MUSD stack, and every contract has verified source on the explorer. An audit is required before mainnet.

## What's next?
Real testers on testnet, Keel Pro features, an open keeper network, the audit, then mainnet. See [Roadmap](roadmap.md).
