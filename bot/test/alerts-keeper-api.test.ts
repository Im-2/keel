import { describe, expect, it } from "vitest"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { E18, pct } from "@keel/shared"
import type { Address, Hex } from "viem"
import { AlertEngine } from "../src/alerts"
import { createApi, bindMessage } from "../src/api"
import { Keeper, type KeeperBackend } from "../src/keeper"
import { signInitData } from "../src/telegram-auth"
import { Store } from "../src/db"
import type { ClaimRelayer } from "../src/relayer"
import { ADA, BOB, FakeChain, FakeNotifier, GUARDIAN, TOKEN, config, guardian, sys, trove } from "./helpers"

function setup() {
  const store = new Store(":memory:")
  store.upsertUser(42, "ada", "Ada")
  store.setAddress(42, ADA)
  const chain = new FakeChain()
  const notifier = new FakeNotifier()
  const engine = new AlertEngine({ config, store, chain, notifier })
  return { store, chain, notifier, engine }
}

describe("alerts", () => {
  it("warns once as the ratio falls, escalates, and re-arms only after recovery (hysteresis)", async () => {
    const { chain, notifier, engine } = setup()
    const at = async (icr: number) => {
      chain.setView(ADA, { trove: trove(pct(icr)), guardian: null, guardianAddress: null, kind: "direct" })
      await engine.tick()
    }
    await at(200)
    expect(notifier.sent).toHaveLength(0)
    await at(145)
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].text).toContain("Heads up")
    await at(144) // same band: no repeat
    expect(notifier.sent).toHaveLength(1)
    await at(125)
    expect(notifier.sent).toHaveLength(2)
    expect(notifier.sent[1].text).toContain("Urgent")
    await at(152) // above warn but inside hysteresis band: no "healthy" message yet
    expect(notifier.sent).toHaveLength(2)
    await at(170)
    expect(notifier.sent).toHaveLength(3)
    expect(notifier.sent[2].text).toContain("healthy")
    await at(148) // re-armed
    expect(notifier.sent).toHaveLength(4)
  })

  it("respects mute", async () => {
    const { store, chain, notifier, engine } = setup()
    store.updateSettings(42, { muted: true })
    chain.setView(ADA, { trove: trove(pct(120)), kind: "direct", guardianAddress: null })
    await engine.tick()
    expect(notifier.sent).toHaveLength(0)
  })

  it("alerts on redemption exposure once", async () => {
    const { chain, notifier, engine } = setup()
    chain.setView(ADA, { trove: trove(pct(200)), kind: "direct", guardianAddress: null, redemption: { ahead: 5_000n * E18, rank: 1, total: 10 } })
    await engine.tick()
    await engine.tick()
    expect(notifier.sent.filter((m) => m.text.includes("Redemption exposure"))).toHaveLength(1)
  })

  it("announces Recovery Mode flips but not the first observation", async () => {
    const { chain, notifier, engine } = setup()
    chain.setView(ADA, { trove: trove(pct(200)), kind: "direct", guardianAddress: null })
    await engine.tick()
    expect(notifier.sent).toHaveLength(0)
    chain.sysState = sys({ recoveryMode: true, tcr: pct(140) })
    await engine.tick()
    expect(notifier.sent.at(-1)!.text).toContain("Recovery Mode is ON")
    await engine.tick()
    expect(notifier.sent.filter((m) => m.text.includes("Recovery Mode is ON"))).toHaveLength(1)
  })

  it("reports guardian protections and incoming transfers from new blocks", async () => {
    const { store, chain, notifier, engine } = setup()
    chain.setView(ADA, { trove: trove(pct(200)), guardian: guardian() })
    await engine.tick() // records block head
    chain.head = 105n
    chain.protectedLogs = [{ guardian: GUARDIAN, btcAdded: E18 / 100n, musdRepaid: 0n, icrBefore: pct(128), icrAfter: pct(150), tx: "0xabc" }]
    chain.transfers = [{ from: BOB, to: ADA, value: 25n * E18, tx: "0xdef" }]
    await engine.tick()
    const texts = notifier.sent.map((m) => m.text)
    expect(texts.some((t) => t.includes("Guardian protected") && t.includes("128%") && t.includes("150%"))).toBe(true)
    expect(texts.some((t) => t.includes("received") && t.includes("25 MUSD"))).toBe(true)
    expect(store.getKv("stat:protections")).toBe("1")
  })
})

