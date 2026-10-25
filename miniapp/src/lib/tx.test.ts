import { describe, expect, it } from "vitest"
import { TxRevertedError, TxTimeoutError, pendingItem, settle, txFailureReason, upsertTop, waitForSuccess } from "./tx"
import type { IntentDto } from "./api"

const H = ("0x" + "ab".repeat(32)) as `0x${string}`
const noSleep = async () => undefined

describe("transaction states", () => {
  it("confirmed only once a receipt says success, riding out 'not found' and RPC errors", async () => {
    const answers: Array<null | "throw" | { status: "success" }> = [null, "throw", null, { status: "success" }]
    let calls = 0
    await waitForSuccess(async () => {
      const a = answers[calls++]
      if (a === "throw") throw new Error("Transaction receipt not found")
      return a
    }, H, { sleep: noSleep })
    expect(calls).toBe(4)
  })
  it("failed when mined but reverted", async () => {
    await expect(waitForSuccess(async () => ({ status: "reverted" }), H, { sleep: noSleep })).rejects.toBeInstanceOf(TxRevertedError)
  })
  it("never claims success on a timeout", async () => {
    let t = 0
    await expect(waitForSuccess(async () => null, H, { sleep: async () => void (t += 1500), now: () => t, timeoutMs: 6000 })).rejects.toBeInstanceOf(TxTimeoutError)
  })
  it("explains failures: rejected, gas, balance, revert", () => {
    expect(txFailureReason(new Error("User rejected the request."))).toContain("You rejected")
    expect(txFailureReason({ shortMessage: "insufficient funds for gas * price + value" })).toContain("Not enough BTC")
    expect(txFailureReason(new Error("ERC20: transfer amount exceeds balance"))).toContain("Insufficient balance")
    expect(txFailureReason(new TxRevertedError(H))).toContain("reverted")
    expect(txFailureReason(new Error("execution reverted"))).toContain("would revert")
  })
  it("a pending row appears at once, then becomes confirmed or failed", () => {
    const intent: IntentDto = { id: "i1", tg_id: 1, type: "send", status: "pending", params: { to: "0xb", amount: "5000000000000000000", label: "@bob", memo: "Lunch" } }
    const row = pendingItem(intent, H, 1000)
    expect(row).toMatchObject({ id: "i1", status: "pending", amount: "5000000000000000000", asset: "MUSD", counterparty: "@bob", memo: "Lunch", tx: H })
    const old = { ...row, id: "o", status: "confirmed" as const, tx: "0xold" }
    const list = upsertTop([old], row)
    expect(list.map((i) => i.id)).toEqual(["i1", "o"])
    expect(upsertTop(list, { ...row, status: "confirmed" })).toHaveLength(2) // replaced, not duplicated
    expect(settle(list, "i1", "confirmed")[0].status).toBe("confirmed")
    expect(settle(list, "i1", "failed")[0].status).toBe("failed")
  })
})
