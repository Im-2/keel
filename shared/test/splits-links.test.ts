import { describe, expect, it } from "vitest"
import {
  CENT, E18, SplitError, TG_PARAM_MAX, amountShares, claimLink, equalShares, keyToParam, paramToKey, parseStartParam, percentShares, requestedShares, splitLink,
} from "../src"

const musd = (n: number) => BigInt(Math.round(n * 100)) * CENT
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n)

describe("split shares always add up to the total", () => {
  it("100 three ways: 33.34 + 33.33 + 33.33", () => {
    expect(equalShares(musd(100), 3)).toEqual([musd(33.34), musd(33.33), musd(33.33)])
  })
  it("many totals and group sizes", () => {
    for (const total of [1, 10, 33.33, 99.99, 100, 250.5, 1000, 1234.56]) {
      for (let n = 1; n <= 12; n++) {
        const s = equalShares(musd(total), n)
        expect(sum(s)).toBe(musd(total))
        expect(s[0] - s[n - 1] <= CENT).toBe(true) // fair: nobody pays more than a cent extra
      }
    }
  })
  it("a total that isn't whole cents splits to the wei, still exact", () => {
    const t = 10n * E18 + 1n
    expect(sum(equalShares(t, 3))).toBe(t)
  })
  it("percentages summing to exactly 100%", () => {
    const s = percentShares(musd(100), [5000, 3000, 2000])
    expect(s).toEqual([musd(50), musd(30), musd(20)])
    const thirds = percentShares(musd(100), [3334, 3333, 3333])
    expect(sum(thirds)).toBe(musd(100))
    expect(sum(percentShares(musd(99.99), [3333, 3333, 3334]))).toBe(musd(99.99))
  })
  it("rejects percentages that don't make 100%", () => {
    expect(() => percentShares(musd(100), [5000, 3000])).toThrow(SplitError)
    expect(() => percentShares(musd(100), [6000, 5000])).toThrow(/110%/)
  })
  it("custom amounts must match the total", () => {
    expect(amountShares(musd(90), [musd(50), musd(40)])).toEqual([musd(50), musd(40)])
    expect(() => amountShares(musd(90), [musd(50), musd(30)])).toThrow(/don't add up/)
  })
  it("including me: I'm one of n+1 and absorb the rounding; excluding me: only them", () => {
    expect(requestedShares(musd(100), 2, { kind: "equal" }, true)).toEqual({ mine: musd(33.34), theirs: [musd(33.33), musd(33.33)] })
    expect(requestedShares(musd(100), 3, { kind: "equal" }, false)).toEqual({ mine: 0n, theirs: [musd(33.34), musd(33.33), musd(33.33)] })
    expect(requestedShares(musd(60), 1, { kind: "equal" }, true)).toEqual({ mine: musd(30), theirs: [musd(30)] })
  })
  it("refuses impossible splits", () => {
    expect(() => equalShares(0n, 2)).toThrow(SplitError)
    expect(() => equalShares(musd(0.01), 2)).toThrow(/too small/)
  })
})

describe("Telegram deep links fit the 64-character limit", () => {
  const key = "0x" + "f3".repeat(32)
  it("claim keys round-trip as 43-char base64url, and old hex still parses", () => {
    const p = keyToParam(key)
    expect(p).toHaveLength(43)
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(paramToKey(p)).toBe(key)
    expect(paramToKey("f3".repeat(32))).toBe(key)
    for (let i = 0; i < 50; i++) {
      const k = "0x" + [...Array(32)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("")
      expect(paramToKey(keyToParam(k))).toBe(k)
    }
  })
  it("a cut-off key is rejected, not misread", () => {
    expect(paramToKey(keyToParam(key).slice(0, 40))).toBeNull()
    expect(paramToKey("f3".repeat(29))).toBeNull() // what Telegram leaves of claim_<64 hex>
    expect(paramToKey(null)).toBeNull()
  })
  it("links are within Telegram's limit and parse back", () => {
    const c = claimLink("KeelMezoBot", "app", key)
    expect(c).toMatch(/^https:\/\/t\.me\/KeelMezoBot\/app\?startapp=claim_[A-Za-z0-9_-]{43}$/)
    expect(c.split("startapp=")[1].length).toBeLessThanOrEqual(TG_PARAM_MAX)
    expect(claimLink("KeelMezoBot", null, key)).toContain("?start=claim_")
    const start = c.split("startapp=")[1]
    expect(parseStartParam(start)).toEqual({ kind: "claim", key })
    expect(splitLink("KeelMezoBot", "app", "Ab3dEf9h", 2)).toBe("https://t.me/KeelMezoBot/app?startapp=split_Ab3dEf9h_2")
    expect(parseStartParam("split_Ab3dEf9h_2")).toEqual({ kind: "split", id: "Ab3dEf9h", idx: 2 })
    expect(parseStartParam("split_Ab3dEf9h")).toEqual({ kind: "split", id: "Ab3dEf9h", idx: null })
    expect(parseStartParam("pay_x1y2z3")).toEqual({ kind: "pay", id: "x1y2z3" })
    expect(parseStartParam("hello")).toEqual({ kind: "none" })
  })
})