describe("keeper", () => {
  it("protects only guardians that report canProtect and survives failures", async () => {
    const store = new Store(":memory:")
    const g = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
    const protectedCalls: Address[] = []
    const backend: KeeperBackend = {
      guardians: async () => [g(1), g(2), g(3)],
      canProtect: async (a) => a !== g(1),
      protect: async (a) => {
        if (a === g(2)) throw new Error("boom")
        protectedCalls.push(a)
        return "0xhash" as Hex
      },
    }
    const done = await new Keeper(backend, store, () => undefined).tick()
    expect(done).toEqual([g(3)])
    expect(protectedCalls).toEqual([g(3)])
    expect(store.getKv("stat:keeper_protections")).toBe("1")
  })
})

describe("api", () => {
  const init = (id = 42) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: "ada", first_name: "Ada" }) }, TOKEN)
  const mk = () => {
    const s = setup()
    const claims: Array<[Address, Address]> = []
    const relayer: ClaimRelayer = {
      link: async () => ({ sender: ADA, amount: 10n * E18, expiry: 9999999999, settled: false }),
      claim: async (l, to) => (claims.push([l, to]), "0x" + "ab".repeat(32) as Hex),
    }
    const app = createApi({ config, store: s.store, chain: s.chain, notifier: s.notifier, relayer })
    return { ...s, app, claims }
  }
  const post = (app: ReturnType<typeof mk>["app"], path: string, body: unknown, id = 42) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": init(id) }, body: JSON.stringify(body) })

  it("rejects missing or forged initData", async () => {
    const { app } = mk()
    expect((await app.request("/api/me")).status).toBe(401)
    expect((await app.request("/api/me", { headers: { "x-telegram-init-data": init().replace("Ada", "Eve") } })).status).toBe(401)
  })

  it("binds a wallet with nonce + signature, and the nonce is single use", async () => {
    const { app, store } = mk()
    const acct = privateKeyToAccount(generatePrivateKey())
    const { nonce } = (await (await post(app, "/api/nonce", {})).json()) as { nonce: string }
    const signature = await acct.signMessage({ message: bindMessage(42, nonce) })
    const ok = await post(app, "/api/bind", { nonce, address: acct.address, signature })
    expect(ok.status).toBe(200)
    expect(store.getUser(42)!.address).toBe(acct.address)
    expect((await post(app, "/api/bind", { nonce, address: acct.address, signature })).status).toBe(400)
    // signature from a different key is refused
    const other = privateKeyToAccount(generatePrivateKey())
    const n2 = ((await (await post(app, "/api/nonce", {})).json()) as { nonce: string }).nonce
    const bad = await post(app, "/api/bind", { nonce: n2, address: acct.address, signature: await other.signMessage({ message: bindMessage(42, n2) }) })
    expect(bad.status).toBe(400)
  })

  it("only lets the owner read and complete an intent, and checks the receipt sender", async () => {
    const { app, store, chain, notifier } = mk()
    const i = store.createIntent(42, "repay", { amount: "1" })
    const get = (id: number) => app.request(`/api/intent/${i.id}`, { headers: { "x-telegram-init-data": init(id) } })
    expect((await get(42)).status).toBe(200)
    expect((await get(99)).status).toBe(404)
    const tx = "0x" + "11".repeat(32)
    expect((await post(app, `/api/intent/${i.id}/complete`, { txHash: tx })).status).toBe(409)
    chain.receipts.set(tx, { ok: true, from: BOB })
    expect((await post(app, `/api/intent/${i.id}/complete`, { txHash: tx })).status).toBe(403)
    chain.receipts.set(tx, { ok: true, from: ADA })
    expect((await post(app, `/api/intent/${i.id}/complete`, { txHash: tx })).status).toBe(200)
    expect(store.getIntent(i.id)!.status).toBe("done")
    expect(notifier.sent.at(-1)!.text).toContain("Repayment confirmed")
  })

  it("marks a group request paid and edits the group message", async () => {
    const s = mk()
    const edits: string[] = []
    const app = createApi({ config, store: s.store, chain: s.chain, notifier: s.notifier, editMessage: async (_c, _m, html) => void edits.push(html) })
    const r = s.store.createRequest({ chat_id: -1, requester_tg: 7, requester_address: BOB, amount: "30", memo: "dinner", participants: [{ username: "ada" }] })
    s.store.setRequestMessage(r.id, 5)
    s.store.upsertUser(7, "bob", "Bob")
    const i = s.store.createIntent(42, "pay_request", { requestId: r.id, to: BOB, amount: "30" })
    const tx = "0x" + "22".repeat(32)
    s.chain.receipts.set(tx, { ok: true, from: ADA })
    expect((await post(app, `/api/intent/${i.id}/complete`, { txHash: tx })).status).toBe(200)
    expect(edits[0]).toContain("✅ @ada")
    expect(s.notifier.sent.some((m) => m.to === 7 && m.text.includes("paid your request"))).toBe(true)
  })

  it("relays claims and notifies the sender", async () => {
    const { app, claims, notifier } = mk()
    const link = "0x00000000000000000000000000000000000000d4"
    const r = await app.request("/api/claim/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link, to: BOB, signature: "0x1234" }) })
    expect(r.status).toBe(200)
    expect(claims).toEqual([[link, BOB]])
    expect(notifier.sent.at(-1)!.text).toContain("claimed")
    expect((await app.request("/api/claim/relay", { method: "POST", body: "{}" })).status).toBe(400)
  })
})

