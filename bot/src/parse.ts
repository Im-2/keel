import { parseUnits18, pct } from "@keel/shared"

export class UserError extends Error {}

export function parseAmount(raw: string | undefined, what = "amount"): bigint {
  if (!raw) throw new UserError(`Please include an ${what}, e.g. 25`)
  let v: bigint
  try {
    v = parseUnits18(raw)
  } catch {
    throw new UserError(`"${raw}" is not a valid ${what}.`)
  }
  if (v <= 0n) throw new UserError(`The ${what} must be greater than zero.`)
  return v
}

/** "150" or "150%" -> 1.5e18 */
export function parsePercent(raw: string | undefined, fallback: number): bigint {
  if (!raw) return pct(fallback)
  const n = Number(raw.replace("%", ""))
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new UserError(`"${raw}" is not a valid percentage.`)
  return pct(n)
}

export type Recipient = { kind: "address"; address: `0x${string}` } | { kind: "username"; username: string }

export function parseRecipient(raw: string | undefined): Recipient {
  if (!raw) throw new UserError("Who is it for? Use @username or a 0x address.")
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { kind: "address", address: raw as `0x${string}` }
  if (/^@[A-Za-z0-9_]{3,32}$/.test(raw)) return { kind: "username", username: raw.slice(1) }
  throw new UserError(`"${raw}" doesn't look like @username or a 0x address.`)
}

export const splitArgs = (match: string | undefined) => (match ?? "").trim().split(/\s+/).filter(Boolean)

/** Command argument text. grammY types `ctx.match` as string | RegExpMatchArray. */
export const args = (ctx: { match?: unknown }): string => (typeof ctx.match === "string" ? ctx.match : "")
