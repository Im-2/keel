import type { Context, Hono, MiddlewareHandler } from "hono"
import type { Address } from "viem"
import { E18, pct, type SystemState } from "@keel/shared"
import type { ChainService, UserView } from "./chain"
import type { IntentType, Store, UserRow } from "./db"
import type { History } from "./history"
import type { LiveBus } from "./live"
import { resolveRecipient, NOT_ON_KEEL } from "./recipient"

/** Routes the redesigned Mini App uses to start actions itself and to draw the dashboard. */
export interface AppRouteDeps {
  store: Store
  chain: ChainService
  auth: MiddlewareHandler
  userOf: (c: Context) => UserRow
  /** BTC/USD history for sparklines; injectable for tests. */
  priceHistory?: () => Promise<Array<[number, number]>>
  history: History
  live?: LiveBus
}

const uint = (v: unknown) => (typeof v === "string" && /^\d{1,40}$/.test(v) ? BigInt(v) : null)
const s = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : v.toString())

function serializeView(v: UserView, sys: SystemState) {
  const t = v.trove
  const g = v.guardian
  return {
    kind: v.kind,
    guardianAddress: v.guardianAddress,
    trove: t && {
      coll: s(t.coll), debt: s(t.debt), icr: s(t.icr), liqPrice: s(t.liqPrice), bufferBps: t.bufferBps, risk: t.risk, interestRateBps: t.interestRateBps,
    },
    guardian: g && {
      enabled: g.enabled, minIcr: s(g.minIcr), targetIcr: s(g.targetIcr), tipBps: g.tipBps, cooldown: g.cooldown, reserveBTC: s(g.reserveBTC), reserveMUSD: s(g.reserveMUSD), canProtect: g.canProtect,
    },
    redemption: v.redemption && { ahead: s(v.redemption.ahead), rank: v.redemption.rank, total: v.redemption.total },
    system: { price: s(sys.price), tcr: s(sys.tcr), recoveryMode: sys.recoveryMode, minNetDebt: s(sys.minNetDebt), borrowingRate: s(sys.borrowingRate), interestRateBps: sys.interestRateBps },
  }
}

/** Last-resort price series: the oracle price recorded on each request, so the sparkline is never fake. */
function recordPrice(store: Store, price: bigint) {
  const hist = JSON.parse(store.getKv("market:prices") ?? "[]") as Array<[number, number]>
  const now = Date.now()
  if (!hist.length || now - hist[hist.length - 1][0] > 10 * 60_000) {
    hist.push([now, Number(price / (E18 / 100n)) / 100])
    store.setKv("market:prices", JSON.stringify(hist.slice(-200)))
  }
  return hist
}

let cgCache: { at: number; v: Array<[number, number]> } | null = null
async function coingecko7d(): Promise<Array<[number, number]>> {
  if (cgCache && Date.now() - cgCache.at < 15 * 60_000) return cgCache.v
  const r = await fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7", { signal: AbortSignal.timeout(6000) })
  if (!r.ok) throw new Error(`coingecko ${r.status}`)
  const j = (await r.json()) as { prices: Array<[number, number]> }
  const v = j.prices.filter((_, i) => i % 4 === 0) // ~42 points is plenty for a sparkline
  cgCache = { at: Date.now(), v }
  return v
}