describe("premium", () => {
  it("grants and extends time, and premium users are polled on every tick", async () => {
    const { store, chain, notifier } = setup()
    const { Premium } = await import("../src/premium")
    const prem = new Premium(store, () => 1_000)
    expect(prem.isPremium(42)).toBe(false)
    expect(prem.grant(42, 30)).toBe(1_000 + 30 * 86_400)
    expect(prem.grant(42, 30)).toBe(1_000 + 60 * 86_400)
    expect(prem.isPremium(42)).toBe(true)

    store.upsertUser(43, "bob", "Bob")
    store.setAddress(43, BOB)
    const engine = new AlertEngine({ config, store, chain, notifier, isPremium: (id) => id === 42 }, 4)
    chain.setView(ADA, { trove: trove(pct(120)), kind: "direct", guardianAddress: null })
    chain.setView(BOB, { trove: trove(pct(120)), kind: "direct", guardianAddress: null })
    await engine.tick() // tick 1: premium only
    expect(notifier.sent.map((m) => m.to)).toEqual([42])
    await engine.tick()
    await engine.tick()
    await engine.tick() // tick 4: everyone
    expect(notifier.sent.map((m) => m.to).sort()).toEqual([42, 43])
  })
})

describe("mini app routes", () => {
  const init2 = (id = 42) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: "ada", first_name: "Ada" }) }, TOKEN)
  const mk2 = () => {
    const s = setup()
    const app = createApi({ config, store: s.store, chain: s.chain, notifier: s.notifier })
    const req = (method: string, path: string, body?: unknown, id = 42) =>
      app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init2(id) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ...s, req }
  }

  it("serves the position with bigints as strings, and the activity list", async () => {
    const { chain, req, store } = mk2()
    chain.setView(ADA, { trove: trove(pct(160)), guardian: guardian() })
    const p = (await (await req("GET", "/api/position")).json()) as { linked: boolean; trove: { icr: string }; guardian: { enabled: boolean }; wallet: { btc: string } }
    expect(p.linked).toBe(true)
    expect(p.trove.icr).toBe(pct(160).toString())
    expect(p.guardian.enabled).toBe(true)
    expect(p.wallet.btc).toBe((10n * E18).toString())
    const i = store.createIntent(42, "repay", { amount: "1" })
    store.completeIntent(i.id, "done", "0x" + "1".repeat(64))
    const a = (await (await req("GET", "/api/activity")).json()) as { items: Array<{ type: string }> }
    expect(a.items.map((x) => x.type)).toEqual(["repay"])
  })

  it("creates validated intents and resolves @handles for send", async () => {
    const { req, store } = mk2()
    const ok = (await (await req("POST", "/api/intent", { type: "borrow", amount: (1800n * E18).toString(), targetIcr: pct(160).toString(), evil: "x" })).json()) as { id: string; params: Record<string, unknown> }
    expect(store.getIntent(ok.id)!.params).toEqual({ amount: (1800n * E18).toString(), targetIcr: pct(160).toString() })
    expect((await req("POST", "/api/intent", { type: "borrow", amount: "1", targetIcr: pct(105).toString() })).status).toBe(400)
    expect((await req("POST", "/api/intent", { type: "withdraw_reserve" })).status).toBe(400)
    const miss = await req("POST", "/api/intent", { type: "send", to: "@nobody", amount: "5" })
    expect(miss.status).toBe(404)
    store.upsertUser(7, "bob", "Bob")
    store.setAddress(7, BOB)
    const sent = (await (await req("POST", "/api/intent", { type: "send", to: "@bob", amount: "5" })).json()) as { params: { to: string } }
    expect(sent.params.to).toBe(BOB)
    expect((await req("POST", "/api/intent", { type: "repay", amount: "5" }, 99)).status).toBe(400) // unlinked user
  })
})

