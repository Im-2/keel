// Dev-only fixture API for previewing the UI outside Telegram (`vite dev`, then add `?mock` to the URL).
// main.tsx imports this behind `import.meta.env.DEV`, so it never ships in a production build.
const E = 10n ** 18n
const s = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const now = Math.floor(Date.now() / 1000)

const position = {
  linked: true,
  address: "0x5C22A7612D3B67C68bA84873F16C01bc06041ADD",
  user: { firstName: "Ada", username: "ada" },
  wallet: { btc: s(0.0071), musd: s(1775.5) },
  kind: "guardian",
  guardianAddress: "0x277BD894778744cc687C9848B0c59772Ad021AFf",
  trove: { coll: s(0.04439), debt: s(2001.8), icr: s(1.799), liqPrice: s(49613), bufferBps: 3887, risk: "watch", interestRateBps: 100 },
  guardian: { enabled: true, minIcr: s(1.7), targetIcr: s(1.8), tipBps: 20, cooldown: 300, reserveBTC: s(0.00005), reserveMUSD: "0", canProtect: false },
  redemption: { ahead: s(184_250), rank: 6, total: 41 },
  system: { price: s(81168), tcr: s(2.917), recoveryMode: false, minNetDebt: (1800n * E).toString(), borrowingRate: (E / 1000n).toString(), interestRateBps: 100 },
}
const prices: Array<[number, number]> = Array.from({ length: 42 }, (_, i) => [Date.now() - (41 - i) * 4 * 3600_000, 78000 + Math.sin(i / 5) * 1800 + i * 80])
const row = (id: string, type: string, amount: bigint | null, extra: Record<string, unknown> = {}) => ({
  id, type, status: "confirmed", amount: amount?.toString() ?? null, asset: "MUSD", counterparty: null, memo: null, tx: `0x${id.padEnd(64, "0")}`, at: now - 600, params: {}, ...extra,
})
const activity = {
  more: false,
  items: [
    row("r1", "received", 15n * E, { counterparty: "@bob", memo: "Pizza", at: now - 120 }),
    row("p1", "protected", BigInt(s(0.00494)), { asset: "BTC", params: { btcAdded: s(0.00494), musdRepaid: "0", icrBefore: s(1.599), icrAfter: s(1.799) }, at: now - 600 }),
    row("a2", "protect_config", null, { asset: null, params: { enabled: "true", minIcr: s(1.7), targetIcr: s(1.8) }, at: now - 700 }),
    row("a3", "borrow", 1800n * E, { at: now - 900 }),
    row("a4", "send", 25n * E, { counterparty: "@bob", memo: "Lunch", at: now - 86400 }),
    row("a5", "fund_reserve", BigInt(s(0.005)), { asset: "BTC", at: now - 90000 }),
  ],
}
const sh = (idx: number, label: string, amount: string, paid: boolean, isMe = false) => ({ idx, label, amount, status: paid ? "paid" : "pending", tx: paid ? "0x" + "ab".repeat(32) : null, paidAt: paid ? now - 300 : null, isMe, ...(paid ? {} : { link: `https://t.me/KeelMezoBot/app?startapp=split_Sp1itAbc_${idx}` }) })
const split = {
  id: "Sp1itAbc", title: "Dinner", total: (100n * E).toString(), mine: "0", includeMe: false, status: "open", dueAt: now + 3 * 86400, createdAt: now - 3600,
  creator: { name: "@Nuelcrypt", isMe: true },
  shares: [sh(0, "@bob", "33340000000000000000", true), sh(1, "@chidi", "33330000000000000000", false), sh(2, "@eve_x", "33330000000000000000", false)],
  collected: "33340000000000000000", remaining: "66660000000000000000", myShare: null,
}
const owed = {
  id: "Ow3dXyz", title: "Taxi", total: (40n * E).toString(), mine: (20n * E).toString(), includeMe: true, status: "open", dueAt: null, createdAt: now - 7200,
  creator: { name: "@big_beccaa", isMe: false },
  shares: [{ idx: 0, label: "@Nuelcrypt", amount: (20n * E).toString(), status: "pending", tx: null, paidAt: null, isMe: true }],
  collected: "0", remaining: (20n * E).toString(), myShare: 0,
}
const intents: Record<string, unknown> = {
  demo: { id: "demo", tg_id: 1, type: "send", params: { to: "0x00000000000000000000000000000000000000b2", amount: (25n * E).toString(), label: "@bob", memo: "Lunch" }, status: "pending" },
}

