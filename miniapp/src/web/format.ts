const E18 = 10n ** 18n

/** 18-decimal integer string → number (fine for display). */
export const toNum = (v: string | null | undefined) => {
  if (!v) return 0
  const b = BigInt(v)
  return Number(b / 10n ** 12n) / 1e6
}

export const musdFmt = (v: string) => `${toNum(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
export const btcFmt = (v: string) => `${toNum(v).toLocaleString("en-US", { maximumFractionDigits: 4 })}`
export const pctFmt = (v: string | null) => (v ? `${(toNum(v) * 100).toFixed(1)}%` : "—")
export const usdFmt = (v: string | null) => (v ? `$${toNum(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—")
export { E18 }

/** BTC with up to 8 decimals, for small amounts (protocol fees are fractions of a thousandth of a BTC). */
export const btcFine = (v: string | null | undefined) => {
  if (!v) return "0"
  const n = Number(BigInt(v) / 10n ** 6n) / 1e12 // keeps 1e-12 BTC resolution before rounding
  return n === 0 ? "0" : n.toLocaleString("en-US", { minimumFractionDigits: n < 0.0001 ? 8 : 4, maximumFractionDigits: 8 })
}
