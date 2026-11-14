# How borrowing works

Keel doesn't run its own lending protocol. Every loan is a real **MUSD trove** on Mezo, opened through Mezo's `BorrowerOperations` contract. This page explains the MUSD rules Keel builds into every quote.

## The pieces of a loan

| Term | What it means |
|---|---|
| **Collateral** | The BTC you lock in the loan (native BTC on Mezo). |
| **Debt** | What you owe: the MUSD you received, plus a one-time fee, plus a refundable 200 MUSD gas reserve, plus interest over time. |
| **Borrowing fee** | One-time, 0.1% of the amount borrowed, added to your debt. |
| **Interest** | A fixed annual rate set by Mezo when you open the loan (1% APR on testnet at the time of writing). |
| **Gas compensation** | 200 MUSD added to the debt and held by Mezo to pay whoever closes or liquidates the loan. You get it back when you repay in full. |
| **Minimum net debt** | Mezo doesn't allow loans smaller than **1,800 MUSD** of net debt (debt minus the 200 MUSD gas compensation). |
| **Collateral ratio (ICR)** | Collateral value divided by debt. 160% means $1.60 of BTC behind every $1 of debt. |
| **Liquidation** | If the ratio falls **below 110%**, anyone can liquidate the loan. Your debt is cleared but you lose the collateral. |
| **Redemption** | Anyone can swap MUSD for BTC at face value. Redemptions hit the **lowest-ratio loans first**: part of your debt is repaid with part of your collateral. It isn't a loss at face value, but you end up holding less BTC. |
| **Recovery Mode** | If the whole system's ratio (TCR) falls below 150%, Mezo enters Recovery Mode. New borrowing must keep the loan at or above 150%. |

## A worked example

Suppose BTC is **$80,000**, you borrow **1,800 MUSD** and choose a **160%** ratio.

| Line | Amount |
|---|---|
| You receive | 1,800 MUSD |
| Borrowing fee (0.1%) | + 1.8 MUSD |
| Gas compensation (refundable) | + 200 MUSD |
| **Total debt** | **2,001.8 MUSD** |
| Collateral needed at 160% | 2,001.8 × 1.6 ÷ 80,000 = **0.04004 BTC** |
| Liquidation price (ratio = 110%) | 2,001.8 × 1.1 ÷ 0.04004 = **≈ $55,000** |
| Interest at 1% APR | about 20 MUSD a year |

So BTC can fall about 31% before this loan becomes liquidatable. With a guardian set to "below 170%, restore to 180%", the keeper acts long before that.

## What Keel checks before you sign

Keel refuses to prepare a transaction that Mezo would reject:
- **Under the minimum:** the loan would be below 1,800 MUSD of net debt.
- **Under 110%:** the loan would be immediately liquidatable.
- **Under 150% in Recovery Mode.**
- **A repayment that leaves less than the minimum.** You can either repay down to 1,800 MUSD of net debt or close the loan completely; the app tells you which.

## Managing the loan

| Action | What it does |
|---|---|
| **Add collateral** | Raises your ratio. |
| **Repay** | Lowers your debt and raises your ratio. |
| **Close** | Repays everything; your collateral and the guardian's reserve come back to you. |
| **Borrow more** | Takes more MUSD while you stay above the minimum ratio. |

Each of these is a transaction you sign. Keel prepares it and computes the sorted-list hints Mezo needs.
