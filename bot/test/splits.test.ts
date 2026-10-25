import { describe, expect, it } from "vitest"
import { CENT, E18 } from "@keel/shared"
import type { Address } from "viem"
import { Store } from "../src/db"
import { createApi } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus } from "../src/live"
import { BlockWatcher } from "../src/watcher"
import { Splits, parseSplitArgs, parseDue } from "../src/splits"
import { parse } from "../src/nlu"
import { signInitData } from "../src/telegram-auth"
import { ADA, BOB, FakeChain, FakeNotifier, TOKEN, config, harness } from "./helpers"

const CHIDI = "0x00000000000000000000000000000000000000c1" as Address
const musd = (n: number) => (BigInt(Math.round(n * 100)) * CENT).toString()
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

/**
 * ada (42) splits bills. bob (7) and chidi (8) have linked wallets; dan (9) started the bot but has no wallet;
 * eve was never on Keel at all.
 */
function world() {
  const store = new Store(":memory:")
  store.upsertUser(42, "ada", "Ada")
  store.setAddress(42, ADA)
  store.upsertUser(7, "bob", "Bob")
  store.setAddress(7, BOB)
  store.upsertUser(8, "chidi", "Chidi")
  store.setAddress(8, CHIDI)
  store.upsertUser(9, "dan", "Dan")
  const chain = new FakeChain()
  const notifier = new FakeNotifier()
  const live = new LiveBus()
  const splits = new Splits({ config, store, notifier, live })
  const posts: Array<{ chatId: number; html: string; markup: any }> = []
  const edits: Array<{ chatId: number; messageId: number; html: string; markup: any }> = []
  splits.attach({
    post: async (chatId, html, markup) => (posts.push({ chatId, html, markup }), 500 + posts.length),
    edit: async (chatId, messageId, html, markup) => void edits.push({ chatId, messageId, html, markup }),
  })
  const completion = createCompletion({ config, store, chain, notifier, live, splits })
  const watcher = new BlockWatcher({ config, store, chain, notifier, live, completion, splits })
  const history = new History({ config, store, chain, explorerApi: null })
  const app = createApi({ config, store, chain, notifier, live, completion, history, splits })
  const init = (id: number, username: string) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username, first_name: username }) }, TOKEN)
  const as = (id: number, username: string) => async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init(id, username) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as any }
  }
  const lastCard = () => (edits.length ? edits.at(-1)!.html : posts.at(-1)!.html)
  return { store, chain, notifier, live, splits, completion, watcher, posts, edits, lastCard, ada: store.getUser(42)!, asAda: as(42, "ada"), asBob: as(7, "bob"), asChidi: as(8, "chidi"), asDan: as(9, "dan") }
}

describe("parsing /split", () => {
  it("names, amounts, percentages, title, due date and 'not me'", () => {
    const now = new Date(Date.UTC(2026, 9, 25, 12)) // a Sunday
    expect(parseSplitArgs("100 @ada @bob @chidi dinner", now)).toMatchObject({ total: BigInt(musd(100)), people: [{ raw: "@ada" }, { raw: "@bob" }, { raw: "@chidi" }], title: "dinner", includeMe: true, dueAt: null })
    expect(parseSplitArgs("90 @ada:50 @bob=40 taxi notme", now)).toMatchObject({ people: [{ raw: "@ada", amount: BigInt(musd(50)) }, { raw: "@bob", amount: BigInt(musd(40)) }], title: "taxi", includeMe: false })
    expect(parseSplitArgs("120 @ada 50% @bob 30% rent", now).people).toEqual([{ raw: "@ada", bps: 5000 }, { raw: "@bob", bps: 3000 }])
    expect(parseSplitArgs("$60 with @ada, @bob for pizza without me due friday", now)).toMatchObject({ total: BigInt(musd(60)), includeMe: false, title: "pizza", dueAt: parseDue("friday", now)!.at })
    expect(parseSplitArgs(`50 ${CHIDI}`, now).people).toEqual([{ raw: CHIDI }])
    expect(() => parseSplitArgs("lots @ada", now)).toThrow()
  })
  it("natural language: names without @, 'everyone', 'without me'", () => {
    expect(parse("split 90 with ada, bob and chidi").slots.usernames).toEqual(["ada", "bob", "chidi"])
    expect(parse("split 90 with ada, bob and chidi for dinner").slots).toMatchObject({ usernames: ["ada", "bob", "chidi"], memo: "dinner" })
    expect(parse("split 120 between everyone").slots.everyone).toBe(true)
    expect(parse("split 60 with @bob without me").slots).toMatchObject({ usernames: ["bob"], excludeMe: true })
  })
})

