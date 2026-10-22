// Dev-only fixture API for previewing the UI outside Telegram (`vite dev`, then add `?mock` to the URL).
// main.tsx imports this behind `import.meta.env.DEV`, so it never ships in a production build.
const E = 10n ** 18n
const s = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const now = Math.floor(Date.now() / 1000)

const position = {
  linked: true,
  address: "0x5C22A7612D3B67C68bA84873F16C01bc06041ADD",
  user: { firstName: "Ada", username: "ada" },
  wallet: { btc: s(0.0071) },
  kind: "guardian",
  guardianAddress: "0x277BD894778744cc687C9848B0c59772Ad021AFf",
  trove: { coll: s(0.04439), debt: s(2001.8), icr: s(1.799), liqPrice: s(49613), bufferBps: 3887, risk: "watch", interestRateBps: 100 },
  guardian: { enabled: true, minIcr: s(1.7), targetIcr: s(1.8), tipBps: 20, cooldown: 300, reserveBTC: s(0.00005), reserveMUSD: "0", canProtect: false },
  redemption: { ahead: s(184_250), rank: 6, total: 41 },
  system: { price: s(81168), tcr: s(2.917), recoveryMode: false, minNetDebt: (1800n * E).toString(), borrowingRate: (E / 1000n).toString(), interestRateBps: 100 },
}
const prices: Array<[number, number]> = Array.from({ length: 42 }, (_, i) => [Date.now() - (41 - i) * 4 * 3600_000, 78000 + Math.sin(i / 5) * 1800 + i * 80])
const activity = {
  items: [
    { id: "p1", type: "protected", params: { btcAdded: s(0.00494), musdRepaid: "0", icrBefore: s(1.599), icrAfter: s(1.799) }, tx: "0x297323edc0a2000ec4137fe0fd521fbe9f78ea651511e0bbaf6ce967f8a35c2e", at: now - 600 },
    { id: "a2", type: "protect_config", params: { enabled: "true", minIcr: s(1.7), targetIcr: s(1.8) }, tx: null, at: now - 700 },
    { id: "a3", type: "borrow", params: { amount: (1800n * E).toString() }, tx: null, at: now - 900 },
    { id: "a4", type: "send", params: { amount: (25n * E).toString(), label: "@bob", memo: "Lunch" }, tx: null, at: now - 86400 },
    { id: "a5", type: "fund_reserve", params: { amount: s(0.005) }, tx: null, at: now - 90000 },
  ],
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
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
    if (!path.startsWith("/api/")) return real(input, init)
    await new Promise((r) => setTimeout(r, 350))
    if (path === "/api/config") return real(input, init) // real chain config from the running bot
    const q = new URLSearchParams(location.search)
    if (path === "/api/position") return json(q.has("unlinked") ? { linked: false, user: { firstName: "Ada", username: "ada" } } : q.has("noloan") ? { ...position, wallet: { btc: s(0.05) }, trove: null, redemption: null, guardian: null } : q.has("risk") ? { ...position, trove: { ...position.trove, icr: s(1.18), liqPrice: s(75600), bufferBps: 690, risk: "danger" } } : q.has("watch") ? { ...position, trove: { ...position.trove, icr: s(1.39) } } : position)
    if (path === "/api/market") return json({ source: "mock", prices, oracle: 81168 })
    if (path === "/api/activity") return json(activity)
    if (path.startsWith("/api/intent/")) return json(intents[path.split("/")[3]] ?? { error: "not found" }, intents[path.split("/")[3]] ? 200 : 404)
    if (path === "/api/intent") return json({ error: "Preview mode: signing is disabled." }, 400)
    if (path.startsWith("/api/claim/")) return json({ sender: position.address, amount: (50n * E).toString(), expiry: now + 3600, settled: false })
    if (path === "/api/handoff") return json({ token: "tok123", expires: now + 600, url: `${location.origin}/?w=tok123&r=link` })
    if (path === "/api/premium") return json({ active: false, until: 0, priceMusd: "1", days: 30 })
    return json({ error: "mock: no route" }, 404)
  }
}
