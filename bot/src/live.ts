import { randomBytes } from "node:crypto"

/** What changed. The Mini App refetches what it shows; `toast` is a ready-to-show line for the user. */
export interface LiveEvent {
  reason: "received" | "sent" | "tx_confirmed" | "tx_failed" | "tx_submitted" | "protected" | "position" | "balance" | "price" | "link_claimed" | "link_cancelled" | "hello"
  tx?: string
  intentId?: string
  toast?: string
}

type Listener = (e: LiveEvent & { id: number }) => void

/**
 * In-process pub/sub between the block watcher and connected Mini Apps (server-sent events). One listener per open
 * app; the watcher asks `online()` so it only polls balances for people who are actually looking.
 */
export class LiveBus {
  private listeners = new Map<number, Set<Listener>>()
  private tokens = new Map<string, { tgId: number; exp: number }>()
  private seq = 0

  subscribe(tgId: number, fn: Listener): () => void {
    let set = this.listeners.get(tgId)
    if (!set) this.listeners.set(tgId, (set = new Set()))
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.listeners.delete(tgId)
    }
  }

  publish(tgId: number, e: LiveEvent) {
    const id = ++this.seq
    for (const fn of this.listeners.get(tgId) ?? []) fn({ ...e, id })
  }

  broadcast(e: LiveEvent) {
    for (const tgId of this.listeners.keys()) this.publish(tgId, e)
  }

  online(): number[] {
    return [...this.listeners.keys()]
  }

  connections(): number {
    let n = 0
    for (const s of this.listeners.values()) n += s.size
    return n
  }

  /** EventSource can't send headers, so the app trades its Telegram auth for a short-lived stream token. */
  issueToken(tgId: number, ttlMs = 5 * 60_000): string {
    const now = Date.now()
    for (const [k, v] of this.tokens) if (v.exp < now) this.tokens.delete(k)
    const t = randomBytes(18).toString("base64url")
    this.tokens.set(t, { tgId, exp: now + ttlMs })
    return t
  }

  redeem(token: string): number | null {
    const v = this.tokens.get(token)
    if (!v || v.exp < Date.now()) return null
    // reusable until expiry: EventSource reconnects with the same URL after a drop
    return v.tgId
  }
}

/** Fixed-window limiter per key (stream tokens, history paging). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now()
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 10_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    return ++h.n <= this.max
  }
}
