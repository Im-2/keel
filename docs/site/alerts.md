# Alerts and notifications

Keel watches every linked loan and sends **Telegram messages** when something needs attention. Each risk alert comes with **one-tap buttons** that open a ready-made transaction on the review-and-sign screen.

## Risk alerts

| Alert | When | Buttons |
|---|---|---|
| **Heads up** | Your ratio falls below your warning level (default 150%) | Add BTC to reach a safe ratio · Repay to reach it · Turn on protection or fund the reserve |
| **Urgent** | Your ratio falls below your danger level (default 130%) | Same as above, sized to the target |
| **Redemption exposure** | Little MUSD sits ahead of your loan in Mezo's redemption queue | Raise your ratio to move back in the queue |
| **Recovery Mode** | The system ratio crosses 150% (on and off) | Protect your loan if it's under 150% |
| **Reserve can't fully protect your loan** | Protection is on and the loan is near the trigger, but the reserve couldn't bring it back to the target | Add the exact BTC needed (+2%) |
| **Your guardian can't act yet** | A v2 guardian is under its trigger and the reserve can't fund anything Mezo would accept | Add the exact BTC needed to make a rescue possible |

Alerts use **hysteresis**: an alert fires once when you cross a level and re-arms only after a clear recovery, so you aren't spammed. You can mute them, and you can change your levels with `/alerts`.

## Notices

- **Guardian protected your loan**, with the ratio before and after, a link to the transaction, and **partly protected** plus the BTC to add when the reserve ran out.
- **Payment received / sent**, confirmed on-chain, with the sender's name.
- **Claim link claimed / refunded.**
- **Split paid**, and reminders for shares you owe.
- **Wallet linked / disconnected.**

If the bot can't reach you (you never pressed Start, or blocked it), notices are **queued** and delivered the next time you message the bot.

## How fast

- Free users are checked every few minutes.
- **Premium users** are checked every few seconds. Premium is paid per use in MUSD over x402, and the KeelPro subscription is next.
- Payments and protections are picked up by a block watcher within a few blocks of confirmation.

## On the web

Alerts are Telegram messages. If you use Keel only in the browser, use **Connect Telegram** in your profile: it opens the bot with a one-time code (valid 30 minutes) and moves your wallet and history to that Telegram account. From then on you get every alert.