describe("wallet-browser handoff", () => {
  const init3 = (id = 42) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: "ada", first_name: "Ada" }) }, TOKEN)
  const mk3 = () => {
    const s = setup()
    const app = createApi({ config, store: s.store, chain: s.chain, notifier: s.notifier })
    const tgReq = (method: string, path: string, body?: unknown, id = 42) => app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init3(id) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const hoReq = (token: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", "x-keel-handoff": token }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ...s, tgReq, hoReq }
  }

  it("links a wallet from outside Telegram with a single-use token, without touching other routes", async () => {
    const { tgReq, hoReq, store } = mk3()
    const h = (await (await tgReq("POST", "/api/handoff", { purpose: "link" })).json()) as { token: string; url: string }
    expect(h.url).toMatch(/^https:\/\/app\.example\/\?w=[\w-]+&r=link$/)
    expect((await hoReq(h.token, "GET", "/api/position")).status).toBe(401) // dashboard needs Telegram
    expect((await hoReq(h.token, "POST", "/api/handoff", { purpose: "link" })).status).toBe(401)
    expect((await hoReq(h.token, "GET", `/api/intent/whatever`)).status).toBe(403)
    const acct = privateKeyToAccount(generatePrivateKey())
    const { nonce, message } = (await (await hoReq(h.token, "POST", "/api/nonce", {})).json()) as { nonce: string; message: string }
    expect(message).toContain("42")
    const signature = await acct.signMessage({ message })
    expect((await hoReq(h.token, "POST", "/api/bind", { nonce, address: acct.address, signature })).status).toBe(200)
    expect(store.getUser(42)!.address).toBe(acct.address)
    expect(store.getUser(42)!.username).toBe("ada") // a handoff never blanks the profile
    expect((await hoReq(h.token, "POST", "/api/nonce", {})).status).toBe(401) // used up
  })

  it("is bound to one intent of its owner, single use, and expires", async () => {
    const { tgReq, hoReq, store, chain } = mk3()
    const mine = store.createIntent(42, "repay", { amount: "1" })
    const other = store.createIntent(42, "repay", { amount: "2" })
    const theirs = store.createIntent(99, "repay", { amount: "3" })
    expect((await tgReq("POST", "/api/handoff", { purpose: "intent", intentId: theirs.id })).status).toBe(404)
    const h = (await (await tgReq("POST", "/api/handoff", { purpose: "intent", intentId: mine.id })).json()) as { token: string }
    expect((await hoReq(h.token, "GET", `/api/intent/${mine.id}`)).status).toBe(200)
    expect((await hoReq(h.token, "GET", `/api/intent/${other.id}`)).status).toBe(403)
    expect((await hoReq(h.token, "POST", "/api/nonce", {})).status).toBe(403)
    const tx = "0x" + "33".repeat(32)
    chain.receipts.set(tx, { ok: true, from: ADA })
    expect((await hoReq(h.token, "POST", `/api/intent/${mine.id}/complete`, { txHash: tx })).status).toBe(200)
    expect(store.getIntent(mine.id)!.status).toBe("done")
    expect((await hoReq(h.token, "GET", `/api/intent/${mine.id}`)).status).toBe(401)
    const old = store.createHandoff(42, "intent", other.id, -1)
    expect((await hoReq(old.token, "GET", `/api/intent/${other.id}`)).status).toBe(401)
    expect((await hoReq("forged", "GET", `/api/intent/${other.id}`)).status).toBe(401)
  })
})

