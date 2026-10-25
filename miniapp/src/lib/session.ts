/**
 * Forget every trace of the connected wallet in this webview so the next connect starts from a clean screen:
 * wagmi's stored connection, WalletConnect v2 pairings/sessions (localStorage + IndexedDB), RainbowKit's recent
 * wallet, and Keel's own remembered wallet app / handoff token. Caller should reload afterwards so no in-memory
 * WalletConnect client survives.
 */
const KEY_PREFIXES = ["wagmi", "wc@2", "WCM", "@w3m", "@appkit", "rk-", "rainbowkit", "walletconnect", "WALLETCONNECT", "-walletlink", "keel:wallet-app", "keel:claim-wallet"]

/** Drop stored wallet sessions (sync part) and WalletConnect's IndexedDB (in the background). */
export function clearWalletStorage() {
  try {
    for (const k of Object.keys(localStorage)) if (KEY_PREFIXES.some((p) => k.startsWith(p))) localStorage.removeItem(k)
    sessionStorage.removeItem("keel:handoff")
  } catch {
    /* storage blocked */
  }
  void (async () => {
    try {
      const dbs = (await indexedDB.databases?.()) ?? []
      for (const d of dbs) if (d.name && /walletconnect|wallet_connect|wc@2|appkit|coinbase|base-acc/i.test(d.name)) indexedDB.deleteDatabase(d.name)
    } catch {
      /* not supported in this webview */
    }
  })()
}

export async function clearWalletSession(disconnectAll: () => Promise<unknown>) {
  await disconnectAll().catch(() => undefined)
  clearWalletStorage()
}

/**
 * Telegram clients share one webview store between the accounts on a device. Remember which Telegram user this
 * device's wallet session belongs to; when a different account opens Keel, forget that session before wagmi
 * restores it, so one person's connected wallet is never offered to another. Returns true when it cleared.
 */
export function scopeStorageToUser(tgId: number | undefined): boolean {
  if (!tgId) return false
  try {
    const prev = localStorage.getItem("keel:tg")
    localStorage.setItem("keel:tg", String(tgId))
    if (prev && prev !== String(tgId)) {
      clearWalletStorage()
      return true
    }
  } catch {
    /* storage blocked: nothing persisted to leak */
  }
  return false
}
