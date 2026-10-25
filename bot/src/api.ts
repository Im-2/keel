import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { isAddress, verifyMessage, type Address, type Hex } from "viem"
import { explorerTx, fmtMusd } from "@keel/shared"
import type { Config } from "./config"
import type { Handoff, IntentRow, Store } from "./db"
import type { ChainService } from "./chain"
import type { Notifier } from "./notify"
import type { ClaimRelayer } from "./relayer"
import { validateInitData, type InitData } from "./telegram-auth"
import { mountPremium, type Premium } from "./premium"
import { mountAppRoutes } from "./app-api"
import { createCompletion, nameOf, type Completion } from "./completion"
import { esc } from "./format"
import { notifyOrQueue } from "./notify"
import { LiveBus, RateLimiter } from "./live"
import { History } from "./history"
import type { Splits } from "./splits"

export interface ApiDeps {
  config: Config
  store: Store
  chain: ChainService
  notifier: Notifier
  relayer?: ClaimRelayer
  premium?: Premium
  /** Edits a group payment-request message. Wired to bot.api in production. */
  editMessage?: (chatId: number, messageId: number, html: string, replyMarkup?: unknown) => Promise<unknown>
  now?: () => number
  live?: LiveBus
  completion?: Completion
  history?: History
  splits?: Splits
}

export const bindMessage = (tgId: number, nonce: string) => `Link this wallet to Keel (Telegram account ${tgId}).\nNonce: ${nonce}`

const INIT_HEADER = "x-telegram-init-data"
const HANDOFF_HEADER = "x-keel-handoff"

