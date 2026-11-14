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
