import { describe, expect, it } from "vitest"
import { E18, pct } from "@keel/shared"
import { ADA, BOB, GUARDIAN, guardian, harness, trove } from "./helpers"

const buttonUrls = (p: Record<string, unknown> | undefined) =>
  ((p?.reply_markup as { inline_keyboard: Array<Array<{ url?: string; web_app?: { url: string } }>> } | undefined)?.inline_keyboard ?? []).flat().map((b) => b.web_app?.url ?? b.url)

describe("bot commands", () => {
  it("greets a new user with a connect-wallet button", async () => {
    const h = harness()
    await h.say("/start")
    expect(String(h.last()!.payload.text)).toContain("Keel")
    expect(buttonUrls(h.last()!.payload)[0]).toBe("https://app.example/#/link")
  })

  it("asks to link a wallet before money commands, and refuses them in groups", async () => {
    const h = harness()
    await h.say("/borrow 5000")
    expect(String(h.last()!.payload.text)).toContain("Connect your wallet")
    await h.say("/position", { id: 42, username: "ada", first_name: "Ada" }, { id: -100, type: "supergroup" })
    expect(String(h.last()!.payload.text)).toContain("private")
  })

  it("quotes a borrow and creates a signing intent", async () => {
    const h = harness()
    h.say("/start")
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/borrow 5000 250")
    const text = String(h.last()!.payload.text)
    expect(text).toContain("Borrow 5,000")
    expect(text).toContain("Liquidation at")
    const url = buttonUrls(h.last()!.payload)[0]!
    const id = url.split("/i/")[1]!
    const intent = h.store.getIntent(id)!
    expect(intent.type).toBe("borrow")
    expect(intent.tg_id).toBe(42)
    expect(intent.params.amount).toBe((5000n * E18).toString())
    expect(intent.params.targetIcr).toBe(pct(250).toString())
  })

  it("rejects a bad amount with a friendly message", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/borrow abc")
    expect(String(h.last()!.payload.text)).toContain("not a valid")
  })

  it("sends by @handle to a linked user and falls back to a claim link otherwise", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say("/send @bob 25 lunch")
    const i1 = h.store.getIntent(buttonUrls(h.last()!.payload)[0]!.split("/i/")[1]!)!
    expect(i1.type).toBe("send")
    expect(i1.params.to).toBe(BOB)
    await h.say("/send @carol 10")
    const i2 = h.store.getIntent(buttonUrls(h.last()!.payload)[0]!.split("/i/")[1]!)!
    expect(i2.type).toBe("create_claim")
  })

  it("shows the position card with guardian state", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.chain.setView(ADA, { trove: trove(pct(200)), guardian: guardian() })
    await h.say("/position")
    const text = String(h.last()!.payload.text)
    expect(text).toContain("200%")
    expect(text).toContain("Guardian")
    expect(text).toContain("guarded")
  })

  it("routes /start claim_ and pay_ payloads", async () => {
    const h = harness()
    await h.say("/start claim_0xabc")
    expect(buttonUrls(h.last()!.payload)[0]).toBe("https://app.example/#/claim/0xabc")
  })

  it("posts a group split request and lets a member start paying", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    const group = { id: -100, type: "supergroup" }
    await h.say("/split 90 @bob @carol dinner", { id: 42, username: "ada", first_name: "Ada" }, group)
    const post = String(h.last()!.payload.text)
    expect(post).toContain("30 MUSD")
    expect(post).toContain("⏳ @bob")
    const reqUrl = buttonUrls(h.last()!.payload)[0]!
    expect(reqUrl).toContain("?start=pay_")
    const reqId = reqUrl.split("pay_")[1]!

    h.store.upsertUser(7, "bob", "Bob")
    h.store.setAddress(7, BOB)
    await h.say(`/start pay_${reqId}`, { id: 7, username: "bob", first_name: "Bob" }, { id: 7, type: "private" })
    const intent = h.store.getIntent(buttonUrls(h.last()!.payload)[0]!.split("/i/")[1]!)!
    expect(intent.type).toBe("pay_request")
    expect(intent.params.to).toBe(ADA)
  })

  it("builds protection config intents", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/protect 135 160")
    const i = h.store.getIntent(buttonUrls(h.last()!.payload)[0]!.split("/i/")[1]!)!
    expect(i.type).toBe("protect_config")
    expect(i.params.minIcr).toBe(pct(135).toString())
    await h.say("/protect 105 150")
    expect(String(h.last()!.payload.text)).toContain("above 110%")
    void GUARDIAN
  })
})

describe("small wallets (0.05 BTC faucet)", () => {
  it("defaults /borrow to 1,800 MUSD at 160% and warns with the exact BTC needed", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.chain.btc = E18 / 100n // 0.01 BTC
    await h.say("/borrow")
    const text = String(h.last()!.payload.text)
    expect(text).toContain("Borrow 1,800")
    expect(text).toContain("160%")
    expect(text).toContain("Not enough BTC")
    expect(text).toMatch(/about <b>0\.0\d+ BTC<\/b>/)
    expect(buttonUrls(h.last()!.payload)).toHaveLength(0) // no sign button when the wallet is short

    h.chain.btc = E18 / 20n // 0.05 BTC
    await h.say("/borrow")
    expect(buttonUrls(h.last()!.payload)[0]).toContain("/#/i/")
    expect(String(h.last()!.payload.text)).toContain("/fund 0.005")
  })

  it("tells the user the keeper acts right away when /protect trigger is above the current ratio", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.chain.setView(ADA, { trove: trove(pct(160)), guardian: guardian({ reserveBTC: E18 / 200n }) })
    await h.say("/protect 170 180")
    expect(String(h.last()!.payload.text)).toContain("keeper will top you up")
  })
})

describe("borrow guardrails from Mezo's rules", () => {
  it("in Recovery Mode a loan under 150% gets no sign button", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    h.chain.sysState = { ...h.chain.sysState, recoveryMode: true }
    await h.say("/borrow 1800 140")
    expect(String(h.last()!.payload.text)).toContain("Recovery Mode")
    expect(buttonUrls(h.last()!.payload)).toHaveLength(0)
    await h.say("/borrow 1800 160")
    expect(buttonUrls(h.last()!.payload)[0]).toContain("/#/i/")
  })
  it("under the 1,800 MUSD minimum gets no sign button", async () => {
    const h = harness()
    h.store.upsertUser(42, "ada", "Ada")
    h.store.setAddress(42, ADA)
    await h.say("/borrow 500")
    expect(String(h.last()!.payload.text)).toContain("Minimum borrow")
    expect(buttonUrls(h.last()!.payload)).toHaveLength(0)
  })
})
