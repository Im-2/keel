import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { E18 } from "@keel/shared"
import type { Address, Hex } from "viem"
import { Store } from "../src/db"
import { AlertEngine } from "../src/alerts"
import { Keeper } from "../src/keeper"
import { Ops, mountOps } from "../src/ops"
import { FakeChain, FakeNotifier, config } from "./helpers"

const KEEPER: Address = "0x048Ea1d824C2E518A687Dd934dCCE6b48ED1E981"

function setup(balance: bigint, now = 1_000_000) {
  const store = new Store(":memory:")
  const chain = new FakeChain()
  chain.btc = balance
  const notifier = new FakeNotifier()
  const protectedCalls: Address[] = []
  const keeper = new Keeper({ guardians: async () => ["0x00000000000000000000000000000000000000c3"], canProtect: async () => true, protect: async (g) => (protectedCalls.push(g), "0xabc" as Hex) }, store, () => undefined)
  let t = now
  const ops = new Ops({
    config: { ...config, adminIds: [811387215] },
    store, chain, notifier, keeper, keeperAddress: KEEPER, mode: "webhook",
    alerts: new AlertEngine({ config, store, chain, notifier }),
    botInfo: async () => ({ username: "KeelTestBot" }),
    minKeeperBtc: 0.001,
    now: () => t,
  })
  const app = new Hono()
  mountOps(app, ops, "s3cret")
  return { store, chain, notifier, ops, app, protectedCalls, advance: (s: number) => (t += s) }
}

describe("ops: schedule, status and keeper funding", () => {
  it("the external schedule needs the secret, then runs keeper and alerts and records the runs", async () => {
    const { app, ops, protectedCalls } = setup(E18 / 100n)
    expect((await app.request("/cron/tick")).status).toBe(403)
    expect((await app.request("/cron/tick?key=wrong")).status).toBe(403)
    expect((await app.request("/cron/tick?key=s3cret")).status).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(protectedCalls).toHaveLength(1)
    expect(ops.lastRun("keeper")).toMatchObject({ ok: true, detail: expect.stringContaining("protected") })
    expect(ops.lastRun("alerts")).toMatchObject({ ok: true })
  })

  it("warns the admins when the keeper wallet runs low, at most every 12 hours", async () => {
    const { ops, notifier, advance } = setup(E18 / 2000n) // 0.0005 BTC < 0.001
    await ops.checkKeeperBalance()
    await ops.checkKeeperBalance()
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].to).toBe(811387215)
    expect(notifier.sent[0].text).toContain("Keeper wallet is low")
    expect(notifier.sent[0].text).toContain(KEEPER)
    advance(13 * 3600)
    await ops.checkKeeperBalance()
    expect(notifier.sent).toHaveLength(2)
  })

  it("stays quiet when the keeper is funded, and the status page shows balance, runs and RPC", async () => {
    const { ops, app, notifier } = setup(E18 / 100n)
    await ops.runKeeper()
    expect(notifier.sent).toHaveLength(0)
    const s = (await (await app.request("/status.json")).json()) as { ok: boolean; keeper: { balanceBtc: string; low: boolean; lastRun: { ok: boolean } }; rpc: { block: string }; bot: { username: string; mode: string } }
    expect(s.ok).toBe(true)
    expect(s.keeper.balanceBtc).toBe("0.01")
    expect(s.keeper.low).toBe(false)
    expect(s.keeper.lastRun.ok).toBe(true)
    expect(s.rpc.block).toBe("100")
    expect(s.bot).toMatchObject({ username: "KeelTestBot", mode: "webhook" })
    const html = await (await app.request("/status")).text()
    expect(html).toContain("Keel status")
    expect(html).toContain("0.01 BTC")
  })

  it("a failing job is recorded, not thrown, and overlapping runs are skipped", async () => {
    const { store, ops } = setup(E18)
    let calls = 0
    const slow = new Ops({
      config, store, chain: new FakeChain(), notifier: new FakeNotifier(), mode: "polling",
      alerts: { tick: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); throw new Error("rpc down") } } as unknown as AlertEngine,
      botInfo: async () => ({}),
    })
    await Promise.all([slow.runAlerts(), slow.runAlerts()])
    expect(calls).toBe(1)
    expect(slow.lastRun("alerts")).toMatchObject({ ok: false, detail: "rpc down" })
    void ops
  })
})
