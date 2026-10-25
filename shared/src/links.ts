/**
 * Telegram deep-link parameters (`?start=` for the bot, `?startapp=` for the Mini App) allow only [A-Za-z0-9_-] and
 * at most 64 characters. A claim key as hex is 64 characters on its own, so "claim_" + hex (70) gets cut off and the
 * link arrives broken. Keys travel as base64url (43 characters) instead.
 */
export const TG_PARAM_MAX = 64

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** 32-byte hex key ("0x…" or bare) -> 43-character base64url. */
export function keyToParam(hexKey: string): string {
  const hex = hexKey.replace(/^0x/, "")
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("claim key must be 32 bytes")
  const bytes = hex.match(/../g)!.map((b) => parseInt(b, 16))
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out
}

/** Accepts the 43-character base64url form or legacy 64-character hex; returns "0x…" hex, or null if malformed. */
export function paramToKey(param: string | null | undefined): `0x${string}` | null {
  if (!param) return null
  const p = param.trim()
  if (/^[0-9a-fA-F]{64}$/.test(p)) return `0x${p.toLowerCase()}`
  if (!/^[A-Za-z0-9_-]{43}$/.test(p)) return null
  const bits = [...p].map((c) => B64.indexOf(c))
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 4) {
    const n = (bits[i] << 18) | (bits[i + 1] << 12) | ((bits[i + 2] ?? 0) << 6) | (bits[i + 3] ?? 0)
    bytes.push((n >> 16) & 255)
    if (i + 2 < bits.length) bytes.push((n >> 8) & 255)
    if (i + 3 < bits.length) bytes.push(n & 255)
  }
  if (bytes.length !== 32) return null
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Link that opens the Mini App straight on a screen (`startapp`), or the bot chat as a fallback when no Mini App
 * short name is configured. `param` must already be Telegram-safe.
 */
export function tgAppLink(botUsername: string, shortName: string | null | undefined, param: string): string {
  if (param.length > TG_PARAM_MAX || !/^[A-Za-z0-9_-]+$/.test(param)) throw new Error(`deep-link parameter not Telegram-safe: ${param.length} chars`)
  return shortName ? `https://t.me/${botUsername}/${shortName}?startapp=${param}` : `https://t.me/${botUsername}?start=${param}`
}

export const claimLink = (botUsername: string, shortName: string | null | undefined, hexKey: string) => tgAppLink(botUsername, shortName, `claim_${keyToParam(hexKey)}`)
export const splitLink = (botUsername: string, shortName: string | null | undefined, splitId: string, idx?: number) =>
  tgAppLink(botUsername, shortName, idx === undefined ? `split_${splitId}` : `split_${splitId}_${idx}`)

/** What a start parameter asks the Mini App to open. */
export type StartTarget =
  | { kind: "claim"; key: `0x${string}` | null }
  | { kind: "split"; id: string; idx: number | null }
  | { kind: "pay"; id: string }
  | { kind: "none" }

export function parseStartParam(p: string | null | undefined): StartTarget {
  if (!p) return { kind: "none" }
  if (p.startsWith("claim_")) return { kind: "claim", key: paramToKey(p.slice(6)) }
  const s = /^split_([A-Za-z0-9-]{4,16})(?:_(\d{1,3}))?$/.exec(p)
  if (s) return { kind: "split", id: s[1], idx: s[2] === undefined ? null : Number(s[2]) }
  const pay = /^pay_([A-Za-z0-9_-]{4,32})$/.exec(p)
  if (pay) return { kind: "pay", id: pay[1] }
  return { kind: "none" }
}
