import { describe, expect, it } from "vitest"
import { E18, pct } from "@keel/shared"
import { ADA, BOB, guardian, harness, trove } from "./helpers"

type Payload = Record<string, unknown>
const buttons = (p: Payload | undefined) =>
  ((p?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>> } | undefined)?.inline_keyboard ?? []).flat()
const text = (p: Payload | undefined) => String(p?.text ?? "")
const cb = (p: Payload | undefined, prefix: string) => buttons(p).find((b) => b.callback_data?.startsWith(prefix))?.callback_data
const intentOf = (h: ReturnType<typeof harness>, p: Payload | undefined) => {
  const url = buttons(p).find((b) => b.web_app)?.web_app?.url
  return url ? h.store.getIntent(url.split("/i/")[1]!) : null
}
const intentCount = (h: ReturnType<typeof harness>) => (h.store.db.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number }).n

function linked() {
  const h = harness()
  h.store.upsertUser(42, "ada", "Ada")
  h.store.setAddress(42, ADA)
  return h
}

describe("chat: money actions are echoed back before any intent exists", () => {
  it("borrow 2000 at 180% → echo → Yes → the normal quote card with Review & sign", async () => {
    const h = linked()
    await h.say("I want to borrow 2000 at 180%")
    const echo = h.last()!.payload
    expect(text(echo)).toContain("Borrow <b>2,000 MUSD</b> at a <b>180%</b>")
    expect(intentCount(h)).toBe(0)
    await h.tap(cb(echo, "nl:ok:")!)
    const card = h.last()!.payload
    expect(text(card)).toContain("Liquidation at")
    expect(text(card)).toContain("Fee")
    const i = intentOf(h, card)!
    expect(i.type).toBe("borrow")
    expect(i.params).toEqual({ amount: (2000n * E18).toString(), targetIcr: pct(180).toString() })
  })

  it("send 20 to @ada for lunch → names the recipient and memo, then a send intent to her address", async () => {
    const h = linked()
    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say("send 20 to @bob for lunch")
    const echo = h.last()!.payload
    expect(text(echo)).toContain("Send <b>20 MUSD</b> to <b>@bob</b> for “lunch”")
    await h.tap(cb(echo, "nl:ok:")!)
    const i = intentOf(h, h.last()!.payload)!
    expect(i.type).toBe("send")
    expect(i.params.to).toBe(BOB)
    expect(i.params.memo).toBe("lunch")
  })

  it("Cancel creates nothing, and a confirmation can only be used once", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180)) }) // 40,000 MUSD debt: room to repay
    await h.say("repay 100")
    const echo = h.last()!.payload
    await h.tap(cb(echo, "nl:no:")!)
    expect(text(h.last()!.payload)).toContain("cancelled")
    expect(intentCount(h)).toBe(0)
    await h.say("repay 100")
    const ok = cb(h.last()!.payload, "nl:ok:")!
    await h.tap(ok)
    await h.tap(ok)
    expect(intentCount(h)).toBe(1)
    expect(text(h.last()!.payload)).toContain("expired")
  })

  it("someone else cannot press your confirm button", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180)) })
    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say("repay 100")
    await h.tap(cb(h.last()!.payload, "nl:ok:")!, { id: 7, username: "bob", first_name: "Bob" })
    expect(intentCount(h)).toBe(0)
  })

  it("repay everything closes the loan (Mezo never lets an open loan go under the minimum)", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180), { debt: 2001n * E18 }) })
    await h.say("repay everything")
    expect(text(h.last()!.payload)).toContain("close your loan")
    await h.tap(cb(h.last()!.payload, "nl:ok:")!)
    expect(text(h.last()!.payload)).toContain("1,801 MUSD")
    expect(intentOf(h, h.last()!.payload)!.type).toBe("close")
  })

  it("a partial repay that would break the 1,800 MUSD minimum is refused with the real maximum", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180), { debt: 2500n * E18 }) })
    await h.say("/repay 600")
    expect(text(h.last()!.payload)).toContain("at most <b>500 MUSD</b>")
    expect(intentCount(h)).toBe(0)
    await h.say("/repay 500")
    expect(intentOf(h, h.last()!.payload)!.type).toBe("repay")
  })
})

describe("chat: clarifying questions", () => {
  it("asks for a missing amount and accepts a typed reply", async () => {
    const h = linked()
    await h.say("I want to borrow")
    expect(text(h.last()!.payload)).toContain("How much MUSD")
    expect(buttons(h.last()!.payload).map((b) => b.text)).toContain("2,500")
    await h.say("2500")
    expect(text(h.last()!.payload)).toContain("Borrow <b>2,500 MUSD</b>")
  })

  it("asks for a missing amount and accepts a quick-reply button", async () => {
    const h = linked()
    await h.say("add collateral")
    const q = h.last()!.payload
    await h.tap(buttons(q).find((b) => b.text === "0.01 BTC")!.callback_data!)
    expect(text(h.last()!.payload)).toContain("Add <b>0.01 BTC</b>")
  })

  it("asks who to pay, then takes '@bob'", async () => {
    const h = linked()
    await h.say("send 15")
    expect(text(h.last()!.payload)).toContain("Who should get")
    await h.say("@bob")
    expect(text(h.last()!.payload)).toContain("to <b>@bob</b>")
  })

  it("asks for protection levels with presets", async () => {
    const h = linked()
    await h.say("turn on protection")
    const q = h.last()!.payload
    await h.tap(buttons(q).find((b) => b.text.startsWith("170%"))!.callback_data!)
    expect(text(h.last()!.payload)).toContain("act below <b>170%</b> and restore you to <b>180%</b>")
  })

  it("'protect me at 170' fills the target for you", async () => {
    const h = linked()
    await h.say("protect me at 170")
    expect(text(h.last()!.payload)).toContain("act below <b>170%</b> and restore you to <b>190%</b>")
  })

  it("does not borrow BTC by mistake: asks again in MUSD", async () => {
    const h = linked()
    await h.say("borrow 0.01 btc")
    expect(text(h.last()!.payload)).toContain("MUSD dollars, not BTC")
  })
})

