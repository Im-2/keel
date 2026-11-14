# Web mode, Telegram mode and demo mode

Keel is one app with three ways in. They share the same contracts, the same loan and the same history.

## Telegram mode

Open [t.me/KeelMezoBot/app](https://t.me/KeelMezoBot/app) or the bot's menu button.

- **Identity:** Telegram signs a launch payload (`initData`), and Keel's server checks it with an HMAC on **every** request.
- **Linking a wallet:** you sign a single-use nonce (valid 10 minutes) that ties the wallet to your Telegram account. One wallet belongs to one Telegram account; moving it requires a fresh signature and tells the other account.
- **Extras:** chat commands, natural language, alerts and notices.

## Web mode (no Telegram)

Open [keel-miniapp.vercel.app](https://keel-miniapp.vercel.app) in any browser and tap **Open web app**.

**Signing in:**
1. Connect MetaMask, another browser wallet, or a mobile wallet via WalletConnect.
2. The server issues a nonce for that address. Your wallet signs a fixed message naming the site, your address, the chain, the nonce and the time. It's free and moves no funds.
3. The server checks the signature (nonce single use, valid 10 minutes) and returns a **12-hour session token**.

**What a session can and can't do:**
- A session holds **only your wallet address**. On every request the server looks up the account from that address; it never trusts an id or address sent by the browser.
- A wallet already linked to Telegram signs in to that same account. A new wallet gets a web-only account.
- **Everything works:** dashboard and balances, borrow, repay, collateral, protection settings and reserve, send, claim links, splits and history.
- **Telegram-only, by design:** relinking or unlinking a wallet, and the wallet-browser handoff.
- **Alerts are Telegram messages.** A web account sees **Connect Telegram**, which opens the bot with a one-time code (30 minutes) and moves the wallet and its history to your Telegram account.

**Signing out** ends the session. Unlinking the wallet in Telegram ends every web session for it.

## Demo mode

Open [keel-miniapp.vercel.app/?demo=1](https://keel-miniapp.vercel.app/?demo=1#/), or tap **Try the demo**. Demo mode shows every screen with **sample data** and a banner that says so.
- Nothing is signed or sent.
- Buttons that would sign explain that demo mode can't.
- Only the chain configuration and public stats come from the real server.

## Which should I use?

| You want to… | Use |
|---|---|
| Get alerts and use chat commands | Telegram |
| Try Keel without Telegram, or on a desktop with MetaMask | Web mode |
| See every screen without testnet BTC | Demo mode |
