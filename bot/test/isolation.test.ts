import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { E18, pct } from "@keel/shared"
import type { Address } from "viem"
import { Store } from "../src/db"
import { createApi, bindMessage } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus } from "../src/live"
import { signInitData } from "../src/telegram-auth"
import { FakeChain, FakeNotifier, GUARDIAN, TOKEN, config, guardian, trove } from "./helpers"

/**
 * Regression suite for per-user isolation. User A has a loan, a guardian, MUSD, intents and on-chain history;
 * user B has a fresh wallet and nothing else. B must never see any of A's numbers, on any endpoint or stream.
 */
const A_ID = 42
const B_ID = 77
const aKey = privateKeyToAccount(generatePrivateKey())
const A_WALLET = aKey.address
const B_WALLET = "0x00000000000000000000000000000000000000b7" as Address
const A_TX = "0x" + "a1".repeat(32)

function setup() {
  const store = new Store(":memory:")
  store.upsertUser(A_ID, "alice", "Alice")
  store.setAddress(A_ID, A_WALLET)
  store.upsertUser(B_ID, "bruno", "Bruno")
  store.setAddress(B_ID, B_WALLET)
  const chain = new FakeChain()
  chain.setView(A_WALLET, { trove: trove(pct(160), { coll: 398n * E18 / 10_000n, debt: 20018n * E18 / 10n }), guardian: guardian({ reserveBTC: 5n * E18 / 1000n }) })
  chain.musd.set(A_WALLET.toLowerCase(), 1234n * E18)
  const borrow = store.createIntent(A_ID, "borrow", { amount: (1800n * E18).toString(), targetIcr: pct(160).toString() })
  store.completeIntent(borrow.id, "done", A_TX)
  const pending = store.createIntent(A_ID, "send", { to: B_WALLET, amount: (5n * E18).toString(), label: "@bruno" })
  store.recordEvent({ tx: "0x" + "a2".repeat(32), log_index: 0, wallet: A_WALLET, kind: "transfer_in", counterparty: GUARDIAN, amount: (1800n * E18).toString(), block: 50, at: 1_800_000_000, data: {} })
  const notifier = new FakeNotifier()
  const live = new LiveBus()
  const completion = createCompletion({ config, store, chain, notifier, live })
  const history = new History({ config, store, chain, explorerApi: null })
  const app = createApi({ config, store, chain, notifier, live, completion, history })
  const init = (id: number, username: string) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username, first_name: username }) }, TOKEN)
  const as = (id: number, username: string) => (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init(id, username), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { store, chain, notifier, live, app, borrow, pending, asA: as(A_ID, "alice"), asB: as(B_ID, "bruno") }
}

/** Every value that identifies A's account or position. None may appear in anything B receives. */
const A_SECRETS = [A_WALLET.toLowerCase(), GUARDIAN.toLowerCase(), A_TX, "a2a2a2", (1234n * E18).toString(), (20018n * E18 / 10n).toString(), (398n * E18 / 10_000n).toString(), "alice"]
const leaks = (body: string) => A_SECRETS.filter((s) => body.toLowerCase().includes(s.toLowerCase()))

describe("per-user isolation: B never sees A's data", () => {
  it("every user-data endpoint answers B with B's own (empty) data", async () => {
    const s = setup()
    for (const [method, path] of [["GET", "/api/position"], ["GET", "/api/activity"], ["GET", "/api/me"], ["GET", "/api/activity?limit=50&offset=0"]] as const) {
      const res = await s.asB(method, path)
      expect(res.status, path).toBe(200)
      const body = await res.text()
      expect(leaks(body), `${path} leaked`).toEqual([])
    }
    const pos = await (await s.asB("GET", "/api/position")).json() as any
    expect(pos).toMatchObject({ linked: true, address: B_WALLET, trove: null, guardian: null, wallet: { musd: "0" } })
    expect((await (await s.asB("GET", "/api/activity")).json() as any).items).toEqual([])
  })

  it("client-supplied ids, addresses and headers are ignored: identity comes only from initData", async () => {
    const s = setup()
    const tries = [
      await s.asB("GET", `/api/position?address=${A_WALLET}&tgId=${A_ID}`),
      await s.asB("GET", `/api/activity?wallet=${A_WALLET}&user=${A_ID}`, undefined, { "x-user-id": String(A_ID), "x-wallet": A_WALLET }),
    ]
    for (const r of tries) expect(leaks(await r.text())).toEqual([])
  })

  it("A's intents are invisible and untouchable for B", async () => {
    const s = setup()
    expect((await s.asB("GET", `/api/intent/${s.borrow.id}`)).status).toBe(404)
    expect((await s.asB("GET", `/api/intent/${s.pending.id}`)).status).toBe(404)
    expect((await s.asB("POST", `/api/intent/${s.pending.id}/complete`, { status: "submitted", txHash: "0x" + "bb".repeat(32) })).status).toBe(404)
    expect(s.store.getIntent(s.pending.id)?.tx_hash).toBeNull()
  })

  it("requests without valid Telegram auth get nothing", async () => {
    const s = setup()
    for (const path of ["/api/position", "/api/activity", "/api/me", `/api/intent/${s.borrow.id}`]) {
      expect((await s.app.request(path)).status, path).toBe(401)
      const forged = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: A_ID }) }, "999:wrong-token")
      expect((await s.app.request(path, { headers: { "x-telegram-init-data": forged } })).status, path).toBe(401)
    }
  })

  it("user responses are marked private and never cached", async () => {
    const s = setup()
    for (const path of ["/api/position", "/api/activity", "/api/me", "/api/config"]) {
      const res = await s.asB("GET", path)
      expect(res.headers.get("cache-control"), path).toBe("private, no-store")
    }
  })

  it("the live stream only carries B's own events", async () => {
    const s = setup()
    const { token } = await (await s.asB("POST", "/api/live/token", {})).json() as any
    const res = await s.app.request(`/api/live?t=${token}`)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("cache-control")).toContain("no-store")
    const reader = res.body!.getReader()
    const got: string[] = []
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        got.push(new TextDecoder().decode(value))
      }
    })()
    await new Promise((r) => setTimeout(r, 20))
    s.live.publish(A_ID, { reason: "received", tx: A_TX, toast: "Received 5 MUSD from @alice" })
    s.live.publish(B_ID, { reason: "balance" })
    await new Promise((r) => setTimeout(r, 20))
    await reader.cancel()
    await pump.catch(() => undefined)
    const all = got.join("")
    expect(all).toContain('"reason":"hello"')
    expect(all).toContain('"reason":"balance"')
    expect(leaks(all)).toEqual([])
    expect((await s.app.request("/api/live?t=not-a-token")).status).toBe(401)
  })

  it("B's history never includes A's ledger rows or intents", async () => {
    const s = setup()
    const hist = new History({ config, store: s.store, chain: s.chain, explorerApi: null })
    const feed = await hist.feed(s.store.getUser(B_ID)!)
    expect(feed.items).toEqual([])
    expect((await hist.feed(s.store.getUser(A_ID)!)).items.length).toBeGreaterThan(0)
  })
})