describe("a 3-person split (ada + bob + chidi + eve-not-on-Keel)", () => {
  it("asks everyone it can reach, posts a card with exact shares, and settles from payments", async () => {
    const w = world()
    const r = await w.splits.create(w.ada, { total: BigInt(musd(100)), title: "Dinner", people: [{ raw: "@bob" }, { raw: "chidi" }, { raw: "@eve_x" }], includeMe: false, chatId: -100 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const shares = w.store.sharesOf(r.value.split.id)
    expect(shares.map((s) => s.amount)).toEqual([musd(33.34), musd(33.33), musd(33.33)])
    expect(r.value.notReached).toEqual(["@eve_x"])
    // bob and chidi get a DM with a Pay button that opens the Mini App on their share
    const toBob = w.notifier.sent.find((m) => m.to === 7)!
    expect(toBob.text).toContain("Your share: <b>33.34 MUSD</b>")
    expect(JSON.stringify(toBob.opts)).toContain(`/#/split/${r.value.split.id}/0`)
    // the group card: every share, and a direct Pay link per person
    const card = w.posts[0]
    expect(card.chatId).toBe(-100)
    expect(card.html).toContain("⏳ @bob · 33.34 MUSD")
    expect(card.html).toContain("⏳ @eve_x · 33.33 MUSD")
    const urls = card.markup.inline_keyboard.flat().map((b: any) => b.url).filter(Boolean)
    expect(urls).toContain(`https://t.me/KeelTestBot?start=split_${r.value.split.id}_2`)

    // bob pays in the Mini App
    const p = await w.asBob("POST", `/api/split/${r.value.split.id}/pay`, { idx: 0 })
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ type: "pay_split", params: { to: ADA.toLowerCase(), amount: musd(33.34), memo: "Dinner" } })
    w.chain.receipts.set(tx(1), { ok: true, from: BOB })
    await w.completion.confirm(w.store.getIntent(p.body.id)!, tx(1))
    expect(w.notifier.sent.filter((m) => m.to === 42 && m.text.includes("<b>@bob</b> paid <b>33.34 MUSD</b> for Dinner"))).toHaveLength(1)
    expect(w.lastCard()).toContain("✅ @bob · 33.34 MUSD")
    expect(w.lastCard()).toContain("Collected <b>33.34 MUSD</b>")

    // chidi pays straight from a wallet app (no intent): the watcher matches the transfer on-chain
    w.chain.head = 100n
    await w.watcher.tick()
    w.chain.head = 130n
    w.chain.transfers = [{ from: CHIDI, to: ADA, value: BigInt(musd(33.33)), tx: tx(2), block: 110n, logIndex: 0 }]
    await w.watcher.tick()
    await w.watcher.tick() // overlapping re-scan: counted once
    expect(w.store.sharesOf(r.value.split.id)[1]).toMatchObject({ status: "paid", tx_hash: tx(2) })
    const toAda = w.notifier.sent.filter((m) => m.to === 42).map((m) => m.text)
    expect(toAda.filter((t) => t.includes("<b>@chidi</b> paid"))).toHaveLength(1)
    expect(toAda.some((t) => t.includes("You received"))).toBe(false) // the split notice replaces the generic one

    // eve isn't on Keel: reminders give her link to share instead
    const rem = await w.splits.remind(r.value.split.id, 42)
    expect(rem.ok && rem.value.links.map((l) => l.label)).toEqual(["@eve_x"])
    expect(w.store.getSplit(r.value.split.id)!.status).toBe("open")
  })

  it("settles when the last share is paid, and tells the requester", async () => {
    const w = world()
    const r = await w.splits.create(w.ada, { total: BigInt(musd(60)), title: "Pizza", people: [{ raw: "@bob" }], includeMe: true, chatId: 42 })
    if (!r.ok) throw new Error(r.error)
    expect(w.store.getSplit(r.value.split.id)!.mine).toBe(musd(30))
    expect(await w.splits.matchTransfer({ from: BOB, to: ADA, value: BigInt(musd(30)), tx: tx(3) })).toBe(true)
    expect(w.store.getSplit(r.value.split.id)!.status).toBe("settled")
    expect(w.notifier.sent.some((m) => m.to === 42 && m.text.includes("<b>Pizza</b> is settled"))).toBe(true)
    expect(w.lastCard()).toContain("Settled")
  })
})

