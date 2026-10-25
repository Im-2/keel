import type { Hex } from "viem"

/**
 * Claim-link keys the sender created on this device. The key is the money: it is never sent to Keel's server, but
 * it must survive a webview reload during the wallet round-trip (otherwise the escrow could only be refunded), and
 * lets the sender share the link again from Activity. Stored per intent, with the link address it unlocks.
 */
const STORE = "keel:claimkeys"

interface Saved {
  key: Hex
  link: string
  at: number
}

function read(): Record<string, Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, Saved>
  } catch {
    return {}
  }
}

export function saveClaimKey(intentId: string, key: Hex, link: string) {
  try {
    const all = read()
    all[intentId] = { key, link: link.toLowerCase(), at: Date.now() }
    // keep the most recent 50
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50)
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(keep)))
  } catch {
    /* storage blocked: the Done screen still shows the link this once */
  }
}

export const claimKeyFor = (intentId: string): Hex | null => read()[intentId]?.key ?? null

/** The key for a link address, if this device created it. */
export function claimKeyForLink(link: string): Hex | null {
  const l = link.toLowerCase()
  return Object.values(read()).find((s) => s.link === l)?.key ?? null
}
