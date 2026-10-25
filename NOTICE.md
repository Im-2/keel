# Notice

`contracts/` is built on top of the MUSD protocol by Mezo / Thesis (https://github.com/mezo-org/musd), GPL-3.0.
Everything under `contracts/contracts/` except `keel/` and `contracts/test/` (tester contracts) is Mezo's code,
vendored unmodified so Keel's integration tests run against the real protocol. Keel's own contracts live in
`contracts/contracts/keel/` and are also GPL-3.0.

## Wallet logos

`miniapp/public/wallets/` holds the official icons of MetaMask, Trust Wallet, Rainbow, Base (formerly Coinbase
Wallet), Uniswap Wallet, Zerion, OKX Wallet and Phantom. They are fetched unmodified from the WalletConnect (Reown)
Explorer registry by `miniapp/scripts/fetch-wallet-icons.mjs`; `manifest.json` next to them records each listing and
image id. Wallet teams submit these icons to the registry so that WalletConnect-compatible apps can show their wallet
in a connect list, which is exactly how Keel uses them. They are not covered by Keel's license: each logo is a
trademark of its owner, used only to name that wallet (nominative use), shown unaltered and in original colors, and
implies no endorsement of Keel. Remove or replace an icon if its owner asks.