export function installMock() {
  const q0 = new URLSearchParams(location.search)
  if (q0.has("tg")) {
    // pretend to be inside Telegram: non-empty initData, and record openLink calls instead of leaving the page
    const w = window as unknown as { Telegram: { WebApp: Record<string, unknown> }; __opened: string[] }
    w.__opened = []
    const orig = w.Telegram.WebApp
    w.Telegram.WebApp = new Proxy(orig, {
      get: (t, k) => (k === "initData" ? "mock=1" : k === "openLink" ? (url: string) => void w.__opened.push(url) : Reflect.get(t, k)),
    })
  }
  // a fake event stream: window.__live({ reason: "received", toast: "Received 5 MUSD from @bob" }) pushes an update,
  // window.__liveDrop() simulates the stream dropping (the client reconnects with backoff, polling meanwhile)
  const w2 = window as unknown as Record<string, unknown>
  const streams = new Set<{ emit: (d: unknown) => void; fail: () => void }>()
  let seq = 0
  w2.__live = (u: Record<string, unknown>) => streams.forEach((st) => st.emit({ id: ++seq, ...u }))
  w2.__liveDrop = () => streams.forEach((st) => st.fail())
  w2.__mutate = (fn: (p: typeof position, a: typeof activity) => void) => fn(position, activity)
  w2.EventSource = class {
    onopen: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    private ls: Array<(e: { data: string }) => void> = []
    private me = { emit: (d: unknown) => this.ls.forEach((l) => l({ data: JSON.stringify(d) })), fail: () => this.onerror?.({}) }
    constructor() {
      streams.add(this.me)
      setTimeout(() => this.me.emit({ reason: "hello", id: 0 }), 300)
    }
    addEventListener(_t: string, fn: (e: { data: string }) => void) { this.ls.push(fn) }
    close() { streams.delete(this.me) }
  }
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
    if (!path.startsWith("/api/")) return real(input, init)
    await new Promise((r) => setTimeout(r, 350))
    if (path === "/api/config") return real(input, init) // real chain config from the running bot
    const q = new URLSearchParams(location.search)
    if (path === "/api/position") return json(q.has("unlinked") ? { linked: false, user: { firstName: "Ada", username: "ada" } } : q.has("noloan") ? { ...position, wallet: { btc: q.has("empty") ? "0" : s(0.05), musd: "0" }, trove: null, redemption: null, guardian: null } : q.has("risk") ? { ...position, trove: { ...position.trove, icr: s(1.18), liqPrice: s(75600), bufferBps: 690, risk: "danger" } } : q.has("watch") ? { ...position, trove: { ...position.trove, icr: s(1.39) } } : position)
    if (path === "/api/market") return json({ source: "mock", prices, oracle: 81168 })
    if (path === "/api/activity") return json(activity)
    if (path.startsWith("/api/intent/")) return json(intents[path.split("/")[3]] ?? { error: "not found" }, intents[path.split("/")[3]] ? 200 : 404)
    if (path === "/api/intent") return json({ error: "Preview mode: signing is disabled." }, 400)
    if (path.startsWith("/api/claim/")) return json({ sender: position.address, senderName: "@Nuelcrypt", amount: (20n * E).toString(), expiry: now + 2 * 86400, settled: false, status: q.has("claimed") ? "claimed" : "open", claimedBy: q.has("claimed") ? "@bob" : null })
    if (path === "/api/splits" && (!init?.method || init.method === "GET")) return json({ created: [split], owed: [owed], contacts: ["@bob", "@chidi", "@big_beccaa"] })
    if (path === "/api/splits") return json({ id: "Sp1itAbc", notReached: ["@eve_x"] })
    if (path.startsWith("/api/split/") && path.endsWith("/remind")) return json({ reminded: ["@chidi"], queued: [], links: [{ label: "@eve_x", link: "https://t.me/KeelMezoBot/app?startapp=split_Sp1itAbc_2" }], skipped: [] })
    if (path.startsWith("/api/split/") && path.endsWith("/pay")) return json({ error: "Preview mode: signing is disabled." }, 400)
    if (path.startsWith("/api/split/Ow3dXyz")) return json(owed)
    if (path.startsWith("/api/split/")) return json(split)
    if (path === "/api/handoff") return json({ token: "tok123", expires: now + 600, url: `${location.origin}/?w=tok123&r=link` })
    if (path === "/api/live/token") return json({ token: "mock", url: "/api/live" })
    if (path === "/api/premium") return json({ active: false, until: 0, priceMusd: "1", days: 30 })
    return json({ error: "mock: no route" }, 404)
  }
}
