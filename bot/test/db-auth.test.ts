import { describe, expect, it } from "vitest"
import { Store } from "../src/db"
import { signInitData, validateInitData } from "../src/telegram-auth"

const TOKEN = "123456:TEST-token"
const now = Math.floor(Date.now() / 1000)
const user = JSON.stringify({ id: 42, username: "Ada", first_name: "Ada" })

describe("telegram initData", () => {
  it("accepts a correctly signed payload", () => {
    const d = signInitData({ auth_date: String(now), user, start_param: "x" }, TOKEN)
    const v = validateInitData(d, TOKEN)
    expect(v.user.id).toBe(42)
    expect(v.startParam).toBe("x")
  })
  it("rejects tampering, wrong token, and stale data", () => {
    const d = signInitData({ auth_date: String(now), user }, TOKEN)
    expect(() => validateInitData(d.replace("Ada", "Eve"), TOKEN)).toThrow(/bad signature/)
    expect(() => validateInitData(d, "999:other")).toThrow(/bad signature/)
    const old = signInitData({ auth_date: String(now - 3 * 24 * 3600), user }, TOKEN)
    expect(() => validateInitData(old, TOKEN)).toThrow(/expired/)
    expect(() => validateInitData("auth_date=1&user={}", TOKEN)).toThrow(/missing hash/)
  })
})

describe("store", () => {
  it("binds one address to one Telegram account and finds users by handle", () => {
    const s = new Store(":memory:")
    s.upsertUser(1, "Alice", "Alice")
    s.upsertUser(2, "bob", "Bob")
    s.setAddress(1, "0xAAAA000000000000000000000000000000000001")
    expect(s.findByUsername("@alice")?.tg_id).toBe(1)
    expect(s.findByAddress("0xaaaa000000000000000000000000000000000001")?.tg_id).toBe(1)
    // re-binding the same address to another account moves it
    s.setAddress(2, "0xaaaa000000000000000000000000000000000001")
    expect(s.getUser(1)?.address).toBeNull()
    expect(s.getUser(2)?.address).toBe("0xaaaa000000000000000000000000000000000001")
    expect(s.boundUsers()).toHaveLength(1)
  })
  it("issues single-use nonces and keeps settings", () => {
    const s = new Store(":memory:")
    s.upsertUser(1, "a")
    const n = s.issueNonce(1)
    expect(s.consumeNonce(n, 2)).toBe(false)
    expect(s.consumeNonce(n, 1)).toBe(true)
    expect(s.consumeNonce(n, 1)).toBe(false)
    expect(s.updateSettings(1, { warnIcr: 1.6 }).warnIcr).toBe(1.6)
    expect(s.getUser(1)!.settings.dangerIcr).toBe(1.3)
  })
  it("tracks intents and split payments", () => {
    const s = new Store(":memory:")
    const i = s.createIntent(1, "send", { to: "0x1", amount: "5" }, 99)
    expect(s.getIntent(i.id)?.params).toEqual({ to: "0x1", amount: "5" })
    s.completeIntent(i.id, "done", "0xhash")
    s.completeIntent(i.id, "failed") // cannot be overwritten once settled
    expect(s.getIntent(i.id)?.status).toBe("done")
    const r = s.createRequest({ chat_id: 5, requester_tg: 1, requester_address: "0x1", amount: "30", memo: "pizza", participants: null })
    s.markRequestPaid(r.id, { tg_id: 2, tx_hash: "0xa" })
    s.markRequestPaid(r.id, { tg_id: 2, tx_hash: "0xa" })
    expect(s.getRequest(r.id)!.paid).toHaveLength(1)
  })
})