export function mountAppRoutes(app: Hono<any>, d: AppRouteDeps) {
  const { store, chain, auth, userOf } = d
  for (const p of ["/api/position", "/api/activity", "/api/market", "/api/intent"]) app.use(p, auth)

  app.get("/api/position", async (c) => {
    const u = userOf(c)
    const sys = await chain.system()
    recordPrice(store, sys.price)
    if (!u.address) return c.json({ linked: false, user: { firstName: u.first_name, username: u.username } })
    const [view, btc, musd] = await Promise.all([chain.view(u.address as Address), chain.balance(u.address as Address), chain.musdBalance(u.address as Address)])
    return c.json({ linked: true, address: u.address, user: { firstName: u.first_name, username: u.username }, wallet: { btc: s(btc), musd: s(musd) }, ...serializeView(view, sys) })
  })

  app.get("/api/market", async (c) => {
    const sys = await chain.system()
    const local = recordPrice(store, sys.price)
    let prices: Array<[number, number]>
    let source = "coingecko"
    try {
      prices = await (d.priceHistory ?? coingecko7d)()
    } catch {
      prices = local
      source = "oracle"
    }
    return c.json({ source, prices, oracle: Number(sys.price / (E18 / 100n)) / 100 })
  })

  // Same feed as /history in chat: intents plus the on-chain ledger (received transfers, claims, protections).
  app.get("/api/activity", async (c) => {
    const u = userOf(c)
    const limit = Number(c.req.query("limit") ?? 30)
    const offset = Number(c.req.query("offset") ?? 0)
    const feed = await d.history.feed(u, { limit: Number.isFinite(limit) ? limit : 30, offset: Number.isFinite(offset) ? offset : 0 })
    return c.json(feed)
  })

  // Start an action from the Mini App. Same intent rows the bot creates, so signing, completion
  // checks and notifications are shared. Params are rebuilt server-side from validated fields only.
  app.post("/api/intent", async (c) => {
    const u = userOf(c)
    if (!u.address) return c.json({ error: "Link your wallet first." }, 400)
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!b || typeof b.type !== "string") return c.json({ error: "bad request" }, 400)
    const amount = uint(b.amount)
    const type = b.type as IntentType
    let params: Record<string, unknown>
    switch (type) {
      case "borrow": {
        const icr = uint(b.targetIcr)
        if (!amount || !icr || amount < 1n * E18 || icr <= pct(110) || icr > pct(1000)) return c.json({ error: "Check the amount and ratio." }, 400)
        params = { amount: amount.toString(), targetIcr: icr.toString() }
        break
      }
      case "repay":
      case "add_collateral":
      case "fund_reserve":
        if (!amount) return c.json({ error: "Enter an amount." }, 400)
        params = { amount: amount.toString() }
        break
      case "close":
        params = {}
        break
      case "protect_config": {
        const minIcr = uint(b.minIcr)
        const targetIcr = uint(b.targetIcr)
        const enabled = b.enabled !== false
        if (!minIcr || !targetIcr || minIcr <= pct(110) || targetIcr <= minIcr || targetIcr > pct(500)) return c.json({ error: "Trigger must be above 110% and below the target (max 500%)." }, 400)
        params = { enabled, minIcr: minIcr.toString(), targetIcr: targetIcr.toString(), tipBps: 20, cooldown: 300 }
        break
      }
      case "send": {
        if (!amount) return c.json({ error: "Enter an amount." }, 400)
        const memo = typeof b.memo === "string" ? b.memo.slice(0, 120) : ""
        const r = resolveRecipient(store, u, typeof b.to === "string" ? b.to : "")
        if (r.kind === "invalid") return c.json({ error: r.error }, 400)
        if (r.kind === "self") return c.json({ error: "That's your own wallet." }, 400)
        if (r.kind === "unlinked") return c.json({ error: `@${r.username}: ${NOT_ON_KEEL}.`, code: "not_on_keel", username: r.username }, 404)
        params = { to: r.address, amount: amount.toString(), label: r.label, ...(r.user ? { toTg: r.user.tg_id } : {}), memo }
        break
      }
      case "create_claim": {
        if (!amount) return c.json({ error: "Enter an amount." }, 400)
        const forName = typeof b.forName === "string" && b.forName.trim() ? b.forName.trim().slice(0, 40) : undefined
        params = { amount: amount.toString(), expiryHours: 72, ...(forName ? { forName } : {}) }
        break
      }
      default:
        return c.json({ error: "Unsupported action." }, 400)
    }
    const intent = store.createIntent(u.tg_id, type, params)
    return c.json(intent)
  })
}
