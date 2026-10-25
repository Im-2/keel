import { tg } from "./api"

/** True only inside a real Telegram client (the SDK script also loads in normal browsers, with empty initData). */
export const inTelegram = () => !!tg?.initData

/**
 * Open a URL outside Telegram. Telegram's webview blocks window.open and custom schemes (metamask://),
 * so we hand https universal links to the native client, which passes them on to the wallet app.
 */
export function openExternal(url: string) {
  if (tg?.openLink && inTelegram()) tg.openLink(url, { try_instant_view: false } as never)
  else window.open(url, "_blank", "noopener")
}

export interface WalletApp {
  id: string
  name: string
  /** Official icon from the WalletConnect Explorer registry, served from our own /wallets/ folder. */
  icon: string
  /** Universal link that hands a WalletConnect URI to the app; absent for wallets we only open by their browser. */
  wc?: (uri: string) => string
  /** Universal link that just brings the app to the front (to approve a pending request). */
  open: string
  /** Opens a page inside the wallet's own browser, where the wallet is injected. */
  dapp?: (url: string) => string
  /** Lowercase fragments of wagmi connector ids/names that mean this wallet (outside Telegram). */
  match: string[]
}

const enc = encodeURIComponent

/** Every wallet Keel knows; `WALLETS` are the ones offered for WalletConnect, in display order. */
export const ALL_WALLETS: WalletApp[] = [
  { id: "metamask", name: "MetaMask", icon: "/wallets/metamask.png", match: ["metamask"], wc: (u) => `https://metamask.app.link/wc?uri=${enc(u)}`, open: "https://metamask.app.link/", dapp: (url) => `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}` },
  { id: "trust", name: "Trust Wallet", icon: "/wallets/trust.png", match: ["trust"], wc: (u) => `https://link.trustwallet.com/wc?uri=${enc(u)}`, open: "https://link.trustwallet.com/", dapp: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${enc(url)}` },
  { id: "rainbow", name: "Rainbow", icon: "/wallets/rainbow.png", match: ["rainbow"], wc: (u) => `https://rnbwapp.com/wc?uri=${enc(u)}`, open: "https://rnbwapp.com/" },
  { id: "coinbase", name: "Base (Coinbase Wallet)", icon: "/wallets/coinbase.jpg", match: ["coinbase", "base account", "baseaccount"], wc: (u) => `https://go.cb-w.com/wc?uri=${enc(u)}`, open: "https://go.cb-w.com/", dapp: (url) => `https://go.cb-w.com/dapp?cb_url=${enc(url)}` },
  // registry universal links, formatted the way WalletConnect's own AppKit does: `${universal}/wc?uri=`
  { id: "uniswap", name: "Uniswap Wallet", icon: "/wallets/uniswap.png", match: ["uniswap"], wc: (u) => `https://uniswap.org/app/wc?uri=${enc(u)}`, open: "https://uniswap.org/app" },
  { id: "zerion", name: "Zerion", icon: "/wallets/zerion.png", match: ["zerion"], wc: (u) => `https://wallet.zerion.io/wc/wc?uri=${enc(u)}`, open: "https://wallet.zerion.io/" },
  // OKX: its in-app browser via the documented okx://wallet/dapp deep link, wrapped in OKX's https download link
  { id: "okx", name: "OKX Wallet", icon: "/wallets/okx.png", match: ["okx"], open: "https://www.okx.com/download", dapp: (url) => `https://www.okx.com/download?deeplink=${enc(`okx://wallet/dapp/url?dappUrl=${enc(url)}`)}` },
  { id: "phantom", name: "Phantom", icon: "/wallets/phantom.png", match: ["phantom"], open: "https://phantom.app/" },
]
export const WALLETS = ALL_WALLETS.filter((w) => w.wc)

/** The wallet behind a wagmi connector (RainbowKit / injected / WalletConnect peer name), if we know it. */
export function walletFor(connector?: { id?: string; name?: string } | null): WalletApp | undefined {
  const key = `${connector?.id ?? ""} ${connector?.name ?? ""}`.toLowerCase()
  return ALL_WALLETS.find((w) => w.match.some((m) => key.includes(m)))
}

const CHOSEN = "keel:wallet-app"
export const rememberWallet = (id: string) => {
  try {
    localStorage.setItem(CHOSEN, id)
  } catch { /* storage blocked */ }
}
export const chosenWallet = (): WalletApp | undefined => {
  try {
    return WALLETS.find((w) => w.id === localStorage.getItem(CHOSEN))
  } catch {
    return undefined
  }
}

let lastNudge = 0
/** Bring the connected wallet app forward so the user sees the pending signature request. */
export function nudgeWallet() {
  if (!inTelegram()) return
  const w = chosenWallet()
  if (!w || Date.now() - lastNudge < 4000) return
  lastNudge = Date.now()
  openExternal(w.open)
}

// ---- wallet-browser handoff: `?w=<token>` replaces Telegram initData for one action
const HANDOFF = "keel:handoff"
export function readHandoffFromUrl() {
  const q = new URLSearchParams(location.search)
  const t = q.get("w")
  if (!t) return
  // the route rides in the query too: wallet universal links (metamask.app.link/dapp/...) may drop the #fragment
  const r = q.get("r")
  const route = r && /^(link|i\/[\w-]{1,32})$/.test(r) ? `#/${r}` : location.hash
  try {
    sessionStorage.setItem(HANDOFF, t)
  } catch { /* fall back to the URL */ }
  // drop the token from the address bar so it is not shared by accident
  q.delete("w")
  q.delete("r")
  const rest = q.toString()
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + route)
  memo = t
}
let memo: string | null = null
export const handoffToken = (): string | null => {
  if (memo) return memo
  try {
    return sessionStorage.getItem(HANDOFF)
  } catch {
    return null
  }
}
