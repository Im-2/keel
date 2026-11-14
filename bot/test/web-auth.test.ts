import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { E18, pct } from "@keel/shared"
import { Store } from "../src/db"
import { createApi } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus } from "../src/live"
import { signInitData } from "../src/telegram-auth"
import { WebSessions, webUserId } from "../src/web-auth"
import { FakeChain, FakeNotifier, TOKEN, config, guardian, trove } from "./helpers"

/**
 * Wallet sign-in for the web app: a signed nonce becomes a short-lived session that carries only a wallet address.
 * The server resolves the account from it on every request, so no client-supplied id or address can widen access.
 */
const A_ID = 42 // a Telegram user with a loan
const alice = privateKeyToAccount(generatePrivateKey())
const webby = privateKeyToAccount(generatePrivateKey()) // a wallet that has never touched Telegram
const mallory = privateKeyToAccount(generatePrivateKey())

function setup() {
  const store = new Store(":memory:")
  store.upsertUser(A_ID, "alice", "Alice")
  store.setAddress(A_ID, alice.address)
  const chain = new FakeChain()
  chain.setView(alice.address, { trove: trove(pct(160), { coll: 398n * E18 / 10_000n, debt: 20018n * E18 / 10n }), guardian: guardian({ reserveBTC: 5n * E18 / 1000n }) })
  chain.musd.set(alice.address.toLowerCase(), 1234n * E18)
  const notifier = new FakeNotifier()
  const live = new LiveBus()
  const sessions = new WebSessions(store)
  const completion = createCompletion({ config, store, chain, notifier, live })
  const history = new History({ config, store, chain, explorerApi: null })
  const app = createApi({ config, store, chain, notifier, live, completion, history, sessions })
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  async function signIn(acct: typeof alice, signer = acct) {
    const n = (await (await req("POST", "/api/web/nonce", { address: acct.address })).json()) as { nonce: string; message: string }
    const signature = await signer.signMessage({ message: n.message })
    return req("POST", "/api/web/session", { address: acct.address, nonce: n.nonce, signature })
  }
  async function session(acct: typeof alice) {
    const r = (await (await signIn(acct)).json()) as { token: string }
    return (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => req(method, path, body, { "x-keel-session": r.token, ...extra })
  }
  const tgInit = (id: number) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `u${id}`, first_name: "T" }) }, TOKEN)
  return { store, chain, notifier, sessions, app, req, signIn, session, tgInit }
}

