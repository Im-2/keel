import { E18 } from "./risk"

/** Raw balances for one person, all 18-decimal integers. Missing parts count as zero. */
export interface BalanceInput {
  /** Native BTC in the wallet. */
  walletBtc: bigint
  /** MUSD in the wallet. */
  walletMusd: bigint
  /** BTC/USD from the MUSD price feed (the same oracle the risk math uses). */
  price: bigint
  /** BTC locked as loan collateral, and the loan's debt. */
  loanColl?: bigint
  loanDebt?: bigint
  /** The guardian's protection reserve. */
  reserveBtc?: bigint
  reserveMusd?: bigint
}

/** Every figure the dashboard and /balance show, in 18-decimal USD (1 MUSD counts as $1). */
export interface BalanceSummary {
  walletBtcUsd: bigint
  walletMusdUsd: bigint
  /** What you can spend right now: wallet BTC at the oracle price + wallet MUSD. */
  walletUsd: bigint
  loanCollUsd: bigint
  reserveUsd: bigint
  /** Locked in Keel: loan collateral + protection reserve. */
  lockedUsd: bigint
  /** Everything you hold: wallet + locked. */
  grossUsd: bigint
  debt: bigint
  /** Gross minus the loan's debt. */
  netUsd: bigint
  /** BTC's share of the wallet's USD value, in basis points (0..10000). 0 when the wallet is empty. */
  walletBtcShareBps: number
}

/** BTC amount (1e18) times price (1e18 USD per BTC), floored to the wei. */
export const btcToUsd = (btc: bigint, price: bigint) => (btc * price) / E18

export function summarizeBalances(b: BalanceInput): BalanceSummary {
  const walletBtcUsd = btcToUsd(b.walletBtc, b.price)
  const walletMusdUsd = b.walletMusd
  const walletUsd = walletBtcUsd + walletMusdUsd
  const loanCollUsd = btcToUsd(b.loanColl ?? 0n, b.price)
  const reserveUsd = btcToUsd(b.reserveBtc ?? 0n, b.price) + (b.reserveMusd ?? 0n)
  const lockedUsd = loanCollUsd + reserveUsd
  const grossUsd = walletUsd + lockedUsd
  const debt = b.loanDebt ?? 0n
  return {
    walletBtcUsd, walletMusdUsd, walletUsd, loanCollUsd, reserveUsd, lockedUsd, grossUsd, debt,
    netUsd: grossUsd - debt,
    walletBtcShareBps: walletUsd === 0n ? 0 : Number((walletBtcUsd * 10_000n + walletUsd / 2n) / walletUsd),
  }
}

/** "$1,234.57": rounded half-up to cents, always two decimals (money, unlike fmtUsd which trims). */
export function fmtUsdCents(v: bigint): string {
  const neg = v < 0n
  const cents = ((neg ? -v : v) + E18 / 200n) / (E18 / 100n)
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${neg ? "-" : ""}$${whole}.${(cents % 100n).toString().padStart(2, "0")}`
}

/** Percent change between two prices as a signed string with one decimal, e.g. "+2.4%". Null when unknown. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): string | null {
  if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to)) return null
  const p = ((to - from) / from) * 100
  const r = Math.round(p * 10) / 10
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)}%`
}
