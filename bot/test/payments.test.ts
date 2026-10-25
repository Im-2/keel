import { describe, expect, it } from "vitest"
import { E18, pct } from "@keel/shared"
import type { Address } from "viem"
import { Store } from "../src/db"
import { createApi } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus } from "../src/live"
import { resolveRecipient, NOT_ON_KEEL } from "../src/recipient"
import { BlockWatcher } from "../src/watcher"
import { parse } from "../src/nlu"
import { signInitData } from "../src/telegram-auth"
import { ADA, BOB, FakeChain, FakeNotifier, GUARDIAN, TOKEN, config, guardian, harness, trove } from "./helpers"

type Payload = Record<string, unknown>
const buttons = (p: Payload | undefined) =>
  ((p?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>> } | undefined)?.inline_keyboard ?? []).flat()
const text = (p: Payload | undefined) => String(p?.text ?? "")
const intentOf = (h: ReturnType<typeof harness>, p: Payload | undefined) => {
  const url = buttons(p).find((b) => b.web_app)?.web_app?.url
  return url ? h.store.getIntent(url.split("/i/")[1]!) : null
}
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const CAROL_ID = 9

/** ada (42) and Bob (7) have linked wallets; carol (9) started the bot but never linked one. */
function people(store: Store) {
  store.upsertUser(42, "ada", "Ada")
  store.setAddress(42, ADA)
  store.upsertUser(7, "Bob", "Bob")
  store.setAddress(7, BOB)
  store.upsertUser(CAROL_ID, "carol", "Carol")
}

function world() {
  const store = new Store(":memory:")
  people(store)
  const chain = new FakeChain()
  const notifier = new FakeNotifier()
  const live = new LiveBus()
  const completion = createCompletion({ config, store, chain, notifier, live })
  const watcher = new BlockWatcher({ config, store, chain, notifier, live, completion })
  const history = new History({ config, store, chain, explorerApi: null })
  return { store, chain, notifier, live, completion, watcher, history }
}

describe("recipient lookup", () => {
  const store = new Store(":memory:")
  people(store)
  const ada = store.getUser(42)!

  it("finds a linked user case-insensitively, with or without @", () => {
    for (const raw of ["@Bob", "bob", "BOB", "@bOb", "  @bob  "]) {
      const r = resolveRecipient(store, ada, raw)
      expect(r).toMatchObject({ kind: "wallet", address: BOB, label: "@Bob" })
    }
  })
  it("never invents an address: unlinked or unknown names become a claim-link offer", () => {
    expect(resolveRecipient(store, ada, "@carol")).toMatchObject({ kind: "unlinked", username: "carol" })
    expect(resolveRecipient(store, ada, "@nobody_here")).toMatchObject({ kind: "unlinked", username: "nobody_here", user: null })
  })
  it("names known addresses, rejects yourself and junk", () => {
    expect(resolveRecipient(store, ada, BOB)).toMatchObject({ kind: "wallet", label: "@Bob" })
    expect(resolveRecipient(store, ada, ADA).kind).toBe("self")
    expect(resolveRecipient(store, ada, "@ada").kind).toBe("self")
    expect(resolveRecipient(store, ada, "0x1234").kind).toBe("invalid")
    expect(resolveRecipient(store, ada, "two words").kind).toBe("invalid")
  })
})

describe("sending in chat", () => {
  function h() {
    const x = harness()
    people(x.store)
    return x
  }
  it("/send @BOB 5 creates a send intent to Bob's linked wallet and opens review & sign", async () => {
    const x = h()
    await x.say("/send @BOB 5 lunch")
    const i = intentOf(x, x.last()?.payload)!
    expect(i).toMatchObject({ type: "send", params: { to: BOB, amount: (5n * E18).toString(), label: "@Bob", toTg: 7, memo: "lunch" } })
    expect(buttons(x.last()?.payload)[0].text).toContain("Review & sign")
  })
  it("accepts the amount first and a bare username", async () => {
    const x = h()
    await x.say("/send 5 bob")
    expect(intentOf(x, x.last()?.payload)?.params.to).toBe(BOB)
  })
  it("offers a claim link (never a send) to someone without a wallet", async () => {
    const x = h()
    await x.say("/send @carol 5")
    expect(text(x.last()?.payload)).toContain(NOT_ON_KEEL)
    expect(intentOf(x, x.last()?.payload)).toMatchObject({ type: "create_claim", params: { forName: "@carol" } })
  })
  it("natural language: send 5 to @bob → confirm → the same send intent", async () => {
    const x = h()
    await x.say("send 5 to @bob")
    const ok = buttons(x.last()?.payload).find((b) => b.callback_data?.startsWith("nl:ok:"))!.callback_data!
    await x.tap(ok)
    expect(intentOf(x, x.last()?.payload)).toMatchObject({ type: "send", params: { to: BOB } })
  })
  it("refuses to send to yourself", async () => {
    const x = h()
    await x.say("/send @ada 5")
    expect(text(x.last()?.payload)).toContain("your own wallet")
  })
})