describe("web sign-in", () => {
  it("the nonce message names the domain, wallet, chain and nonce, and signing it opens a session", async () => {
    const s = setup()
    const n = (await (await s.req("POST", "/api/web/nonce", { address: webby.address })).json()) as { nonce: string; message: string }
    expect(n.message).toContain(webby.address)
    expect(n.message).toContain(`Chain ID: ${config.deployment.chainId}`)
    expect(n.message).toContain(`Nonce: ${n.nonce}`)
    expect(n.message).toMatch(/free and moves no funds/)
    const res = await s.req("POST", "/api/web/session", { address: webby.address, nonce: n.nonce, signature: await webby.signMessage({ message: n.message }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expires: number; telegram: boolean }
    expect(body.token.length).toBeGreaterThan(30)
    expect(body.telegram).toBe(false)
    expect(body.expires - Date.now() / 1000).toBeGreaterThan(11 * 3600)
  })

  it("a new wallet gets a web-only account (negative id) with its own empty data", async () => {
    const s = setup()
    const as = await s.session(webby)
    const me = (await (await as("GET", "/api/me")).json()) as Record<string, unknown>
    expect(me).toMatchObject({ web: true, telegram: false, tgId: null, address: webby.address })
    expect(s.store.findByAddress(webby.address)?.tg_id).toBe(webUserId(webby.address))
    expect(webUserId(webby.address)).toBeLessThan(0)
    const pos = (await (await as("GET", "/api/position")).json()) as Record<string, unknown>
    expect(pos).toMatchObject({ linked: true, address: webby.address, trove: null })
  })

  it("a wallet already linked to Telegram signs in to that same account", async () => {
    const s = setup()
    const as = await s.session(alice)
    const pos = (await (await as("GET", "/api/position")).json()) as Record<string, any>
    expect(pos.address).toBe(alice.address)
    expect(pos.trove.debt).toBe((20018n * E18 / 10n).toString())
    expect(((await (await as("GET", "/api/me")).json()) as any).telegram).toBe(true)
  })

  it("rejects a signature from another wallet, a reused nonce, and a nonce issued for another address", async () => {
    const s = setup()
    expect((await s.signIn(alice, mallory)).status).toBe(401)
    // reuse: the nonce is single use, even after a failed attempt
    const n = (await (await s.req("POST", "/api/web/nonce", { address: webby.address })).json()) as { nonce: string; message: string }
    const sig = await webby.signMessage({ message: n.message })
    expect((await s.req("POST", "/api/web/session", { address: webby.address, nonce: n.nonce, signature: sig })).status).toBe(200)
    expect((await s.req("POST", "/api/web/session", { address: webby.address, nonce: n.nonce, signature: sig })).status).toBe(401)
    // a nonce for Alice's address can't be used to sign in as another wallet
    const na = (await (await s.req("POST", "/api/web/nonce", { address: alice.address })).json()) as { nonce: string; message: string }
    expect((await s.req("POST", "/api/web/session", { address: mallory.address, nonce: na.nonce, signature: await mallory.signMessage({ message: na.message }) })).status).toBe(401)
    expect((await s.req("POST", "/api/web/session", { address: "nope", nonce: "x", signature: "0x00" })).status).toBe(400)
  })

  it("no session, a made-up token or an expired session gets 401 on user routes", async () => {
    const s = setup()
    expect((await s.req("GET", "/api/position")).status).toBe(401)
    expect((await s.req("GET", "/api/position", undefined, { "x-keel-session": "made-up" })).status).toBe(401)
    const r = (await (await s.signIn(webby)).json()) as { token: string }
    // expire it in storage
    for (const row of s.store.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'ws:%'").all() as Array<{ key: string; value: string }>) {
      s.store.setKv(row.key, JSON.stringify({ ...JSON.parse(row.value), exp: 1 }))
    }
    const res = await s.req("GET", "/api/position", undefined, { "x-keel-session": r.token })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).code).toBe("session")
  })

  it("isolation: a web session never sees another account's data, whatever the client sends", async () => {
    const s = setup()
    const as = await s.session(mallory)
    const secrets = [alice.address.toLowerCase(), (1234n * E18).toString(), "alice"]
    for (const path of ["/api/position", `/api/position?address=${alice.address}`, "/api/activity", "/api/me"]) {
      const res = await as("GET", path, undefined, { "x-wallet": alice.address, "x-user-id": String(A_ID) })
      expect(res.status, path).toBe(200)
      const body = (await res.text()).toLowerCase()
      expect(secrets.filter((x) => body.includes(x.toLowerCase())), path).toEqual([])
    }
    const intent = s.store.createIntent(A_ID, "repay", { amount: E18.toString() })
    expect((await as("GET", `/api/intent/${intent.id}`)).status).toBe(404)
    expect((await as("POST", `/api/intent/${intent.id}/complete`, { status: "submitted", txHash: "0x" + "cd".repeat(32) })).status).toBe(404)
  })

  it("Telegram initData wins over a session header sent alongside it", async () => {
    const s = setup()
    const as = await s.session(mallory)
    const pos = (await (await as("GET", "/api/position", undefined, { "x-telegram-init-data": s.tgInit(A_ID) })).json()) as any
    expect(pos.address).toBe(alice.address)
  })

  it("a web session can't relink wallets, unlink, or open handoffs (those need Telegram)", async () => {
    const s = setup()
    const as = await s.session(webby)
    expect((await as("POST", "/api/nonce", {})).status).toBe(403)
    expect((await as("POST", "/api/bind", { address: mallory.address, nonce: "x", signature: "0x00" })).status).toBe(403)
    expect((await as("POST", "/api/disconnect", {})).status).toBe(401)
    expect((await as("POST", "/api/handoff", { purpose: "link" })).status).toBe(401)
    expect(s.store.findByAddress(webby.address)).not.toBeNull()
  })

  it("a web user can start actions: intents are created for their own account", async () => {
    const s = setup()
    const as = await s.session(webby)
    const r = await as("POST", "/api/intent", { type: "borrow", amount: (1800n * E18).toString(), targetIcr: pct(160).toString() })
    expect(r.status).toBe(200)
    const i = (await r.json()) as { id: string; tg_id: number }
    expect(i.tg_id).toBe(webUserId(webby.address))
    expect((await as("GET", `/api/intent/${i.id}`)).status).toBe(200)
    // and Alice (Telegram) can't see it
    expect((await s.req("GET", `/api/intent/${i.id}`, undefined, { "x-telegram-init-data": s.tgInit(A_ID) })).status).toBe(404)
  })

  it("live stream tokens work with a web session", async () => {
    const s = setup()
    const as = await s.session(webby)
    expect((await as("POST", "/api/live/token", {})).status).toBe(200)
  })

  it("logout ends the session", async () => {
    const s = setup()
    const r = (await (await s.signIn(webby)).json()) as { token: string }
    await s.req("POST", "/api/web/logout", {}, { "x-keel-session": r.token })
    expect((await s.req("GET", "/api/me", undefined, { "x-keel-session": r.token })).status).toBe(401)
  })
})

