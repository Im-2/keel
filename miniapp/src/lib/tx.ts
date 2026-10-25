import type { ActivityItem, IntentDto } from "./api"

export class TxRevertedError extends Error {
  constructor(readonly hash: string) {
    super("The transaction reverted on Mezo, so nothing changed (only the gas fee was spent).")
  }
}

export class TxTimeoutError extends Error {
  constructor(readonly hash: string) {
    super("Not confirmed yet. It may still go through: Keel keeps checking and will message you.")
  }
}

type ReceiptLike = { status: "success" | "reverted" }

/**
 * Wait until the transaction is mined *successfully*. Public Mezo RPC nodes lag each other and sometimes answer
 * "not found" for a mined transaction, so a miss is never final: keep asking until the timeout.
 */
export async function waitForSuccess(
  getReceipt: (hash: `0x${string}`) => Promise<ReceiptLike | null>,
  hash: `0x${string}`,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const end = now() + (opts.timeoutMs ?? 180_000)
  for (;;) {
    const r = await getReceipt(hash).catch(() => null)
    if (r) {
      if (r.status === "success") return
      throw new TxRevertedError(hash)
    }
    if (now() >= end) throw new TxTimeoutError(hash)
    await sleep(opts.intervalMs ?? 1500)
  }
}

/** Why a transaction didn't happen, in words a person can act on. */
export function txFailureReason(e: unknown): string {
  if (e instanceof TxRevertedError || e instanceof TxTimeoutError) return e.message
  const m = `${(e as { shortMessage?: string })?.shortMessage ?? ""} ${(e as Error)?.message ?? ""} ${(e as { details?: string })?.details ?? ""}`
  if (/user rejected|denied|rejected the request|user cancel/i.test(m)) return "You rejected the request in your wallet. Nothing was sent."
  if (/insufficient funds|gas required exceeds|not enough (btc|gas)/i.test(m)) return "Not enough BTC in your wallet to pay the gas fee."
  if (/exceeds balance|insufficient balance|transfer amount exceeds/i.test(m)) return "Insufficient balance: your wallet doesn't hold that much."
  if (/revert/i.test(m)) return "The transaction would revert on Mezo, so it was not sent."
  return (m.trim().split("\n")[0] || "Something went wrong").slice(0, 200)
}

/** The row Activity shows the moment the wallet broadcasts, before any receipt. */
export function pendingItem(intent: IntentDto, tx: string, now = Math.floor(Date.now() / 1000)): ActivityItem {
  const p = intent.params
  const btc = intent.type === "add_collateral" || intent.type === "fund_reserve" || intent.type === "withdraw_reserve"
  return {
    id: intent.id,
    type: intent.type,
    status: "pending",
    amount: p.amount ?? null,
    asset: btc ? "BTC" : intent.type === "protect_config" || intent.type === "close" ? null : "MUSD",
    counterparty: intent.type === "send" ? p.label ?? null : intent.type === "create_claim" ? p.forName ?? null : null,
    memo: p.memo || null,
    tx,
    at: now,
    params: p,
  }
}

/** Put (or replace) a row at the top of a cached feed without disturbing the rest. */
export function upsertTop(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  return [item, ...items.filter((i) => i.id !== item.id && (!item.tx || i.tx !== item.tx))]
}

/** A cached row's new state once the receipt is known (kept until the server's feed agrees). */
export const settle = (items: ActivityItem[], id: string, status: "confirmed" | "failed") => items.map((i) => (i.id === id ? { ...i, status } : i))
