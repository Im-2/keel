import { describe, expect, it } from "vitest"
import { LiveClient, backoff, invalidationsFor, type LiveUpdate } from "./live"

interface FakeSource {
  url: string
  onopen: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
  ls: Array<(e: { data: string }) => void>
  closed: boolean
  addEventListener(t: string, fn: (e: { data: string }) => void): void
  close(): void
  emit(d: unknown): void
}

/** Fake EventSource + manual clock, so the reconnect state machine runs deterministically. */
function rig(opts: { tokenFails?: number } = {}) {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let tid = 0
  const sources: FakeSource[] = []
  const updates: LiveUpdate[] = []
  const statuses: string[] = []
  const counts = { resyncs: 0, tokenCalls: 0 }
  const client = new LiveClient({
    streamUrl: async () => {
      counts.tokenCalls++
      if (counts.tokenCalls <= (opts.tokenFails ?? 0)) throw new Error("asleep")
      return `/api/live?t=tok${counts.tokenCalls}`
    },
    onUpdate: (u) => updates.push(u),
    onResync: () => void counts.resyncs++,
    onStatus: (s) => statuses.push(s),
    pollMs: 5000,
    createEventSource: (url) => {
      const es: FakeSource = {
        url, onopen: null, onerror: null, ls: [], closed: false,
        addEventListener(_t, fn) { es.ls.push(fn) },
        close() { es.closed = true },
        emit(d) { es.ls.forEach((l) => l({ data: JSON.stringify(d) })) },
      }
      sources.push(es)
      return es
    },
    setTimeout: (fn, ms) => {
      const id = ++tid
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = next.at
      next.fn()
      await flush()
    }
    now = end
  }
  return { client, sources, updates, statuses, counts, flush, advance }
}

describe("live client", () => {
  it("goes live on hello and delivers each update once", async () => {
    const r = rig()
    r.client.start()
    await r.flush()
    expect(r.client.status).toBe("connecting")
    r.sources[0].emit({ reason: "hello", id: 0 })
    expect(r.client.status).toBe("live")
    r.sources[0].emit({ id: 1, reason: "received", toast: "Received 5 MUSD from @alice" })
    r.sources[0].emit({ id: 1, reason: "received", toast: "Received 5 MUSD from @alice" }) // replayed by a proxy
    r.sources[0].emit({ id: 2, reason: "price" })
    expect(r.updates.map((u) => u.reason)).toEqual(["received", "price"])
    expect(r.counts.resyncs).toBe(0) // first connection: nothing was missed
  })

  it("on a drop: Reconnecting, polls meanwhile, reconnects with backoff and a fresh token, resyncs once back", async () => {
    const r = rig()
    r.client.start()
    await r.flush()
    r.sources[0].emit({ reason: "hello" })
    r.sources[0].onerror!({})
    expect(r.client.status).toBe("reconnecting")
    expect(r.sources[0].closed).toBe(true)
    await r.advance(999)
    expect(r.sources).toHaveLength(1) // backoff: 1s
    await r.advance(1)
    expect(r.sources).toHaveLength(2)
    expect(r.sources[1].url).toBe("/api/live?t=tok2")
    r.sources[1].onerror!({}) // still down: next wait is 2s
    await r.advance(1999)
    expect(r.sources).toHaveLength(2)
    await r.advance(3001) // past the 2s retry and the 5s poll
    expect(r.counts.resyncs).toBeGreaterThanOrEqual(1) // polling fallback refetched while down
    const before = r.counts.resyncs
    r.sources[2].emit({ reason: "hello" })
    expect(r.client.status).toBe("live")
    expect(r.counts.resyncs).toBe(before + 1) // full refetch after coming back
    await r.advance(20_000)
    expect(r.counts.resyncs).toBe(before + 1) // polling stops once live
    expect(r.statuses).toEqual(["live", "reconnecting", "live"])
  })

  it("a sleeping server (token request fails) keeps retrying; wake() skips the wait", async () => {
    const r = rig({ tokenFails: 3 })
    r.client.start()
    await r.flush()
    expect(r.client.status).toBe("reconnecting")
    r.client.wake()
    await r.flush()
    r.client.wake()
    await r.flush()
    expect(r.counts.tokenCalls).toBe(3)
    r.client.wake()
    await r.flush()
    expect(r.sources).toHaveLength(1)
    r.sources[0].emit({ reason: "hello" })
    expect(r.client.status).toBe("live")
  })

  it("stop() closes the stream and cancels timers", async () => {
    const r = rig()
    r.client.start()
    await r.flush()
    r.sources[0].onerror!({})
    r.client.stop()
    await r.advance(60_000)
    expect(r.sources).toHaveLength(1)
  })

  it("backoff doubles up to 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it("maps each event to what it makes stale", () => {
    expect(invalidationsFor({ reason: "price" })).toEqual([["position"], ["market"]])
    expect(invalidationsFor({ reason: "received" })).toEqual([["position"], ["activity"]])
    expect(invalidationsFor({ reason: "tx_confirmed", intentId: "x1" })).toEqual([["position"], ["activity"], ["intent", "x1"]])
    expect(invalidationsFor({ reason: "tx_submitted" })).toEqual([["activity"]])
  })
})