describe("chat: answers from real data", () => {
  it("how safe is my loan", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180)), guardian: guardian() })
    await h.say("how safe is my loan?")
    const t = text(h.last()!.payload)
    expect(t).toContain("180%")
    expect(t).toContain("$44,000")
    expect(t).toContain("Protection is <b>on</b>")
    expect(intentCount(h)).toBe(0)
    expect(buttons(h.last()!.payload).length).toBeGreaterThan(1) // quick replies
  })

  it("when would I get liquidated", async () => {
    const h = linked()
    h.chain.setView(ADA, { trove: trove(pct(180)) })
    await h.say("when would I get liquidated")
    expect(text(h.last()!.payload)).toContain("falls to <b>$44,000</b>")
  })

  it("what if BTC drops 50%: protection triggers and uses the reserve", async () => {
    const h = linked()
    // 1 BTC collateral, 40k debt at 100k: -50% -> 125%, below a 130% trigger
    h.chain.setView(ADA, { trove: trove(pct(250), { coll: E18, debt: 40_000n * E18 }), guardian: guardian({ reserveBTC: E18 / 10n }) })
    await h.say("what if btc drops 50%")
    const t = text(h.last()!.payload)
    expect(t).toContain("$50,000")
    expect(t).toContain("→ <b>125%</b>")
    expect(t).toContain("Protection would trigger")
    expect(t).toContain("would not be liquidated")
  })

  it("what if, without a loan, says so instead of inventing numbers", async () => {
    const h = linked()
    await h.say("what if bitcoin falls to 60k")
    expect(text(h.last()!.payload)).toContain("don't have an open loan")
  })

  it("fees come from the live system state", async () => {
    const h = linked()
    await h.say("what are the fees")
    const t = text(h.last()!.payload)
    expect(t).toContain("0.1%")
    expect(t).toContain("1.00% a year")
  })
})

describe("chat: unknown, typos, settings, groups", () => {
  it("unknown text gets examples and main buttons", async () => {
    const h = linked()
    await h.say("purple monkey dishwasher")
    expect(text(h.last()!.payload)).toContain("I didn't get that")
    expect(text(h.last()!.payload)).toContain("how safe is my loan?")
    expect(buttons(h.last()!.payload).map((b) => b.text)).toContain("💵 Borrow")
  })

  it("a typo asks 'Did you mean…?' and continues with the choice", async () => {
    const h = linked()
    await h.say("borow 2000")
    const q = h.last()!.payload
    expect(text(q)).toContain("Did you mean")
    await h.tap(buttons(q).find((b) => b.text === "Borrow MUSD")!.callback_data!)
    expect(text(h.last()!.payload)).toContain("Borrow <b>2,000 MUSD</b>")
  })

  it("mute alerts changes the setting directly", async () => {
    const h = linked()
    await h.say("mute alerts")
    expect(h.store.getUser(42)!.settings.muted).toBe(true)
    await h.say("unmute")
    expect(h.store.getUser(42)!.settings.muted).toBe(false)
  })

  it("in a group, only answers when mentioned", async () => {
    const h = linked()
    const group = { id: -5, type: "supergroup" }
    const before = h.calls.length
    await h.say("split 90 with @bob and @carol", { id: 42, username: "ada", first_name: "Ada" }, group)
    expect(h.calls.length).toBe(before)
    await h.say("@KeelTestBot split 90 with @bob and @carol for dinner", { id: 42, username: "ada", first_name: "Ada" }, group)
    const echo = h.last()!.payload
    expect(text(echo)).toContain("with <b>@bob</b>, <b>@carol</b> and you (3 ways)")
    await h.tap(cb(echo, "nl:ok:")!, { id: 42, username: "ada", first_name: "Ada" }, group)
    expect(text(h.last()!.payload)).toContain("⏳ @bob")
  })

  it("slash commands still win over the chat layer", async () => {
    const h = linked()
    await h.say("/borrow 1800 200")
    expect(text(h.last()!.payload)).toContain("Borrow 1,800")
    expect(intentCount(h)).toBe(1)
  })

  it("needs a linked wallet for money actions, but still answers general questions", async () => {
    const h = harness()
    await h.say("what is musd")
    expect(text(h.last()!.payload)).toContain("Mezo's dollar stablecoin")
    await h.say("borrow 2000")
    await h.tap(cb(h.last()!.payload, "nl:ok:")!)
    expect(text(h.last()!.payload)).toContain("Connect your wallet first")
  })
})
