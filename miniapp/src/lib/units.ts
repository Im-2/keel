import { E18, fmtBtc, fmtIcr, fmtMusd, fmtUsd } from "@keel/shared"

/** Decimal-string 18-decimal integer from the API -> bigint (0n for null). */
export const big = (v: string | null | undefined): bigint => (v ? BigInt(v) : 0n)

/** 18-decimal bigint -> float, for sliders and charts only (never for amounts we sign). */
export const num = (v: bigint): number => Number(v / 10n ** 12n) / 1e6

/** Float -> 18-decimal bigint, rounded to 6 decimals (slider positions). */
export const toBig = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n

export { E18, fmtBtc, fmtIcr, fmtMusd, fmtUsd }

export const icrPct = (icr: bigint) => num(icr) * 100

export type Tone = "safe" | "warn" | "danger"
export const toneOf = (icrPercent: number): Tone => (icrPercent >= 150 ? "safe" : icrPercent >= 125 ? "warn" : "danger")

export function timeAgo(unix: number): string {
  if (!unix) return ""
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unix))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** 184250.4 -> "184.3k" for tight tiles. */
export const compact = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Math.round(v).toLocaleString("en-US"))

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
