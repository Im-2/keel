import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { isAddress, verifyMessage, type Address, type Hex } from "viem"
import { explorerTx, fmtMusd } from "@keel/shared"
import type { Config } from "./config"
import type { IntentRow, Store } from "./db"
import type { ChainService } from "./chain"
import type { Notifier } from "./notify"
import type { ClaimRelayer } from "./relayer"
import { renderRequest, esc } from "./format"
import { validateInitData, type InitData } from "./telegram-auth"
import { payKeyboard } from "./bot"
import { mountPremium, type Premium } from "./premium"

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
}

export const bindMessage = (tgId: number, nonce: string) => `Link this wallet to Keel (Telegram account ${tgId}).\nNonce: ${nonce}`

const INIT_HEADER = "x-telegram-init-data"

export function createApi(d: ApiDeps) {
  const { config, store, chain, notifier } = d
  const app = new Hono<{ Variables: { tg: InitData } }>()
  const miniappOrigin = (() => {
    try {
      return new URL(config.miniappUrl).origin
    } catch {
      return "*"
    }
  })()
  app.use("/api/*", cors({ origin: [miniappOrigin, "http://localhost:5173", "https://localhost:5173"], exposeHeaders: ["*"] }))

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
  app.get("/api/claim/:link", async (c) => {
    const link = c.req.param("link")
    if (!isAddress(link) || !d.relayer) return c.json({ error: "bad request" }, 400)
    const info = await d.relayer.link(link as Address)
    if (!info) return c.json({ error: "unknown link" }, 404)
    return c.json({ sender: info.sender, amount: info.amount.toString(), expiry: info.expiry, settled: info.settled })
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
        if (senderUser && !senderUser.settings.muted) {
          const claimer = store.findByAddress(body.to)
          const who = claimer ? (claimer.username ? "@" + claimer.username : claimer.first_name ?? "someone") : `${(body.to as string).slice(0, 8)}…`
          await notifier.send(senderUser.tg_id, `🎁 Your claim link of <b>${fmtMusd(info.amount, 2)}</b> was claimed by ${esc(who)}.`, {
            buttonText: "View transaction",
            buttonUrl: explorerTx(config.network, tx),
          })
        }
      }
      return c.json({ txHash: tx })
    } catch (e) {
      const msg = (e as Error).message
      const friendly = /LinkSettled/.test(msg) ? "This link was already claimed or cancelled." : /Expired/.test(msg) ? "This link has expired." : /BadSignature/.test(msg) ? "That link key is not valid." : /LinkUnknown/.test(msg) ? "Unknown link." : "Could not claim right now."
      return c.json({ error: friendly }, 400)
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
  const tgOf = (c: Context) => c.get("tg" as never) as InitData
  const userOf = (c: Context) => {
    const { user } = tgOf(c)
    return store.upsertUser(user.id, user.username, user.first_name)
  }
  if (d.premium) mountPremium(app, { config, premium: d.premium, auth: auth as never, tgIdOf: ((c: Context) => tgOf(c).user.id) as never, onGranted: (tgId, until) => notifier.send(tgId, `⭐ <b>Keel Premium is on</b> until ${new Date(until * 1000).toISOString().slice(0, 10)}: your loan is now checked every few seconds instead of minutes.`) })
  app.use("/api/me", auth)
  app.use("/api/nonce", auth)
  app.use("/api/bind", auth)
  app.use("/api/intent/*", auth)

  app.get("/api/me", (c) => {
    const u = userOf(c)
    return c.json({ tgId: u.tg_id, username: u.username, address: u.address, settings: u.settings })
  })

  app.post("/api/nonce", (c) => {
    const u = userOf(c)
    const nonce = store.issueNonce(u.tg_id)
    return c.json({ nonce, message: bindMessage(u.tg_id, nonce) })
  })

  app.post("/api/bind", async (c) => {
    const u = userOf(c)
    const body = await c.req.json().catch(() => null)
    if (!body || !isAddress(body.address) || typeof body.nonce !== "string" || typeof body.signature !== "string") return c.json({ error: "bad request" }, 400)
    if (!store.consumeNonce(body.nonce, u.tg_id)) return c.json({ error: "nonce expired, please try again" }, 400)
    const ok = await verifyMessage({ address: body.address, message: bindMessage(u.tg_id, body.nonce), signature: body.signature as Hex }).catch(() => false)
    if (!ok) return c.json({ error: "signature does not match this wallet" }, 400)
    store.setAddress(u.tg_id, body.address)
    await notifier.send(u.tg_id, `🔗 Wallet linked: <code>${body.address}</code>\nTry /position or /borrow 5000.`)
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
    const status = body.status === "failed" ? "failed" : "done"
    const txHash: string | undefined = typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash : undefined
    if (intent.status !== "pending") return c.json({ ok: true, status: intent.status })
    if (status === "done") {
      if (!txHash) return c.json({ error: "txHash required" }, 400)
      const rc = await chain.receipt(txHash)
      if (!rc || !rc.ok) return c.json({ error: "transaction not confirmed yet" }, 409)
      const u = store.getUser(intent.tg_id)
      if (!u?.address || rc.from.toLowerCase() !== u.address.toLowerCase()) return c.json({ error: "transaction was not sent by your linked wallet" }, 403)
    }
    store.completeIntent(intent.id, status, txHash)
    if (status === "done") {
      await afterIntent(intent, txHash!)
    }
    return c.json({ ok: true })
  })

  async function afterIntent(intent: IntentRow, txHash: string) {
    const user = store.getUser(intent.tg_id)!
    const p = intent.params as Record<string, string>
    const url = explorerTx(config.network, txHash)
    const verbs: Partial<Record<IntentRow["type"], string>> = {
      borrow: "✅ Loan opened.", repay: "✅ Repayment confirmed.", add_collateral: "✅ Collateral added.", fund_reserve: "✅ Reserve funded.",
      protect_config: "✅ Protection settings saved.", send: `✅ Sent${p.label ? " to " + esc(p.label) : ""}.`, pay_request: "✅ Payment sent.", create_claim: "🎁 Claim link created.",
    }
    const text = verbs[intent.type]
    if (text) await notifier.send(user.tg_id, text + (intent.type === "borrow" ? "\nSee /position for your ratio and liquidation price." : ""), { buttonText: "View transaction", buttonUrl: url })

    if (intent.type === "send" && p.toTg) {
      const to = store.getUser(Number(p.toTg))
      if (to) await notifier.send(to.tg_id, `💸 ${user.username ? "@" + esc(user.username) : esc(user.first_name ?? "Someone")} sent you <b>${fmtMusd(BigInt(p.amount), 2)}</b>.`, { buttonText: "View transaction", buttonUrl: url })
    }
    if (intent.type === "pay_request" && p.requestId) {
      const req = store.markRequestPaid(p.requestId, { tg_id: user.tg_id, tx_hash: txHash, username: user.username ?? undefined })
      const fresh = req && store.getRequest(req.id)
      if (fresh?.message_id && d.editMessage) {
        const requester = store.getUser(fresh.requester_tg)
        await d.editMessage(fresh.chat_id, fresh.message_id, renderRequest(fresh, requester?.username ? "@" + requester.username : requester?.first_name ?? "Someone"), payKeyboard(config.botUsername, fresh.id)).catch(() => undefined)
      }
      if (fresh) await notifier.send(fresh.requester_tg, `💸 ${user.username ? "@" + esc(user.username) : "Someone"} paid your request.`, { buttonText: "View transaction", buttonUrl: url })
    }
  }

  return app
}