describe("confirmation: success only after a successful receipt from the user's wallet", () => {
  const sendIntent = (store: Store, memo = "") => store.createIntent(42, "send", { to: BOB, amount: (5n * E18).toString(), label: "@Bob", toTg: 7, memo })

  it("not mined yet: stays pending, the hash is kept for the watcher to settle", async () => {
    const w = world()
    const i = sendIntent(w.store)
    expect(await w.completion.confirm(i, tx(1))).toEqual({ status: "unconfirmed" })
    expect(w.store.getIntent(i.id)).toMatchObject({ status: "pending", tx_hash: tx(1) })
    expect(w.notifier.sent).toHaveLength(0)
  })
  it("reverted: failed, and the sender is told nothing was sent", async () => {
    const w = world()
    const i = sendIntent(w.store)
    w.chain.receipts.set(tx(2), { ok: false, from: ADA })
    expect(await w.completion.confirm(i, tx(2))).toEqual({ status: "failed", reason: "reverted" })
    expect(w.store.getIntent(i.id)?.status).toBe("failed")
    expect(w.notifier.sent.find((m) => m.to === 42)?.text).toContain("reverted")
    expect(w.notifier.sent.some((m) => m.to === 7)).toBe(false)
  })
  it("someone else's transaction can't complete your intent", async () => {
    const w = world()
    const i = sendIntent(w.store)
    w.chain.receipts.set(tx(3), { ok: true, from: BOB })
    expect(await w.completion.confirm(i, tx(3))).toEqual({ status: "wrong_sender" })
    expect(w.store.getIntent(i.id)?.status).toBe("pending")
  })
  it("success: done, both sides told exactly once, even if confirmed twice", async () => {
    const w = world()
    const i = sendIntent(w.store, "Dinner")
    w.chain.receipts.set(tx(4), { ok: true, from: ADA })
    expect(await w.completion.confirm(i, tx(4))).toEqual({ status: "done" })
    await w.completion.confirm(i, tx(4))
    const toBob = w.notifier.sent.filter((m) => m.to === 7)
    expect(toBob).toHaveLength(1)
    expect(toBob[0].text).toContain("You received <b>5 MUSD</b> from <b>@ada</b>")
    expect(toBob[0].text).toContain("Dinner")
    expect(w.notifier.sent.filter((m) => m.to === 42 && m.text.includes("✅ Sent"))).toHaveLength(1)
  })
  it("API: submitted keeps it pending; done answers 409 until mined, then 200", async () => {
    const w = world()
    const app = createApi({ config, store: w.store, chain: w.chain, notifier: w.notifier, live: w.live, completion: w.completion, history: w.history })
    const init = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, username: "ada", first_name: "Ada" }) }, TOKEN)
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: JSON.stringify(body) })
    const i = sendIntent(w.store)
    expect(await (await post(`/api/intent/${i.id}/complete`, { status: "submitted", txHash: tx(5) })).json()).toMatchObject({ status: "pending" })
    expect((await post(`/api/intent/${i.id}/complete`, { status: "done" })).status).toBe(409)
    w.chain.receipts.set(tx(5), { ok: true, from: ADA })
    expect(await (await post(`/api/intent/${i.id}/complete`, { status: "done" })).json()).toMatchObject({ ok: true, status: "done", txHash: tx(5) })
  })
})

describe("recipient notifications and the outbox", () => {
  it("a recipient Telegram won't let us reach gets it queued, and the sender is told", async () => {
    const w = world()
    w.notifier.unreachable.add(7)
    const i = w.store.createIntent(42, "send", { to: BOB, amount: (5n * E18).toString(), label: "@Bob", toTg: 7 })
    w.chain.receipts.set(tx(6), { ok: true, from: ADA })
    await w.completion.confirm(i, tx(6))
    expect(w.store.hasQueued(7)).toBe(true)
    expect(w.notifier.sent.find((m) => m.to === 42)?.text).toContain("@Bob hasn't started Keel yet; they'll see it when they join.")
  })
  it("queued notices are delivered the next time that person talks to the bot", async () => {
    const x = harness()
    people(x.store)
    x.store.queueMessage(7, "💸 You received <b>5 MUSD</b> from <b>@ada</b>.", {})
    await x.say("/start", { id: 7, username: "Bob", first_name: "Bob" }, { id: 7, type: "private" })
    const toBob = x.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === 7).map((c) => String(c.payload.text))
    expect(toBob.some((t) => t.includes("You received"))).toBe(true)
    expect(x.store.hasQueued(7)).toBe(false)
  })
})

