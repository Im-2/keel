import { describe, expect, it } from "vitest"
import {
  CCR, E18, GAS_COMP, MCR, collateralToTarget, computeIcr, fmtBtc, fmtIcr, fmtMusd, fmtUsd, liquidationPrice,
  parseUnits18, pct, priceBufferBps, quoteBorrow, redemptionAhead, riskLevel, type TroveSnapshot,
} from "../src/risk"

const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n

describe("trove math", () => {
  it("computes ICR and liquidation price consistently", () => {
    const coll = 2n * E18 // 2 BTC
    const debt = usd(60_000)
    const price = usd(100_000)
    const icr = computeIcr(coll, debt, price)
    expect(icr).toBe((E18 * 10n) / 3n) // 333.33...%
    // at the liquidation price the ICR is exactly MCR (to rounding)
    const liq = liquidationPrice(coll, debt)
    expect(computeIcr(coll, debt, liq)).toBeGreaterThanOrEqual(MCR - 1n)
    expect(computeIcr(coll, debt, liq)).toBeLessThanOrEqual(MCR + 1n)
    expect(priceBufferBps(price, liq)).toBeGreaterThan(6000)
  })

  it("classifies risk bands", () => {
    expect(riskLevel(pct(109))).toBe("liquidatable")
    expect(riskLevel(pct(125))).toBe("critical")
    expect(riskLevel(pct(140))).toBe("danger")
    expect(riskLevel(pct(170))).toBe("watch")
    expect(riskLevel(pct(250))).toBe("safe")
  })

  it("computes collateral needed to reach a target", () => {
    const price = usd(100_000)
    const debt = usd(10_000)
    const coll = (debt * pct(125)) / price // at 125%
    const add = collateralToTarget(coll, debt, price, pct(150))
    expect(computeIcr(coll + add, debt, price)).toBeGreaterThanOrEqual(pct(150))
    expect(collateralToTarget(coll * 2n, debt, price, pct(150))).toBe(0n)
  })
})

describe("borrow quote", () => {
  const base = { price: usd(100_000), borrowingRate: E18 / 1000n, interestRateBps: 100, minNetDebt: 1800n * E18 }

  it("adds the 0.1% fee and 200 MUSD gas compensation", () => {
    const q = quoteBorrow({ ...base, borrowAmount: 10_000n * E18, targetIcr: pct(200) })
    expect(q.fee).toBe(10n * E18)
    expect(q.netDebt).toBe(10_010n * E18)
    expect(q.totalDebt).toBe(10_010n * E18 + GAS_COMP)
    expect(q.icr).toBeGreaterThanOrEqual(pct(200))
    expect(q.risk).toBe("safe")
    expect(q.warnings).toHaveLength(0)
    expect(q.annualInterest).toBe((q.totalDebt * 100n) / 10_000n)
  })

  it("derives collateral from a target ratio and the ratio from collateral", () => {
    const a = quoteBorrow({ ...base, borrowAmount: 5_000n * E18, targetIcr: pct(150) })
    const b = quoteBorrow({ ...base, borrowAmount: 5_000n * E18, collateral: a.collateral })
    expect(b.icr).toBeGreaterThanOrEqual(pct(150))
    expect(b.icr).toBeLessThan(pct(150) + E18 / 10_000n)
  })

  it("warns about the minimum, low ratios and Recovery Mode", () => {
    expect(quoteBorrow({ ...base, borrowAmount: 1_000n * E18, targetIcr: pct(200) }).warnings.join()).toMatch(/Minimum borrow/)
    expect(quoteBorrow({ ...base, borrowAmount: 5_000n * E18, targetIcr: pct(120) }).warnings.join()).toMatch(/risky/)
    expect(quoteBorrow({ ...base, borrowAmount: 5_000n * E18, targetIcr: pct(105) }).warnings.join()).toMatch(/below the 110%/)
    expect(quoteBorrow({ ...base, borrowAmount: 5_000n * E18, targetIcr: pct(140), recoveryMode: true }).warnings.join()).toMatch(/Recovery Mode/)
    expect(CCR).toBeGreaterThan(MCR)
  })
})

describe("redemption exposure", () => {
  const t = (n: number, icr: number, debt = 1000): TroveSnapshot => ({
    owner: `0x${n.toString(16).padStart(40, "0")}`, coll: E18, debt: BigInt(debt) * E18, icr: pct(icr),
  })
  it("sums debt of redeemable troves below you and skips liquidatable ones", () => {
    const troves = [t(1, 105, 5000), t(2, 115, 2000), t(3, 140, 3000), t(4, 200, 9000)]
    const r = redemptionAhead(troves, troves[3].owner)!
    expect(r.ahead).toBe(5000n * E18) // 115% + 140% troves; the 105% trove is liquidatable, not redeemable
    expect(r.rank).toBe(2)
    expect(r.total).toBe(3)
    expect(redemptionAhead(troves, troves[1].owner)!.ahead).toBe(0n) // lowest redeemable = next in line
    expect(redemptionAhead(troves, "0x00000000000000000000000000000000000000ff")).toBeNull()
  })
})

describe("formatting", () => {
  it("formats and parses amounts", () => {
    expect(fmtUsd(1234567n * 10n ** 15n)).toBe("$1,234.56") // truncates to 2 decimals
    expect(fmtUsd(1234567n * 10n ** 15n, 3)).toBe("$1,234.567")
    expect(fmtMusd(10_000n * E18)).toBe("10,000 MUSD")
    expect(fmtBtc(E18 / 3n)).toBe("0.333333 BTC")
    expect(fmtIcr(pct(150))).toBe("150%")
    expect(parseUnits18("1,250.5")).toBe(12505n * E18 / 10n)
    expect(parseUnits18("$0.000000000000000001")).toBe(1n)
    expect(() => parseUnits18("abc")).toThrow()
    expect(() => parseUnits18("")).toThrow()
  })
})
