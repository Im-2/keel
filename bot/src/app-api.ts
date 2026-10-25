import type { Context, Hono, MiddlewareHandler } from "hono"
import type { Address } from "viem"
import { E18, pct, type SystemState } from "@keel/shared"
import type { ChainService, UserView } from "./chain"
import type { IntentType, Store, UserRow } from "./db"
import type { History } from "./history"
import type { LiveBus } from "./live"
import { resolveRecipient, NOT_ON_KEEL } from "./recipient"
import type { Splits, PersonInput } from "./splits"

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
  splits?: Splits
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
  for (const p of ["/api/position", "/api/activity", "/api/market", "/api/intent", "/api/splits", "/api/split/*", "/api/request/*"]) app.use(p, auth)

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
      case "cancel_claim": {
        // only a link this user's own wallet created (from its LinkCreated log): the contract checks it again
        const link = typeof b.link === "string" ? b.link.toLowerCase() : ""
        const created = u.address ? store.eventsFor(u.address, 400).find((e) => e.kind === "link_created" && e.counterparty === link) : undefined
        if (!created) return c.json({ error: "That isn't one of your claim links." }, 404)
        params = { link, amount: created.amount ?? "0" }
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

  // ---- group payment requests (/request in a chat): a pay_<id> link opens straight on review & sign
  app.post("/api/request/:id/pay", (c) => {
    const u = userOf(c)
    const r = store.getRequest(c.req.param("id"))
    if (!r) return c.json({ error: "That payment request has expired or doesn't exist." }, 404)
    if (r.requester_tg === u.tg_id) return c.json({ error: "That's your own request 🙂", code: "own" }, 400)
    if (!u.address) return c.json({ error: "Link your wallet first, then pay.", code: "need_wallet" }, 400)
    return c.json(store.createIntent(u.tg_id, "pay_request", { requestId: r.id, to: r.requester_address, amount: r.amount, memo: r.memo ?? "" }))
  })

  // ---- bill splits
  const splits = d.splits
  if (splits) {
    app.get("/api/splits", (c) => {
      const u = userOf(c)
      return c.json({ ...splits.listFor(u), contacts: splits.contacts(u) })
    })
    app.post("/api/splits", async (c) => {
      const u = userOf(c)
      const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      const total = uint(b?.total)
      if (!b || !total) return c.json({ error: "Enter the total." }, 400)
      const people: PersonInput[] = []
      for (const p of Array.isArray(b.people) ? b.people.slice(0, 50) : []) {
        const x = p as Record<string, unknown>
        if (typeof x.raw !== "string") continue
        const amount = uint(x.amount)
        const bps = typeof x.bps === "number" && Number.isInteger(x.bps) ? x.bps : undefined
        people.push({ raw: x.raw, ...(amount ? { amount } : {}), ...(bps !== undefined ? { bps } : {}) })
      }
      const r = await splits.create(u, {
        total, people, includeMe: b.includeMe !== false,
        title: typeof b.title === "string" ? b.title.slice(0, 60) : "",
        dueAt: typeof b.dueAt === "number" && b.dueAt > 0 ? Math.floor(b.dueAt) : null,
      })
      if (!r.ok) return c.json({ error: r.error, code: r.code }, 400)
      return c.json({ id: r.value.split.id, notReached: r.value.notReached })
    })
    app.get("/api/split/:id", (c) => {
      const v = splits.view(c.req.param("id"), userOf(c))
      return v ? c.json(v) : c.json({ error: "This split doesn't exist or isn't yours." }, 404)
    })
    app.post("/api/split/:id/pay", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const idx = typeof b.idx === "number" && Number.isInteger(b.idx) ? b.idx : null
      const r = splits.startPay(c.req.param("id"), idx, userOf(c))
      if (!r.ok) return c.json({ error: r.error, code: r.code }, r.code === "not_participant" ? 403 : 400)
      return c.json(r.value)
    })
    app.post("/api/split/:id/remind", async (c) => {
      const r = await splits.remind(c.req.param("id"), userOf(c).tg_id)
      return r.ok ? c.json(r.value) : c.json({ error: r.error }, 400)
    })
    app.post("/api/split/:id/cancel", async (c) => {
      const r = await splits.cancel(c.req.param("id"), userOf(c).tg_id)
      return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400)
    })
  }
}