describe("block watcher", () => {
  const transfer = (from: Address, to: Address, amount: bigint, block: bigint, hash: string, logIndex = 0) => ({ from, to, value: amount, tx: hash, block, logIndex })

  it("announces an incoming transfer once, across overlapping scans and restarts, and persists its cursor", async () => {
    const w = world()
    w.chain.head = 100n
    await w.watcher.tick() // first run: start at the head, no backlog
    expect(w.store.getKv("watch_block")).toBe("97")
    w.chain.head = 110n
    w.chain.transfers = [transfer(BOB, ADA, 25n * E18, 105n, tx(10))]
    await w.watcher.tick()
    await w.watcher.tick() // overlap re-reads block 105
    const restarted = new BlockWatcher({ config, store: w.store, chain: w.chain, notifier: w.notifier, live: w.live, completion: w.completion })
    await restarted.tick()
    const toAda = w.notifier.sent.filter((m) => m.to === 42)
    expect(toAda).toHaveLength(1)
    expect(toAda[0].text).toContain("You received <b>25 MUSD</b> from <b>@Bob</b>")
    expect(w.store.getKv("watch_block")).toBe("107")
    expect(w.store.eventsFor(ADA).map((e) => e.kind)).toEqual(["transfer_in"])
    expect(w.store.eventsFor(BOB).map((e) => e.kind)).toEqual(["transfer_out"])
  })
  it("doesn't advance past blocks it failed to read", async () => {
    const w = world()
    w.chain.head = 100n
    await w.watcher.tick()
    w.chain.head = 150n
    w.chain.musdTransfers = async () => {
      throw new Error("rpc down")
    }
    await expect(w.watcher.tick()).rejects.toThrow("rpc down")
    expect(w.store.getKv("watch_block")).toBe("97")
  })
  it("settles a send the app never confirmed, and the recipient still hears once (with the memo)", async () => {
    const w = world()
    w.chain.blockTime = async () => Math.floor(Date.now() / 1000) // the transfer is mined just after the intent
    w.chain.head = 100n
    await w.watcher.tick()
    const i = w.store.createIntent(42, "send", { to: BOB, amount: (7n * E18).toString(), label: "@Bob", toTg: 7, memo: "Taxi" })
    w.chain.head = 120n
    w.chain.transfers = [transfer(ADA, BOB, 7n * E18, 110n, tx(11))]
    await w.watcher.tick()
    expect(w.store.getIntent(i.id)).toMatchObject({ status: "done", tx_hash: tx(11) })
    const toBob = w.notifier.sent.filter((m) => m.to === 7)
    expect(toBob).toHaveLength(1)
    expect(toBob[0].text).toContain("Taxi")
    expect(w.notifier.sent.some((m) => m.to === 42 && m.text.includes("✅ Sent"))).toBe(true)
  })
  it("a send confirmed by the app is not announced again by the watcher", async () => {
    const w = world()
    w.chain.head = 100n
    await w.watcher.tick()
    const i = w.store.createIntent(42, "send", { to: BOB, amount: (5n * E18).toString(), label: "@Bob", toTg: 7 })
    w.chain.receipts.set(tx(12), { ok: true, from: ADA })
    await w.completion.confirm(i, tx(12))
    w.chain.head = 120n
    w.chain.transfers = [transfer(ADA, BOB, 5n * E18, 110n, tx(12))]
    await w.watcher.tick()
    expect(w.notifier.sent.filter((m) => m.to === 7)).toHaveLength(1)
  })
  it("loan proceeds from your own guardian are not 'received'; guardian protections are announced once", async () => {
    const w = world()
    w.chain.setView(ADA, { trove: trove(pct(150)), guardian: guardian() })
    w.chain.head = 100n
    await w.watcher.tick()
    w.chain.head = 120n
    w.chain.transfers = [transfer(GUARDIAN, ADA, 1800n * E18, 110n, tx(13))]
    w.chain.protectedLogs = [{ guardian: GUARDIAN, btcAdded: E18 / 100n, musdRepaid: 0n, icrBefore: pct(128), icrAfter: pct(150), tx: tx(14), block: 111n, logIndex: 0 }]
    await w.watcher.tick()
    await w.watcher.tick()
    const texts = w.notifier.sent.filter((m) => m.to === 42).map((m) => m.text)
    expect(texts.some((t) => t.includes("received"))).toBe(false)
    expect(texts.filter((t) => t.includes("Guardian protected"))).toHaveLength(1)
    expect(w.store.getKv("stat:protections")).toBe("1")
  })
  it("tells a link's creator when it is claimed", async () => {
    const w = world()
    const link = "0x00000000000000000000000000000000000000d4" as Address
    w.chain.head = 100n
    await w.watcher.tick()
    w.chain.head = 120n
    w.chain.payLogs = [
      { kind: "created", link, sender: ADA, amount: 10n * E18, tx: tx(15), block: 105n, logIndex: 1 },
      { kind: "claimed", link, to: BOB, amount: 10n * E18, tx: tx(16), block: 110n, logIndex: 1 },
    ]
    await w.watcher.tick()
    expect(w.notifier.sent.filter((m) => m.to === 42 && m.text.includes("was claimed by <b>@Bob</b>"))).toHaveLength(1)
  })
})

