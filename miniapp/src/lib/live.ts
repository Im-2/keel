/**
 * Live updates from the Keel backend over server-sent events, built for Telegram's in-app browser and a host that
 * may sleep: reconnects with backoff, falls back to polling while the stream is down, and asks for a full refetch
 * whenever it comes back (events sent while we were away are not replayed).
 *
 * No React in here, so the state machine is unit-tested with a fake EventSource and fake timers.
 */

export interface LiveUpdate {
  id?: number
  reason: string
  tx?: string
  intentId?: string
  toast?: string
}

export type LiveStatus = "connecting" | "live" | "reconnecting"

interface EventSourceLike {
  onopen: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
  addEventListener(type: string, fn: (e: { data: string }) => void): void
  close(): void
}

export interface LiveDeps {
  /** Trades Telegram auth for a short-lived stream URL. Throws when the backend is unreachable. */
  streamUrl: () => Promise<string>
  /** Every update (refetch what it touches, maybe toast). */
  onUpdate: (u: LiveUpdate) => void
  /** Refetch everything: after a reconnect, and on every poll while the stream is down. */
  onResync: () => void
  onStatus?: (s: LiveStatus) => void
  createEventSource?: (url: string) => EventSourceLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
  /** How often to poll while the stream is down. */
  pollMs?: number
}

/** 1s, 2s, 4s … capped at 30s. */
export const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))

export class LiveClient {
  status: LiveStatus = "connecting"
  private es: EventSourceLike | null = null
  private attempt = 0
  private retryTimer: unknown = null
  private pollTimer: unknown = null
  private stopped = false
  private everOpen = false
  private seen = new Set<number>()

  constructor(private d: LiveDeps) {}

  private get st() {
    return this.d.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  }
  private get ct() {
    return this.d.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  private set(s: LiveStatus) {
    if (this.status === s) return
    this.status = s
    this.d.onStatus?.(s)
  }

  start() {
    this.stopped = false
    void this.open()
  }

  stop() {
    this.stopped = true
    this.es?.close()
    this.es = null
    if (this.retryTimer) this.ct(this.retryTimer)
    this.stopPolling()
  }

  /** The app came back to the foreground or the network returned: don't wait for the backoff. */
  wake() {
    if (this.stopped) return
    if (this.status === "live") return this.d.onResync()
    if (this.retryTimer) this.ct(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    void this.open()
  }

  private async open() {
    if (this.stopped) return
    this.es?.close()
    this.es = null
    let url: string
    try {
      url = await this.d.streamUrl()
    } catch {
      return this.fail()
    }
    if (this.stopped) return
    const make = this.d.createEventSource ?? ((u: string) => new EventSource(u) as unknown as EventSourceLike)
    const es = make(url)
    this.es = es
    es.addEventListener("update", (ev) => {
      let u: LiveUpdate
      try {
        u = JSON.parse(ev.data)
      } catch {
        return
      }
      if (u.reason === "hello") return this.opened()
      if (u.id && this.seen.has(u.id)) return
      if (u.id) {
        this.seen.add(u.id)
        if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200))
      }
      this.d.onUpdate(u)
    })
    es.onopen = () => this.opened()
    es.onerror = () => {
      // EventSource retries by itself, but a sleeping host or an expired token needs a fresh URL: own the retry
      if (this.es !== es) return
      es.close()
      this.es = null
      this.fail()
    }
  }

  private opened() {
    if (this.status === "live") return
    const wasDown = this.everOpen
    this.everOpen = true
    this.attempt = 0
    this.stopPolling()
    this.set("live")
    // whatever happened while we were away was not streamed to us
    if (wasDown) this.d.onResync()
  }

  private fail() {
    if (this.stopped) return
    this.set("reconnecting")
    this.startPolling()
    const wait = backoff(this.attempt++)
    if (this.retryTimer) this.ct(this.retryTimer)
    this.retryTimer = this.st(() => {
      this.retryTimer = null
      void this.open()
    }, wait)
  }

  private startPolling() {
    if (this.pollTimer) return
    const tick = () => {
      this.pollTimer = this.st(() => {
        if (this.stopped || this.status === "live") return void (this.pollTimer = null)
        this.d.onResync()
        tick()
      }, this.d.pollMs ?? 5000)
    }
    tick()
  }

  private stopPolling() {
    if (this.pollTimer) this.ct(this.pollTimer)
    this.pollTimer = null
  }
}

/** What each kind of update makes stale. */
export function invalidationsFor(u: LiveUpdate): string[][] {
  switch (u.reason) {
    case "price":
      return [["position"], ["market"]]
    case "balance":
    case "position":
    case "protected":
      return [["position"], ["activity"]]
    case "tx_submitted":
      return [["activity"]]
    default:
      return [["position"], ["activity"], ...(u.intentId ? [["intent", u.intentId]] : [])]
  }
}

// ---- tiny observable stores (status dot, toasts) shared by the components ------------------------------------

type Sub = () => void
export function createStore<T>(initial: T) {
  let v = initial
  const subs = new Set<Sub>()
  return {
    get: () => v,
    set(next: T) {
      v = next
      for (const s of subs) s()
    },
    subscribe(fn: Sub) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
  }
}

export const liveStatus = createStore<LiveStatus>("connecting")

export interface Toast {
  id: number
  text: string
}
export const toasts = createStore<Toast[]>([])
let toastSeq = 0
export function showToast(text: string, ms = 4500) {
  const id = ++toastSeq
  toasts.set([...toasts.get().slice(-2), { id, text }])
  setTimeout(() => toasts.set(toasts.get().filter((t) => t.id !== id)), ms)
}