describe("alerts: one-tap protection buttons", () => {
  const intentFromButton = (store: Store, url?: string) => (url ? store.getIntent(url.split("/i/")[1]!) : null)

  it("ratio alerts carry add-collateral and repay buttons sized to reach the target, plus turn-on-protection", async () => {
    const { store, chain, notifier, engine } = setup()
    // 1 BTC at 100k against 80k debt = 125%: below the 130% danger line
    chain.setView(ADA, { trove: trove(pct(125), { coll: E18, debt: 80_000n * E18, price: 100_000n * E18 }), guardian: null, guardianAddress: null, kind: "direct" })
    await engine.tick()
    const msg = notifier.sent[0]
    expect(msg.text).toContain("Urgent")
    const rows = msg.opts!.buttons!.flat()
    expect(rows.map((b) => b.text.split(" ")[1])).toEqual(["Add", "Repay", "Turn"])
    for (const b of rows) expect(b.webApp).toMatch(/^https:\/\/app\.example\/#\/i\//)
    // target = warn 150% + 15 = 165%: needs 1.32 BTC total -> add 0.32 BTC; or repay down to 60,606 MUSD
    const add = intentFromButton(store, rows[0].webApp)!
    expect(add.type).toBe("add_collateral")
    expect(BigInt(add.params.amount as string)).toBe(32n * 10n ** 16n)
    const repay = intentFromButton(store, rows[1].webApp)!
    expect(repay.type).toBe("repay")
    expect(BigInt(repay.params.amount as string)).toBe(19_394n * E18)
    expect(intentFromButton(store, rows[2].webApp)!.type).toBe("protect_config")
  })

  it("with protection on but an empty reserve, offers to fund the reserve", async () => {
    const { chain, notifier, engine } = setup()
    chain.setView(ADA, { trove: trove(pct(140), { coll: E18, debt: 71_428n * E18, price: 100_000n * E18 }), guardian: guardian({ reserveBTC: 0n }) })
    await engine.tick()
    expect(notifier.sent[0].text).toContain("reserve is empty")
    expect(notifier.sent[0].opts!.buttons!.flat().some((b) => b.text.includes("Fund reserve"))).toBe(true)
  })

  it("redemption and Recovery Mode alerts also carry protect buttons", async () => {
    const { chain, notifier, engine } = setup()
    chain.setView(ADA, { trove: trove(pct(145), { coll: E18, debt: 68_965n * E18, price: 100_000n * E18 }), kind: "direct", guardianAddress: null, redemption: { ahead: 1_000n * E18, rank: 0, total: 9 } })
    await engine.tick() // first tick records recovery_mode = off
    chain.sysState = sys({ recoveryMode: true, tcr: pct(140) })
    await engine.tick()
    const red = notifier.sent.find((m) => m.text.includes("Redemption exposure"))!
    expect(red.opts!.buttons!.length).toBeGreaterThan(0)
    const rm = notifier.sent.find((m) => m.text.includes("Recovery Mode is ON"))!
    expect(rm.text).toContain("inside the danger zone")
    expect(rm.opts!.buttons!.flat()[0].text).toContain("Add")
  })
})
