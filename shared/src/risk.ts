/** Pure, dependency-free risk and quote math for MUSD troves. All amounts are bigint, 1e18-scaled. */

export const E18 = 10n ** 18n
export const MCR = 11n * 10n ** 17n // 110%
export const CCR = 15n * 10n ** 17n // 150%
export const GAS_COMP = 200n * E18 // MUSD_GAS_COMPENSATION
export const BPS = 10_000n
/** Small-wallet budget (testnet faucet gives ~0.05 BTC): keep this much BTC for fees on top of collateral. */
export const GAS_BUFFER = 2n * 10n ** 15n // 0.002 BTC
/** Suggested guardian reserve for a minimum loan. */
export const SUGGESTED_RESERVE = 5n * 10n ** 15n // 0.005 BTC
export const DEFAULT_BORROW = 1800
export const DEFAULT_BORROW_ICR = 160

export type RiskLevel = "safe" | "watch" | "danger" | "critical" | "liquidatable"

export interface TroveSnapshot {
  owner: `0x${string}`
  coll: bigint // BTC, 1e18
  debt: bigint // MUSD incl. interest and gas comp, 1e18
  icr: bigint // 1e18 = 100%
}

export const computeIcr = (coll: bigint, debt: bigint, price: bigint): bigint =>
  debt === 0n ? 2n ** 255n : (coll * price) / debt

/** BTC price (1e18 USD) at which this trove hits the 110% liquidation line. */
export const liquidationPrice = (coll: bigint, debt: bigint): bigint =>
  coll === 0n ? 0n : (debt * MCR) / coll

/** How far the BTC price can fall before liquidation, in basis points of the current price. */
export const priceBufferBps = (price: bigint, liqPrice: bigint): number =>
  price === 0n || liqPrice >= price ? 0 : Number(((price - liqPrice) * BPS) / price)

export function riskLevel(icr: bigint): RiskLevel {
  if (icr < MCR) return "liquidatable"
  if (icr < pct(130)) return "critical"
  if (icr < pct(150)) return "danger"
  if (icr < pct(180)) return "watch"
  return "safe"
}

export const pct = (n: number): bigint => (BigInt(Math.round(n * 100)) * E18) / 10_000n

export interface BorrowQuoteInput {
  borrowAmount: bigint // MUSD the user wants in hand
  price: bigint // BTC/USD, 1e18
  borrowingRate: bigint // 1e18 fraction, e.g. 0.001e18
  interestRateBps: number // fixed annual rate for new troves
  minNetDebt: bigint
  collateral?: bigint // BTC the user will lock...
  targetIcr?: bigint // ...or the ICR they want (collateral is derived)
  recoveryMode?: boolean
}

export interface BorrowQuote {
  fee: bigint
  netDebt: bigint
  totalDebt: bigint
  collateral: bigint
  icr: bigint
  liqPrice: bigint
  priceBufferBps: number
  annualInterest: bigint
  risk: RiskLevel
  warnings: string[]
}

export function quoteBorrow(i: BorrowQuoteInput): BorrowQuote {
  const fee = (i.borrowAmount * i.borrowingRate) / E18
  const netDebt = i.borrowAmount + fee
  const totalDebt = netDebt + GAS_COMP

  let collateral = i.collateral ?? 0n
  if (i.targetIcr !== undefined) {
    // ceil(target * debt / price)
    collateral = (i.targetIcr * totalDebt + i.price - 1n) / i.price
  }
  const icr = computeIcr(collateral, totalDebt, i.price)
  const liqPrice = liquidationPrice(collateral, totalDebt)
  const warnings: string[] = []
  if (netDebt < i.minNetDebt) warnings.push(`Minimum borrow is ${fmtUsd(i.minNetDebt)} (incl. fee).`)
  if (icr < MCR) warnings.push("Collateral ratio is below the 110% minimum.")
  else if (i.recoveryMode && icr < CCR) warnings.push("System is in Recovery Mode: new loans need at least 150%.")
  else if (icr < pct(150)) warnings.push("Under 150% is risky: a ~10-20% BTC drop could liquidate you.")
  return {
    fee,
    netDebt,
    totalDebt,
    collateral,
    icr,
    liqPrice,
    priceBufferBps: priceBufferBps(i.price, liqPrice),
    annualInterest: (totalDebt * BigInt(i.interestRateBps)) / BPS,
    risk: riskLevel(icr),
    warnings,
  }
}

/**
 * MUSD that must be redeemed before redemptions reach `ownerIcr`.
 * Redemptions hit the lowest-ICR troves first, but only those above the 110% liquidation line.
 * A tiny number means you are next in line. `null` means the owner is not in the list.
 */
export function redemptionAhead(troves: TroveSnapshot[], owner: `0x${string}`): { ahead: bigint; rank: number; total: number } | null {
  const me = troves.find((t) => t.owner.toLowerCase() === owner.toLowerCase())
  if (!me) return null
  const redeemable = troves.filter((t) => t.icr >= MCR).sort((a, b) => (a.icr < b.icr ? -1 : a.icr > b.icr ? 1 : 0))
  let ahead = 0n
  let rank = 0
  for (const t of redeemable) {
    if (t.owner.toLowerCase() === owner.toLowerCase()) break
    ahead += t.debt
    rank++
  }
  return { ahead, rank, total: redeemable.length }
}

/** Collateral to add (BTC) so that `coll`/`debt` reaches `targetIcr` at `price`. */
export const collateralToTarget = (coll: bigint, debt: bigint, price: bigint, targetIcr: bigint): bigint => {
  const need = (targetIcr * debt + price - 1n) / price
  return need > coll ? need - coll : 0n
}

// ---- formatting ---------------------------------------------------------------------------

const groupInt = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

export function fmtUnits(v: bigint, decimals: number, maxFrac: number): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = a / base
  let frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "")
  return `${neg ? "-" : ""}${groupInt(whole.toString())}${frac ? "." + frac : ""}`
}

export const fmtUsd = (v: bigint, frac = 2) => `$${fmtUnits(v, 18, frac)}`
export const fmtMusd = (v: bigint, frac = 2) => `${fmtUnits(v, 18, frac)} MUSD`
export const fmtBtc = (v: bigint, frac = 6) => `${fmtUnits(v, 18, frac)} BTC`
export const fmtIcr = (icr: bigint) => (icr > 100n * E18 ? "∞" : `${fmtUnits((icr * 100n), 18, 1)}%`)

/** Parse a decimal string like "1,250.5" into an 1e18 bigint. */
export function parseUnits18(input: string): bigint {
  const s = input.trim().replace(/[,_\s$]/g, "")
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`Invalid number: ${input}`)
  const [w, f = ""] = s.split(".")
  return BigInt(w || "0") * E18 + BigInt((f + "0".repeat(18)).slice(0, 18))
}

export const RISK_EMOJI: Record<RiskLevel, string> = {
  safe: "🟢",
  watch: "🟡",
  danger: "🟠",
  critical: "🔴",
  liquidatable: "☠️",
}

/**
 * Largest partial repayment Mezo accepts: BorrowerOperations requires the remaining net debt (debt minus the
 * 200 MUSD gas compensation) to stay at or above `minNetDebt`. Paying off more than this means closing the loan.
 */
export const maxPartialRepay = (debt: bigint, minNetDebt: bigint): bigint => {
  const m = debt - GAS_COMP - minNetDebt
  return m > 0n ? m : 0n
}

/** MUSD needed to close a loan: everything except the gas compensation, which the protocol burns from its pool. */
export const closeCost = (debt: bigint): bigint => (debt > GAS_COMP ? debt - GAS_COMP : 0n)