export function createApi(d: ApiDeps) {
  const { config, store, chain, notifier } = d
  const live = d.live ?? new LiveBus()
  const completion = d.completion ?? createCompletion({ config, store, chain, notifier, live, splits: d.splits, editMessage: d.editMessage })
  const history = d.history ?? new History({ config, store, chain })
  const app = new Hono<{ Variables: { tg: InitData } }>()
  const miniappOrigin = (() => {
    try {
      return new URL(config.miniappUrl).origin
    } catch {
      return "*"
    }
  })()
  app.use("/api/*", cors({ origin: [miniappOrigin, "http://localhost:5173", "https://localhost:5173"], exposeHeaders: ["*"] }))
  // Per-user data: never stored by a browser, proxy or CDN, and never served to anyone else from a cache.
  app.use("/api/*", async (c, next) => {
    await next()
    c.res.headers.set("Cache-Control", c.req.path === "/api/live" ? "private, no-store, no-transform" : "private, no-store")
    c.res.headers.set("Vary", "Origin, x-telegram-init-data, x-keel-handoff")
  })

  app.get("/healthz", (c) => c.json({ ok: true, network: config.network }))

  app.get("/api/config", (c) =>
    c.json({
      network: config.network,
      chainId: config.deployment.chainId,
      rpcUrl: config.rpcUrl ?? null,
      botUsername: config.botUsername,
      miniappShortName: config.miniappShortName ?? null,
      deployment: { musd: config.deployment.musd, keel: config.deployment.keel },
    }),
  )

  // ---- claim links (no Telegram auth: the link key is the credential)
  // Public: the link address is derived from the key, which never reaches this server.
  app.get("/api/claim/:link", async (c) => {
    const link = c.req.param("link")
    if (!isAddress(link) || !d.relayer) return c.json({ error: "This claim link isn't valid." }, 400)
    const info = await d.relayer.link(link as Address).catch(() => null)
    if (!info) return c.json({ error: "This claim link doesn't exist on this network. Check you opened the whole link.", code: "unknown" }, 404)
    const sender = store.findByAddress(info.sender)
    let status: "open" | "claimed" | "cancelled" | "expired" = info.settled ? "claimed" : info.expiry * 1000 < Date.now() ? "expired" : "open"
    let claimedBy: string | null = null
    if (info.settled && sender?.address) {
      const evs = store.eventsFor(sender.address, 400)
      const cl = evs.find((e) => e.kind === "link_claimed" && e.data.link?.toLowerCase() === link.toLowerCase())
      if (cl?.counterparty) claimedBy = nameOf(store.findByAddress(cl.counterparty), cl.counterparty)
      else if (evs.some((e) => e.kind === "link_cancelled" && e.counterparty === link.toLowerCase())) status = "cancelled"
    }
    return c.json({ sender: info.sender, senderName: sender ? nameOf(sender) : null, amount: info.amount.toString(), expiry: info.expiry, settled: info.settled, status, claimedBy })
  })

  app.post("/api/claim/relay", async (c) => {
    if (!d.relayer) return c.json({ error: "relayer not configured" }, 503)
    const body = await c.req.json().catch(() => null)
    if (!body || !isAddress(body.link) || !isAddress(body.to) || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
      return c.json({ error: "bad request" }, 400)
    }
    const info = await d.relayer.link(body.link)
    try {
      const tx = await d.relayer.claim(body.link, body.to, body.signature as Hex)
      if (info) {
        const senderUser = store.findByAddress(info.sender)
        // same dedup key as the block watcher, which sees the LinkClaimed event a few seconds later
        if (senderUser && store.claimNotice(`lc:${tx.toLowerCase()}`)) {
          const who = nameOf(store.findByAddress(body.to), body.to)
          await notifyOrQueue(store, notifier, senderUser.tg_id, `🎁 Your claim link for <b>${fmtMusd(info.amount, 2)}</b> was claimed by <b>${esc(who)}</b>.`, {
            buttonText: "View transaction",
            buttonUrl: explorerTx(config.network, tx),
          })
          live.publish(senderUser.tg_id, { reason: "link_claimed", tx, toast: `${who} claimed your ${fmtMusd(info.amount, 2)} link` })
        }
      }
      return c.json({ txHash: tx })
    } catch (e) {
      const msg = (e as Error).message
      if (/insufficient funds|gas required exceeds/i.test(msg)) {
        // the relayer pays the gas for claims: tell the admins once an hour, and the claimer what's going on
        if (store.claimNotice(`relayer-gas:${Math.floor(Date.now() / 3_600_000)}`)) {
          for (const id of config.adminIds) await notifier.send(id, "⛽ <b>Claim relayer is out of gas</b>: a claim just failed. Send testnet BTC to the relayer (keeper) wallet; see /status.").catch(() => undefined)
        }
        return c.json({ error: "Claims are paused for a few minutes while Keel refuels its gas wallet. Your link still works: try again shortly.", code: "relayer_gas" }, 503)
      }
      const friendly = /LinkSettled/.test(msg) ? "This link was already claimed or cancelled." : /Expired/.test(msg) ? "This link has expired: the MUSD goes back to the sender." : /BadSignature/.test(msg) ? "That link key is not valid: open the whole link again." : /LinkUnknown/.test(msg) ? "This claim link doesn't exist on this network." : "Could not claim right now. Please try again."
      return c.json({ error: friendly, code: /LinkSettled/.test(msg) ? "settled" : /Expired/.test(msg) ? "expired" : "failed" }, 400)
    }
  })

  // ---- authenticated routes
  const auth = async (c: Context, next: () => Promise<void>) => {
    try {
      c.set("tg" as never, validateInitData(c.req.header(INIT_HEADER) ?? "", config.botToken) as never)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 401)
    }
    await next()
  }
  /**
   * Same as `auth`, but also accepts a one-time handoff token (for the wallet's own in-app browser, where there is
   * no Telegram initData). The token only unlocks the routes for its purpose; see `handoffAllows`.
   */
  const authOrHandoff = async (c: Context, next: () => Promise<void>) => {
    const token = c.req.header(HANDOFF_HEADER)
    if (!token || c.req.header(INIT_HEADER)) return auth(c, next)
    const h = store.getHandoff(token)
    if (!h) return c.json({ error: "This link has expired or was already used. Start again from Telegram." }, 401)
    if (!handoffAllows(h, c.req.method, c.req.path)) return c.json({ error: "not allowed" }, 403)
    c.set("tg" as never, { user: { id: h.tg_id }, authDate: 0 } as never)
    c.set("handoff" as never, h as never)
    await next()
  }
  const handoffAllows = (h: Handoff, method: string, path: string) => {
    if (path === "/api/me") return method === "GET"
    if (h.purpose === "link") return path === "/api/nonce" || path === "/api/bind"
    return !!h.intent_id && (path === `/api/intent/${h.intent_id}` || path === `/api/intent/${h.intent_id}/complete`)
  }
  const handoffOf = (c: Context) => (c.get("handoff" as never) as Handoff | undefined) ?? null
  const tgOf = (c: Context) => c.get("tg" as never) as InitData
  const userOf = (c: Context) => {
    const { user } = tgOf(c)
    // a handoff carries only the Telegram id: never overwrite the stored name with blanks
    return handoffOf(c) ? (store.getUser(user.id) ?? store.upsertUser(user.id)) : store.upsertUser(user.id, user.username, user.first_name)
  }
  if (d.premium) mountPremium(app, { config, premium: d.premium, auth: auth as never, tgIdOf: ((c: Context) => tgOf(c).user.id) as never, onGranted: (tgId, until) => void notifier.send(tgId, `⭐ <b>Keel Premium is on</b> until ${new Date(until * 1000).toISOString().slice(0, 10)}: your loan is now checked every few seconds instead of minutes.`) })
  mountAppRoutes(app, { store, chain, auth: auth as never, userOf, history, live, splits: d.splits })

  // ---- live updates: the app trades its Telegram auth for a short-lived token, then opens an EventSource
  const streamLimit = new RateLimiter(30, 60_000)
  app.use("/api/live/token", auth)
  app.post("/api/live/token", (c) => {
    const u = userOf(c)
    if (!streamLimit.allow(`tok:${u.tg_id}`)) return c.json({ error: "Too many requests, slow down." }, 429)
    return c.json({ token: live.issueToken(u.tg_id), url: "/api/live" })
  })
  app.get("/api/live", (c) => {
    const tgId = live.redeem(c.req.query("t") ?? "")
    if (tgId === null) return c.json({ error: "stream token expired" }, 401)
    if (live.connections() > 500 || !streamLimit.allow(`sse:${tgId}`)) return c.json({ error: "busy" }, 429)
    let cleanup = () => {}
    const body = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder()
        const send = (chunk: string) => {
          try {
            ctrl.enqueue(enc.encode(chunk))
          } catch {
            cleanup()
          }
        }
        // retry hint for EventSource, then a hello so the client knows the stream is really open
        send("retry: 3000\n\n")
        send(`event: update\ndata: ${JSON.stringify({ reason: "hello", id: 0 })}\n\n`)
        const off = live.subscribe(tgId, (e) => send(`id: ${e.id}\nevent: update\ndata: ${JSON.stringify(e)}\n\n`))
        // comments keep proxies (Render, Telegram's webview) from closing an idle stream
        const beat = setInterval(() => send(`: ping ${Date.now()}\n\n`), 20_000)
        cleanup = () => {
          clearInterval(beat)
          off()
        }
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } })
  })
  app.use("/api/handoff", auth)
  app.use("/api/me", authOrHandoff)
  app.use("/api/nonce", authOrHandoff)
  app.use("/api/bind", authOrHandoff)
  app.use("/api/intent/*", authOrHandoff)

  // Create a one-time link that opens this action inside a wallet's own browser (10 minutes, single use).
  app.post("/api/handoff", async (c) => {
    const u = userOf(c)
    const body = (await c.req.json().catch(() => ({}))) as { purpose?: string; intentId?: string }
    if (body.purpose === "intent") {
      const i = store.getIntent(String(body.intentId ?? ""))
      if (!i || i.tg_id !== u.tg_id || i.status !== "pending") return c.json({ error: "not found" }, 404)
      const h = store.createHandoff(u.tg_id, "intent", i.id)
      return c.json({ ...h, url: `${config.miniappUrl}/?w=${h.token}&r=i/${i.id}` })
    }
    if (body.purpose === "link") {
      const h = store.createHandoff(u.tg_id, "link", null)
      return c.json({ ...h, url: `${config.miniappUrl}/?w=${h.token}&r=link` })
    }
    return c.json({ error: "bad request" }, 400)
  })

  app.get("/api/me", (c) => {
    const u = userOf(c)
    return c.json({ tgId: u.tg_id, username: u.username, address: u.address, settings: u.settings })
  })

  app.post("/api/nonce", (c) => {
    const u = userOf(c)
    const nonce = store.issueNonce(u.tg_id)
    return c.json({ nonce, message: bindMessage(u.tg_id, nonce) })
  })

  // Unlink the caller's own wallet (Telegram initData only: a one-time handoff link can't do this).
  app.use("/api/disconnect", auth)
  app.post("/api/disconnect", async (c) => {
    const u = userOf(c)
    const was = store.disconnect(u.tg_id)
    if (was) {
      await notifier.send(u.tg_id, `🔌 Wallet <code>${was.slice(0, 6)}…${was.slice(-4)}</code> disconnected. Your loan and funds stay on-chain, untouched. Connect again any time.`, {
        buttons: [[{ text: "🔗 Connect wallet", webApp: `${config.miniappUrl}/#/link` }]],
      })
    }
    return c.json({ ok: true, disconnected: was })
  })

  app.post("/api/bind", async (c) => {
    const u = userOf(c)
    const body = await c.req.json().catch(() => null)
    if (!body || !isAddress(body.address) || typeof body.nonce !== "string" || typeof body.signature !== "string") return c.json({ error: "bad request" }, 400)
    if (!store.consumeNonce(body.nonce, u.tg_id)) return c.json({ error: "nonce expired, please try again" }, 400)
    const ok = await verifyMessage({ address: body.address, message: bindMessage(u.tg_id, body.nonce), signature: body.signature as Hex }).catch(() => false)
    if (!ok) return c.json({ error: "signature does not match this wallet" }, 400)
    // A wallet belongs to one Telegram account. If another account has it, say so only now (after the signature
    // proved this person controls the wallet), reveal nothing about that account, and require a fresh signature
    // with an explicit takeover before moving it.
    const other = store.findByAddress(body.address)
    if (other && other.tg_id !== u.tg_id) {
      if (body.takeover !== true) {
        return c.json({ error: "This wallet is linked to a different Telegram account. Linking it here unlinks it there; sign again to confirm.", code: "wallet_in_use" }, 409)
      }
      store.disconnect(other.tg_id)
      await notifyOrQueue(store, notifier, other.tg_id, `🔌 Your wallet <code>${body.address.slice(0, 6)}…${body.address.slice(-4)}</code> was linked to another Telegram account, so it's no longer linked here. Your loan and funds are on-chain and untouched. If that wasn't you, move your funds to a new wallet.`, {
        buttons: [[{ text: "🔗 Connect a wallet", webApp: `${config.miniappUrl}/#/link` }]],
      })
      live.publish(other.tg_id, { reason: "position" })
    }
    const h = handoffOf(c)
    if (h && !store.useHandoff(h.token)) return c.json({ error: "This link was already used." }, 401)
    store.setAddress(u.tg_id, body.address)
    live.publish(u.tg_id, { reason: "position" })
    await notifier.send(u.tg_id, `🔗 Wallet linked: <code>${body.address}</code>\nTry /position or /borrow 1800 160.`)
    return c.json({ address: body.address })
  })

  const ownIntent = (c: Context): { intent: IntentRow } | { res: Response } => {
    const intent = store.getIntent(c.req.param("id") ?? "")
    if (!intent || intent.tg_id !== tgOf(c).user.id) return { res: c.json({ error: "not found" }, 404) }
    return { intent }
  }

  app.get("/api/intent/:id", (c) => {
    const r = ownIntent(c)
    if ("res" in r) return r.res
    return c.json(r.intent)
  })

  app.post("/api/intent/:id/complete", async (c) => {
    const r = ownIntent(c)
    if ("res" in r) return r.res
    const { intent } = r
    const body = await c.req.json().catch(() => ({}))
    const txHash: string | undefined = typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash : undefined
    if (intent.status !== "pending") return c.json({ ok: true, status: intent.status, txHash: intent.tx_hash })
    // the wallet broadcast it: remember the hash so the server settles it even if the app closes now
    if (body.status === "submitted") {
      if (!txHash) return c.json({ error: "txHash required" }, 400)
      store.setIntentTx(intent.id, txHash)
      live.publish(intent.tg_id, { reason: "tx_submitted", intentId: intent.id, tx: txHash })
      return c.json({ ok: true, status: "pending" })
    }
    if (body.status === "failed") {
      // the user cancelled or the wallet refused before anything was broadcast; nothing to check on-chain
      if (!intent.tx_hash && !txHash) {
        store.completeIntent(intent.id, "failed")
        return c.json({ ok: true, status: "failed" })
      }
    }
    const hash = txHash ?? intent.tx_hash
    if (!hash) return c.json({ error: "txHash required" }, 400)
    const h = handoffOf(c)
    if (h && !store.getHandoff(h.token)) return c.json({ error: "This link was already used." }, 401)
    const res = await completion.confirm(intent, hash)
    if (res.status === "unconfirmed") return c.json({ error: "transaction not confirmed yet", status: "pending" }, 409)
    if (res.status === "wrong_sender") return c.json({ error: "transaction was not sent by your linked wallet" }, 403)
    if (h) store.useHandoff(h.token)
    return c.json({ ok: res.status === "done", status: res.status, ...(res.status === "failed" ? { reason: res.reason } : {}), txHash: hash })
  })

  return app
}