describe("connecting Telegram later", () => {
  it("a web account gets a one-time bot link; redeeming it moves the wallet and its history to the Telegram account", async () => {
    const s = setup()
    const as = await s.session(webby)
    const intent = (await (await as("POST", "/api/intent", { type: "fund_reserve", amount: (E18 / 1000n).toString() })).json()) as { id: string }
    const link = (await (await as("POST", "/api/web/telegram", {})).json()) as { linked: boolean; url: string }
    expect(link.linked).toBe(false)
    const m = /^https:\/\/t\.me\/\w+\?start=web_([\w-]+)$/.exec(link.url)
    expect(m).not.toBeNull()
    expect(link.url.length - link.url.indexOf("start=") - 6).toBeLessThanOrEqual(64) // Telegram's start payload limit
    const TG = 900
    s.store.upsertUser(TG, "newbie", "New")
    const r = s.sessions.redeemTelegramLink(m![1], TG)
    expect(r).toEqual({ ok: true, address: webby.address })
    expect(s.store.findByAddress(webby.address)?.tg_id).toBe(TG)
    expect(s.store.getUser(webUserId(webby.address))).toBeNull()
    expect(s.store.getIntent(intent.id)?.tg_id).toBe(TG)
    // the same browser session now reads the Telegram account
    const me = (await (await as("GET", "/api/me")).json()) as any
    expect(me).toMatchObject({ telegram: true, tgId: TG, address: webby.address })
    // single use
    expect(s.sessions.redeemTelegramLink(m![1], TG).ok).toBe(false)
  })

  it("won't overwrite a Telegram account that already has a different wallet", async () => {
    const s = setup()
    const as = await s.session(webby)
    const code = /web_([\w-]+)$/.exec(((await (await as("POST", "/api/web/telegram", {})).json()) as any).url)![1]
    const r = s.sessions.redeemTelegramLink(code, A_ID)
    expect(r.ok).toBe(false)
    expect(s.store.findByAddress(alice.address)?.tg_id).toBe(A_ID)
    expect(s.store.findByAddress(webby.address)?.tg_id).toBe(webUserId(webby.address))
  })

  it("a Telegram-linked wallet's session reports it is already connected", async () => {
    const s = setup()
    const as = await s.session(alice)
    expect(((await (await as("POST", "/api/web/telegram", {})).json()) as any).linked).toBe(true)
  })

  it("unlinking the wallet in Telegram ends its web sessions", async () => {
    const s = setup()
    const as = await s.session(alice)
    expect((await as("GET", "/api/me")).status).toBe(200)
    s.store.disconnect(A_ID)
    expect((await as("GET", "/api/me")).status).toBe(401)
  })
})
