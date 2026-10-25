import { describe, expect, it } from "vitest"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { pct } from "@keel/shared"
import { createApi, bindMessage } from "../src/api"
import { AlertEngine } from "../src/alerts"
import { signInitData } from "../src/telegram-auth"
import { parse } from "../src/nlu"
import { ADA, BOB, FakeChain, FakeNotifier, GUARDIAN, TOKEN, config, guardian, harness, trove } from "./helpers"
import { Store } from "../src/db"

const init = (id: number, username = "user" + id) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username, first_name: username }) }, TOKEN)
type Payload = Record<string, unknown>
const text = (p: Payload | undefined) => String(p?.text ?? "")
const buttons = (p: Payload | undefined) => ((p?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>> } | undefined)?.inline_keyboard ?? []).flat()

function apiSetup() {
  const store = new Store(":memory:")
  const chain = new FakeChain()
  const notifier = new FakeNotifier()
  const app = createApi({ config, store, chain, notifier })
  const post = (path: string, id: number, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": init(id) }, body: JSON.stringify(body) })
  const bind = async (id: number, acct = privateKeyToAccount(generatePrivateKey())) => {
    const { nonce } = (await (await post("/api/nonce", id)).json()) as { nonce: string }
    const signature = await acct.signMessage({ message: bindMessage(id, nonce) })
    expect((await post("/api/bind", id, { nonce, address: acct.address, signature })).status).toBe(200)
    return acct.address
  }
  return { store, chain, notifier, app, post, bind }
}

describe("POST /api/disconnect", () => {
  it("unlinks the wallet, clears nonces, pending intents, handoffs and alert state, keeps finished history", async () => {
    const { store, post, bind, notifier } = apiSetup()
    const addr = await bind(42)
    await post("/api/nonce", 42) // an unused nonce
    const pending = store.createIntent(42, "create_claim", { amount: "1" })
    const done = store.createIntent(42, "repay", { amount: "1" })
    store.completeIntent(done.id, "done", "0x" + "1".repeat(64))
    store.createHandoff(42, "link", null)
    store.setAlert(42, "icr", "warn")

    const r = (await (await post("/api/disconnect", 42)).json()) as { ok: boolean; disconnected: string }
    expect(r).toEqual({ ok: true, disconnected: addr })
    expect(store.getUser(42)!.address).toBeNull()
    expect(store.getIntent(pending.id)).toBeNull()
    expect(store.getIntent(done.id)!.status).toBe("done")
    expect(store.counts()).toMatchObject({ nonces: 0, handoffs: 0, alert_state: 0 })
    expect(notifier.sent.at(-1)!.text).toContain("disconnected")
    expect(store.getUser(42)!.username).toBe("user42") // the Telegram account itself stays
  })

  it("needs Telegram auth, and one user can never disconnect another", async () => {
    const { store, app, post, bind } = apiSetup()
    const adaAddr = await bind(42)
    const bobAddr = await bind(7)
    expect((await app.request("/api/disconnect", { method: "POST" })).status).toBe(401)
    expect((await app.request("/api/disconnect", { method: "POST", headers: { "x-telegram-init-data": init(7).replace("user7", "user8") } })).status).toBe(401)
    // the body is ignored: the target is always the caller from initData
    await post("/api/disconnect", 7, { tgId: 42 })
    expect(store.getUser(42)!.address).toBe(adaAddr)
    expect(store.getUser(7)!.address).toBeNull()
    void bobAddr
  })

  it("lets the user link a different wallet afterwards, or the same one again", async () => {
    const { store, post, bind } = apiSetup()
    const first = privateKeyToAccount(generatePrivateKey())
    await bind(42, first)
    await post("/api/disconnect", 42)
    const second = await bind(42)
    expect(store.getUser(42)!.address).toBe(second)
    await post("/api/disconnect", 42)
    await bind(42, first)
    expect(store.getUser(42)!.address).toBe(first.address)
  })

  it("stops alerts for the disconnected wallet", async () => {
    const { store, chain, notifier, post, bind } = apiSetup()
    const addr = await bind(42)
    chain.setView(addr as `0x${string}`, { trove: trove(pct(120)), kind: "direct", guardianAddress: null })
    await post("/api/disconnect", 42)
    notifier.sent.length = 0
    await new AlertEngine({ config, store, chain, notifier }).tick()
    expect(notifier.sent).toHaveLength(0)
  })
})

describe("bot: /disconnect, switching wallets, /resetme", () => {
  it("asks first, then unlinks and offers Connect wallet; Cancel keeps it", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/disconnect")
    const ask = h.last()!.payload
    expect(text(ask)).toContain("Disconnect <code>0x0000…00a1</code>?")
    expect(text(ask)).toContain("stay on-chain and untouched")
    await h.tap("cb:disconnect:no")
    expect(h.store.getUser(42)!.address).toBe(ADA)
    await h.tap("cb:disconnect:yes")
    expect(h.store.getUser(42)!.address).toBeNull()
    expect(text(h.last()!.payload)).toContain("disconnected")
    expect(buttons(h.last()!.payload)[0].web_app!.url).toContain("/#/link")
  })

  it("is reachable from the position card, /link and plain language", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/position")
    expect(buttons(h.last()!.payload).some((b) => b.callback_data === "cb:disconnect")).toBe(true)
    await h.say("/link")
    expect(buttons(h.last()!.payload).map((b) => b.text)).toEqual(["🔁 Switch wallet", "🔌 Disconnect wallet"])
    expect(parse("disconnect my wallet").intent).toBe("disconnect")
    expect(parse("switch to another wallet").intent).toBe("link_wallet")
    await h.say("please disconnect my wallet")
    expect(text(h.last()!.payload)).toContain("Disconnect <code>")
  })

  it("re-linking the same wallet finds its guardian and loan again from the chain", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.chain.setView(ADA, { trove: trove(pct(190)), guardian: guardian(), guardianAddress: GUARDIAN })
    await h.tap("cb:disconnect:yes")
    await h.say("/position")
    expect(text(h.last()!.payload)).toContain("Connect your wallet first")
    h.store.setAddress(42, ADA) // what /api/bind does after a fresh signature
    await h.say("/position")
    expect(text(h.last()!.payload)).toContain("190%")
    expect(text(h.last()!.payload)).toContain("guarded")
  })

  it("/resetme wipes an admin's records completely and is refused for everyone else", async () => {
    const h = harness()
    const admin = { id: 42, username: "ada", first_name: "Ada" }
    ;(h.bot as unknown as { __cfg?: unknown }).__cfg = undefined
    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say("/resetme", { id: 7, username: "bob", first_name: "Bob" }, { id: 7, type: "private" })
    expect(text(h.last()!.payload)).toContain("admins only")
    expect(h.store.getUser(7)!.address).toBe(BOB)

    // the shared test config has no admins; make Ada one for this test
    config.adminIds.push(42)
    try {
      h.store.upsertUser(42, "ada", "Ada")
      h.store.setAddress(42, ADA)
      h.store.createIntent(42, "repay", { amount: "1" })
      h.store.setKv("premium:42", "9999999999")
      await h.say("borrow")
      await h.say("/resetme", admin)
      expect(text(h.last()!.payload)).toContain("wiped")
      expect(h.store.getUser(42)).toBeNull()
      expect(h.store.getKv("premium:42")).toBeNull()
      expect((h.store.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE tg_id = 42").get() as { n: number }).n).toBe(0)
      expect((h.store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'nl:%' AND value LIKE '%\"tg\":42,%'").get() as { n: number }).n).toBe(0)
      expect(h.store.getUser(7)!.address).toBe(BOB) // other users untouched
      await h.say("/start", admin)
      expect(text(h.last()!.payload)).toContain("No commands needed") // the first-time welcome again
    } finally {
      config.adminIds.splice(config.adminIds.indexOf(42), 1)
    }
  })
})
