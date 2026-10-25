import { describe, expect, it } from "vitest"
import { E18, btcToUsd, fmtUsdCents, pctChange, summarizeBalances } from "../src"

const btc = (n: string) => BigInt(Math.round(Number(n) * 1e8)) * 10n ** 10n
const usd = (n: number) => BigInt(Math.round(n * 100)) * (E18 / 100n)

describe("balances", () => {
  const price = 81_168n * E18

  it("wallet = BTC at the oracle price + MUSD; total adds what is locked; net subtracts debt", () => {
    const s = summarizeBalances({ walletBtc: btc("0.0071"), walletMusd: usd(1775.5), price, loanColl: btc("0.04439"), loanDebt: usd(2001.8), reserveBtc: btc("0.00005") })
    expect(fmtUsdCents(s.walletBtcUsd)).toBe("$576.29")
    expect(fmtUsdCents(s.walletUsd)).toBe("$2,351.79")
    expect(fmtUsdCents(s.loanCollUsd)).toBe("$3,603.05")
    expect(fmtUsdCents(s.reserveUsd)).toBe("$4.06")
    expect(s.lockedUsd).toBe(s.loanCollUsd + s.reserveUsd)
    expect(fmtUsdCents(s.grossUsd)).toBe("$5,958.90")
    expect(s.netUsd).toBe(s.grossUsd - usd(2001.8))
    expect(s.walletBtcShareBps).toBe(2450) // 576.29 / 2351.79
  })

  it("empty and MUSD-only wallets", () => {
    const zero = summarizeBalances({ walletBtc: 0n, walletMusd: 0n, price })
    expect(zero.grossUsd).toBe(0n)
    expect(zero.walletBtcShareBps).toBe(0)
    expect(fmtUsdCents(zero.grossUsd)).toBe("$0.00")
    expect(summarizeBalances({ walletBtc: 0n, walletMusd: usd(5), price }).walletBtcShareBps).toBe(0)
  })

  it("an MUSD reserve counts at $1, a BTC reserve at the price", () => {
    const s = summarizeBalances({ walletBtc: 0n, walletMusd: 0n, price: 100_000n * E18, reserveBtc: btc("0.01"), reserveMusd: usd(25) })
    expect(fmtUsdCents(s.reserveUsd)).toBe("$1,025.00")
  })

  it("follows the price", () => {
    const at = (p: bigint) => summarizeBalances({ walletBtc: btc("0.5"), walletMusd: usd(100), price: p * E18 }).walletUsd
    expect(fmtUsdCents(at(80_000n))).toBe("$40,100.00")
    expect(fmtUsdCents(at(60_000n))).toBe("$30,100.00")
  })

  it("decimals: wei-level amounts floor, cents round half-up, negatives keep their sign", () => {
    expect(btcToUsd(1n, price)).toBe(81_168n) // 1 wei of BTC
    expect(fmtUsdCents(E18 / 200n)).toBe("$0.01") // exactly half a cent rounds up
    expect(fmtUsdCents(E18 / 200n - 1n)).toBe("$0.00")
    expect(fmtUsdCents(1_234_567n * E18 + (E18 * 994n) / 1000n)).toBe("$1,234,567.99")
    expect(fmtUsdCents(1_234_567n * E18 + (E18 * 995n) / 1000n)).toBe("$1,234,568.00")
    expect(fmtUsdCents(-usd(12.5))).toBe("-$12.50")
  })

  it("price change", () => {
    expect(pctChange(80_000, 81_920)).toBe("+2.4%")
    expect(pctChange(80_000, 78_000)).toBe("−2.5%")
    expect(pctChange(80_000, 80_000)).toBe("0.0%")
    expect(pctChange(null, 80_000)).toBeNull()
    expect(pctChange(0, 80_000)).toBeNull()
  })
})