describe("wallet binding can't be hijacked, and a wallet has one owner", () => {
  async function bindAs(s: ReturnType<typeof setup>, who: "A" | "B", signer: ReturnType<typeof privateKeyToAccount>, extra: Record<string, unknown> = {}) {
    const req = who === "A" ? s.asA : s.asB
    const id = who === "A" ? A_ID : B_ID
    const { nonce } = await (await req("POST", "/api/nonce", {})).json() as any
    const signature = await signer.signMessage({ message: bindMessage(id, nonce) })
    return { nonce, res: await req("POST", "/api/bind", { nonce, address: signer.address, signature, ...extra }) }
  }

  it("a signature from a different wallet, or someone else's nonce, is rejected", async () => {
    const s = setup()
    const other = privateKeyToAccount(generatePrivateKey())
    const { nonce } = await (await s.asB("POST", "/api/nonce", {})).json() as any
    const sig = await other.signMessage({ message: bindMessage(B_ID, nonce) })
    expect((await s.asB("POST", "/api/bind", { nonce, address: A_WALLET, signature: sig })).status).toBe(400)
    // A's nonce can't be spent by B
    const { nonce: aNonce } = await (await s.asA("POST", "/api/nonce", {})).json() as any
    const aSig = await aKey.signMessage({ message: bindMessage(B_ID, aNonce) })
    expect((await s.asB("POST", "/api/bind", { nonce: aNonce, address: A_WALLET, signature: aSig })).status).toBe(400)
    expect(s.store.getUser(A_ID)?.address).toBe(A_WALLET)
  })

  it("a wallet linked to A: B is warned (nothing about A revealed) and must sign again to take it over; A is told", async () => {
    const s = setup()
    const first = await bindAs(s, "B", aKey)
    expect(first.res.status).toBe(409)
    const body = await first.res.text()
    expect(body).toContain("wallet_in_use")
    expect(body.toLowerCase()).not.toContain("alice")
    expect(body).not.toContain(String(A_ID))
    expect(s.store.getUser(A_ID)?.address).toBe(A_WALLET)
    expect(s.store.getUser(B_ID)?.address).toBe(B_WALLET)
    // the first signature's nonce is spent: replaying it with takeover fails
    const replay = await s.asB("POST", "/api/bind", { nonce: first.nonce, address: A_WALLET, signature: await aKey.signMessage({ message: bindMessage(B_ID, first.nonce) }), takeover: true })
    expect(replay.status).toBe(400)

    const second = await bindAs(s, "B", aKey, { takeover: true })
    expect(second.res.status).toBe(200)
    expect(s.store.getUser(B_ID)?.address).toBe(A_WALLET)
    expect(s.store.getUser(A_ID)?.address).toBeNull()
    expect(s.store.getIntent(s.pending.id)).toBeNull() // A's unsigned requests went with the disconnect
    expect(s.notifier.sent.some((m) => m.to === A_ID && m.text.includes("linked to another Telegram account"))).toBe(true)
    // and B now sees the wallet's on-chain position, but none of A's Keel intents
    const act = await (await s.asB("GET", "/api/activity")).json() as any
    expect(act.items.some((i: { id: string }) => i.id === s.borrow.id)).toBe(false)
  })
})