describe("a 2-person split with someone who has no wallet or hasn't started the bot", () => {
  it("dan (no wallet) is asked, links a wallet, then pays; an unreachable participant is queued", async () => {
    const w = world()
    w.notifier.unreachable.add(8) // chidi never pressed Start
    const r = await w.splits.create(w.ada, { total: BigInt(musd(40)), title: "Taxi", people: [{ raw: "@dan" }, { raw: "@chidi" }], includeMe: false, chatId: 42 })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.notReached).toEqual(["@chidi"])
    expect(w.store.hasQueued(8)).toBe(true)
    expect(w.notifier.sent.some((m) => m.to === 42 && m.text.includes("@chidi hasn't started Keel yet"))).toBe(true)
    // dan opens his link: he needs a wallet first
    expect((await w.asDan("POST", `/api/split/${r.value.split.id}/pay`, {})).body.code).toBe("need_wallet")
    w.store.setAddress(9, "0x00000000000000000000000000000000000000d9")
    const p = await w.asDan("POST", `/api/split/${r.value.split.id}/pay`, {})
    expect(p.body.params).toMatchObject({ splitId: r.value.split.id, idx: 0, amount: musd(20) })
  })
})

describe("guard rails", () => {
  it("own split, someone else's share, already paid, double payment", async () => {
    const w = world()
    const r = await w.splits.create(w.ada, { total: BigInt(musd(60)), title: "Lunch", people: [{ raw: "@bob" }, { raw: "@chidi" }], includeMe: false, chatId: -1 })
    if (!r.ok) throw new Error(r.error)
    const id = r.value.split.id
    expect((await w.asAda("POST", `/api/split/${id}/pay`, {})).body.error).toContain("your own split")
    expect((await w.asBob("POST", `/api/split/${id}/pay`, { idx: 1 })).body.error).toContain("This share is for @chidi")
    expect((await w.asDan("GET", `/api/split/${id}`)).status).toBe(404) // not a participant: can't see it
    const first = await w.asBob("POST", `/api/split/${id}/pay`, {})
    const second = await w.asBob("POST", `/api/split/${id}/pay`, {})
    w.chain.receipts.set(tx(4), { ok: true, from: BOB })
    w.chain.receipts.set(tx(5), { ok: true, from: BOB })
    w.store.setIntentTx(second.body.id, tx(5)) // both tabs broadcast
    await w.completion.confirm(w.store.getIntent(first.body.id)!, tx(4))
    expect((await w.asBob("POST", `/api/split/${id}/pay`, {})).body.error).toContain("already paid")
    await w.completion.confirm(w.store.getIntent(second.body.id)!, tx(5)) // paid twice from two tabs
    expect(w.notifier.sent.some((m) => m.to === 7 && m.text.includes("was already marked paid"))).toBe(true)
    expect(w.store.sharesOf(id)[0].tx_hash).toBe(tx(4))
    expect(w.notifier.sent.filter((m) => m.to === 42 && m.text.includes("@bob</b> paid"))).toHaveLength(1)
  })

  it("only the requester can remind or cancel; reminders are rate-limited", async () => {
    const w = world()
    const r = await w.splits.create(w.ada, { total: BigInt(musd(30)), title: "Coffee", people: [{ raw: "@bob" }], includeMe: true, chatId: 42 })
    if (!r.ok) throw new Error(r.error)
    expect((await w.splits.remind(r.value.split.id, 7)).ok).toBe(false)
    const a = await w.splits.remind(r.value.split.id, 42)
    const b = await w.splits.remind(r.value.split.id, 42)
    expect(a.ok && a.value.reminded).toEqual(["@bob"])
    expect(b.ok && b.value.skipped).toEqual(["@bob"])
    expect((await w.splits.cancel(r.value.split.id, 7)).ok).toBe(false)
    expect((await w.splits.cancel(r.value.split.id, 42)).ok).toBe(true)
    expect((await w.asBob("POST", `/api/split/${r.value.split.id}/pay`, {})).body.code).toBe("gone")
  })

  it("one automatic reminder after 24h, only to people the bot can reach", async () => {
    const w = world()
    w.notifier.unreachable.add(8)
    const r = await w.splits.create(w.ada, { total: BigInt(musd(30)), title: "Drinks", people: [{ raw: "@bob" }, { raw: "@chidi" }], includeMe: false, chatId: 42 })
    if (!r.ok) throw new Error(r.error)
    const later = Math.floor(Date.now() / 1000) + 25 * 3600
    expect(await w.splits.autoRemind(later - 2 * 3600)).toBe(0) // not 24h yet
    expect(await w.splits.autoRemind(later)).toBe(1)
    expect(await w.splits.autoRemind(later + 3600)).toBe(0) // only once
    expect(w.notifier.sent.filter((m) => m.to === 7 && m.text.includes("Still open"))).toHaveLength(1)
  })

  it("group split: people join with I'm in, the requester locks it", async () => {
    const w = world()
    const r = await w.splits.create(w.ada, { total: BigInt(musd(90)), title: "Brunch", people: [], includeMe: true, chatId: -300 })
    if (!r.ok) throw new Error(r.error)
    const id = r.value.split.id
    expect(w.posts[0].html).toContain("I'm in")
    expect((await w.splits.join(id, w.store.getUser(7)!)).ok).toBe(true)
    expect((await w.splits.join(id, w.store.getUser(7)!)).ok).toBe(false)
    expect((await w.splits.join(id, w.store.getUser(8)!)).ok).toBe(true)
    expect((await w.splits.lock(id, 7)).ok).toBe(false)
    expect((await w.splits.lock(id, 42)).ok).toBe(true)
    expect(w.store.sharesOf(id).map((s) => s.amount)).toEqual([musd(30), musd(30)])
    expect(w.store.getSplit(id)!.mine).toBe(musd(30))
    expect(w.lastCard()).toContain("⏳ @bob · 30 MUSD")
  })
})

describe("in chat", () => {
  it("/split in a DM posts the card there with 📤 share buttons for each person", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say("/split 100 @bob @carol_x @dave_x dinner")
    const card = h.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === 42).find((c) => String(c.payload.text).includes("🧾"))!
    expect(String(card.payload.text)).toContain("⏳ @bob · 25 MUSD")
    const kb = JSON.stringify(card.payload.reply_markup)
    expect(kb).toContain("t.me/share/url")
    expect(kb).toContain("split:remind:")
    // bob is asked in his own chat, with a button straight to the pay screen
    const toBob = h.calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === 7)!
    expect(JSON.stringify(toBob.payload.reply_markup)).toContain("/#/split/")
  })
})

void E18
