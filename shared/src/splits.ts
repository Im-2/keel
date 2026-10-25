/** Bill-splitting math. Every function returns shares that add up to the total exactly. */

/** 1 cent of MUSD (18 decimals). Shares are whole cents whenever the total is. */
export const CENT = 10n ** 16n

export type SplitMode =
  | { kind: "equal" }
  /** Exact amounts per person (18-decimal integers). */
  | { kind: "amounts"; amounts: bigint[] }
  /** Basis points per person (100% = 10000). */
  | { kind: "percent"; bps: number[] }

export class SplitError extends Error {}

/** Equal shares; the leftover cents go one each to the first people, so 100 / 3 = 33.34 + 33.33 + 33.33. */
export function equalShares(total: bigint, n: number): bigint[] {
  if (n < 1) throw new SplitError("A split needs at least one person.")
  if (total <= 0n) throw new SplitError("The total must be more than zero.")
  const unit = total % CENT === 0n ? CENT : 1n
  const units = total / unit
  if (units < BigInt(n)) throw new SplitError("The total is too small to split that many ways.")
  const base = units / BigInt(n)
  const extra = Number(units % BigInt(n))
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1n : 0n)) * unit)
}

/** Percentages that must sum to exactly 100%; rounding cents go to the largest remainders (ties: first listed). */
export function percentShares(total: bigint, bps: number[]): bigint[] {
  if (!bps.length) throw new SplitError("A split needs at least one person.")
  if (bps.some((b) => !Number.isInteger(b) || b <= 0)) throw new SplitError("Each percentage must be more than 0%.")
  const sum = bps.reduce((a, b) => a + b, 0)
  if (sum !== 10_000) throw new SplitError(`The percentages add up to ${sum / 100}%, not 100%.`)
  const unit = total % CENT === 0n ? CENT : 1n
  const units = total / unit
  const raw = bps.map((b) => units * BigInt(b))
  const floor = raw.map((r) => r / 10_000n)
  let left = units - floor.reduce((a, b) => a + b, 0n)
  const order = raw.map((r, i) => ({ i, rem: r % 10_000n })).sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1))
  for (const { i } of order) {
    if (left === 0n) break
    floor[i] += 1n
    left -= 1n
  }
  return floor.map((u) => u * unit)
}

/** Custom amounts: must each be positive and add up to the total. */
export function amountShares(total: bigint, amounts: bigint[]): bigint[] {
  if (!amounts.length) throw new SplitError("A split needs at least one person.")
  if (amounts.some((a) => a <= 0n)) throw new SplitError("Each share must be more than zero.")
  const sum = amounts.reduce((a, b) => a + b, 0n)
  if (sum !== total) throw new SplitError("The shares don't add up to the total.")
  return [...amounts]
}

export function computeShares(total: bigint, n: number, mode: SplitMode): bigint[] {
  if (mode.kind === "equal") return equalShares(total, n)
  if (mode.kind === "percent") {
    if (mode.bps.length !== n) throw new SplitError("Give a percentage for every person.")
    return percentShares(total, mode.bps)
  }
  if (mode.amounts.length !== n) throw new SplitError("Give an amount for every person.")
  return amountShares(total, mode.amounts)
}

/**
 * The shares people are asked to pay. With `includeMe` the requester is one of the `n + 1` people: their own share
 * is computed but not requested (it's the first, so they absorb rounding), and the rest are returned.
 */
export function requestedShares(total: bigint, people: number, mode: SplitMode, includeMe: boolean): { mine: bigint; theirs: bigint[] } {
  if (!includeMe) return { mine: 0n, theirs: computeShares(total, people, mode) }
  const all = computeShares(total, people + 1, mode)
  return { mine: all[0], theirs: all.slice(1) }
}
