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
  /** Universal link that hands a WalletConnect URI to the app. */
  wc: (uri: string) => string
  /** Universal link that just brings the app to the front (to approve a pending request). */
  open: string
  /** Opens a page inside the wallet's own browser, where the wallet is injected. */
  dapp?: (url: string) => string
}

const enc = encodeURIComponent

export const WALLETS: WalletApp[] = [
  { id: "metamask", name: "MetaMask", wc: (u) => `https://metamask.app.link/wc?uri=${enc(u)}`, open: "https://metamask.app.link/", dapp: (url) => `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}` },
  { id: "trust", name: "Trust Wallet", wc: (u) => `https://link.trustwallet.com/wc?uri=${enc(u)}`, open: "https://link.trustwallet.com/", dapp: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${enc(url)}` },
  { id: "rainbow", name: "Rainbow", wc: (u) => `https://rnbwapp.com/wc?uri=${enc(u)}`, open: "https://rnbwapp.com/" },
  { id: "coinbase", name: "Coinbase Wallet", wc: (u) => `https://go.cb-w.com/wc?uri=${enc(u)}`, open: "https://go.cb-w.com/", dapp: (url) => `https://go.cb-w.com/dapp?cb_url=${enc(url)}` },
]

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