describe("history feed", () => {
  it("the recipient sees the transfer from the chain, the sender sees their send once", async () => {
    const w = world()
    w.chain.head = 100n
    await w.watcher.tick()
    const i = w.store.createIntent(42, "send", { to: BOB, amount: (5n * E18).toString(), label: "@Bob", toTg: 7, memo: "Lunch" })
    w.chain.receipts.set(tx(20), { ok: true, from: ADA })
    await w.completion.confirm(i, tx(20))
    w.chain.head = 120n
    w.chain.transfers = [{ from: ADA, to: BOB, value: 5n * E18, tx: tx(20), block: 110n, logIndex: 0 }]
    await w.watcher.tick()

    const bob = await w.history.feed(w.store.getUser(7)!)
    expect(bob.items).toHaveLength(1)
    expect(bob.items[0]).toMatchObject({ type: "received", amount: (5n * E18).toString(), counterparty: "@ada", tx: tx(20), status: "confirmed" })
    const ada = await w.history.feed(w.store.getUser(42)!)
    expect(ada.items.filter((x) => x.tx === tx(20))).toHaveLength(1)
    expect(ada.items[0]).toMatchObject({ type: "send", counterparty: "@Bob", memo: "Lunch" })
  })
  it("broadcast-but-unconfirmed shows as pending; unsigned intents are not history; pages report more", async () => {
    const w = world()
    w.store.createIntent(42, "send", { to: BOB, amount: "1", label: "@Bob" }) // never signed
    const p = w.store.createIntent(42, "send", { to: BOB, amount: "2", label: "@Bob" })
    w.store.setIntentTx(p.id, tx(21))
    for (let k = 0; k < 12; k++) {
      const d = w.store.createIntent(42, "repay", { amount: String(k + 1) })
      w.store.completeIntent(d.id, "done", tx(100 + k))
    }
    const page = await w.history.feed(w.store.getUser(42)!, { limit: 10 })
    expect(page.more).toBe(true)
    const all = await w.history.feed(w.store.getUser(42)!, { limit: 50 })
    expect(all.items).toHaveLength(13)
    expect(all.items.find((x) => x.tx === tx(21))?.status).toBe("pending")
  })
  it("/history lists items with explorer links and Show more; groups get a private-chat button instead", async () => {
    const x = harness()
    people(x.store)
    for (let k = 0; k < 11; k++) {
      const d = x.store.createIntent(42, "borrow", { amount: (1800n * E18).toString() })
      x.store.completeIntent(d.id, "done", tx(200 + k))
    }
    await x.say("/history")
    const p = x.last()?.payload
    expect(text(p)).toContain("💵 Borrowed")
    expect(text(p)).toContain("/tx/0x")
    expect(buttons(p).some((b) => b.callback_data === "hist:10")).toBe(true)
    await x.tap("hist:10")
    expect(text(x.last()?.payload)).toContain("Earlier activity")
    await x.say("/history", { id: 42, username: "ada", first_name: "Ada" }, { id: -100, type: "group" })
    expect(text(x.last()?.payload)).toContain("private")
    expect(text(x.last()?.payload)).not.toContain("Borrowed")
  })
})

describe("chat understands history and balance questions", () => {
  it.each(["history", "my history", "what is my history", "recent transactions", "show my activity", "what did I do"])("%s → history", (q) => {
    expect(parse(q).intent).toBe("history")
  })
  it.each(["what's my balance", "how much do I have", "balance", "my wallet balance"])("%s → balance", (q) => {
    expect(parse(q).intent).toBe("balance")
  })
  it("/balance shows wallet BTC, MUSD, locked amounts and the total", async () => {
    const x = harness()
    people(x.store)
    x.chain.btc = E18 / 2n // 0.5 BTC at $100,000
    x.chain.musd.set(ADA.toLowerCase(), 250n * E18)
    x.chain.setView(ADA, { trove: trove(pct(200), { coll: E18 / 10n, debt: 5000n * E18 }), guardian: guardian({ reserveBTC: E18 / 100n }) })
    await x.say("/balance")
    const t = text(x.last()?.payload)
    expect(t).toContain("Wallet $50,250.00")
    expect(t).toContain("0.5 BTC")
    expect(t).toContain("250 MUSD")
    expect(t).toContain("In your loan")
    expect(t).toContain("In protection reserve")
    expect(t).toContain("Total $61,250.00") // 50,250 wallet + 10,000 loan + 1,000 reserve
  })
})
