import { isAddress, type Address } from "viem"
import type { Store, UserRow } from "./db"

/** "They haven't joined Keel yet" wording shared by the chat and the Mini App, so both say the same thing. */
export const NOT_ON_KEEL = "They haven't joined Keel yet, so I'll create a claim link they can open"

export type Resolved =
  /** A wallet we can pay directly; `user` is set when it belongs to a Keel user. */
  | { kind: "wallet"; address: Address; label: string; user: UserRow | null }
  /** A Telegram name with no linked wallet (never joined, or joined without linking): offer a claim link. */
  | { kind: "unlinked"; username: string; user: UserRow | null }
  | { kind: "self" }
  | { kind: "invalid"; error: string }

const USERNAME = /^@?([A-Za-z0-9_]{3,32})$/

/**
 * Turn whatever the sender typed into a destination: a 0x address, or a Telegram @username looked up
 * case-insensitively with or without the "@". Never invents an address for someone who hasn't linked one.
 */
export function resolveRecipient(store: Store, sender: UserRow, raw: string | undefined | null): Resolved {
  const v = (raw ?? "").trim()
  if (!v) return { kind: "invalid", error: "Who is it for? Use @username or a 0x address." }
  if (/^0x/i.test(v)) {
    if (!isAddress(v, { strict: false })) return { kind: "invalid", error: `"${v}" is not a valid 0x address.` }
    if (sender.address && v.toLowerCase() === sender.address.toLowerCase()) return { kind: "self" }
    const user = store.findByAddress(v)
    return { kind: "wallet", address: v as Address, label: user?.username ? "@" + user.username : `${v.slice(0, 6)}…${v.slice(-4)}`, user }
  }
  const m = USERNAME.exec(v)
  if (!m) return { kind: "invalid", error: `"${v}" doesn't look like @username or a 0x address.` }
  const name = m[1]
  const user = store.findByUsername(name)
  if (user && user.tg_id === sender.tg_id) return { kind: "self" }
  if (user?.address) {
    if (sender.address && user.address.toLowerCase() === sender.address.toLowerCase()) return { kind: "self" }
    return { kind: "wallet", address: user.address as Address, label: "@" + (user.username ?? name), user }
  }
  return { kind: "unlinked", username: user?.username ?? name, user }
}
