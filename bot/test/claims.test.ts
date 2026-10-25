import { describe, expect, it } from "vitest"
import { E18 } from "@keel/shared"
import type { Address, Hex } from "viem"
import { Store } from "../src/db"
import { createApi } from "../src/api"
import type { ClaimRelayer, LinkInfo } from "../src/relayer"
import { ADA, BOB, FakeChain, FakeNotifier, config } from "./helpers"

const LINK = "0x00000000000000000000000000000000000000d4" as Address

function setup(info: LinkInfo | null, claim: ClaimRelayer["claim"] = async () => ("0x" + "ab".repeat(32)) as Hex) {
  const store = new Store(":memory:")
  store.upsertUser(42, "ada", "Ada")
  store.setAddress(42, ADA)
  store.upsertUser(7, "bob", "Bob")
  store.setAddress(7, BOB)
  const notifier = new FakeNotifier()
  const relayer: ClaimRelayer = { link: async () => info, claim }
  const app = createApi({ config: { ...config, adminIds: [1] }, store, chain: new FakeChain(), notifier, relayer })
  return { store, notifier, app }
}

describe("claim links", () => {
  it("shows who sent it, how much, and that it's open", async () => {
    const { app } = setup({ sender: ADA, amount: 20n * E18, expiry: Math.floor(Date.now() / 1000) + 3600, settled: false })
    const r = await (await app.request(`/api/claim/${LINK}`)).json() as any
    expect(r).toMatchObject({ senderName: "@ada", amount: (20n * E18).toString(), status: "open", settled: false })
  })
  it("says who claimed it, or that it was cancelled, or expired", async () => {
    const claimed = setup({ sender: ADA, amount: E18, expiry: 9_999_999_999, settled: true })
    claimed.store.recordEvent({ tx: "0x" + "01".repeat(32), log_index: 1, wallet: ADA, kind: "link_claimed", counterparty: BOB, amount: E18.toString(), block: 5, at: 1, data: { link: LINK } })
    expect(await (await claimed.app.request(`/api/claim/${LINK}`)).json()).toMatchObject({ status: "claimed", claimedBy: "@bob" })
    const cancelled = setup({ sender: ADA, amount: E18, expiry: 9_999_999_999, settled: true })
    cancelled.store.recordEvent({ tx: "0x" + "02".repeat(32), log_index: 1, wallet: ADA, kind: "link_cancelled", counterparty: LINK, amount: E18.toString(), block: 5, at: 1, data: { link: LINK } })
    expect(await (await cancelled.app.request(`/api/claim/${LINK}`)).json()).toMatchObject({ status: "cancelled" })
    const expired = setup({ sender: ADA, amount: E18, expiry: 1000, settled: false })
    expect(await (await expired.app.request(`/api/claim/${LINK}`)).json()).toMatchObject({ status: "expired" })
  })
  it("an unknown link (another network, or a typo) is a clear 404", async () => {
    const { app } = setup(null)
    const r = await app.request(`/api/claim/${LINK}`)
    expect(r.status).toBe(404)
    expect(((await r.json()) as any).error).toContain("doesn't exist on this network")
  })
  it("relays the destination-bound claim and tells the sender once", async () => {
    const { app, notifier } = setup({ sender: ADA, amount: 5n * E18, expiry: 9_999_999_999, settled: false })
    const body = JSON.stringify({ link: LINK, to: BOB, signature: "0x" + "11".repeat(65) })
    const r = await app.request("/api/claim/relay", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect(r.status).toBe(200)
    expect(notifier.sent.filter((m) => m.to === 42 && m.text.includes("was claimed by <b>@bob</b>"))).toHaveLength(1)
  })
  it("relayer out of gas: the claimer gets a clear message and the admins are alerted once", async () => {
    const { app, notifier } = setup({ sender: ADA, amount: E18, expiry: 9_999_999_999, settled: false }, async () => {
      throw new Error("insufficient funds for gas * price + value")
    })
    const body = JSON.stringify({ link: LINK, to: BOB, signature: "0x" + "11".repeat(65) })
    const a = await app.request("/api/claim/relay", { method: "POST", headers: { "content-type": "application/json" }, body })
    await app.request("/api/claim/relay", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect(a.status).toBe(503)
    expect(((await a.json()) as any).code).toBe("relayer_gas")
    expect(notifier.sent.filter((m) => m.to === 1 && m.text.includes("out of gas"))).toHaveLength(1)
  })
  it("maps contract errors to plain words", async () => {
    const { app } = setup({ sender: ADA, amount: E18, expiry: 9_999_999_999, settled: false }, async () => {
      throw new Error("reverted with custom error LinkSettled()")
    })
    const r = await app.request("/api/claim/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: LINK, to: BOB, signature: "0x" + "11".repeat(65) }) })
    expect(await r.json()).toMatchObject({ error: "This link was already claimed or cancelled.", code: "settled" })
  })
})
