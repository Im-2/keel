import { zeroAddress, type Address } from "viem"
import { parseUnits18 } from "@keel/shared"
import type { ChainService } from "./chain"
import type { Config } from "./config"
import type { ChainEventRow, IntentRow, Store, UserRow } from "./db"
import { nameOf } from "./completion"
import { CONFIRMATIONS } from "./watcher"

/** One line of someone's history, the same for /history in chat and the Mini App's Activity tab. */
export interface HistoryItem {
  id: string
  type:
    | "borrow" | "repay" | "add_collateral" | "fund_reserve" | "withdraw_reserve" | "protect_config" | "close" | "protected"
    | "send" | "received" | "pay_request" | "create_claim" | "claim_claimed" | "claim_received" | "claim_refunded"
  /** pending: broadcast, waiting for a receipt. failed: mined but reverted. */
  status: "confirmed" | "pending" | "failed"
  /** 18-decimal integer string. */
  amount: string | null
  asset: "MUSD" | "BTC" | null
  /** "@bob", a first name, or a short address. */
  counterparty: string | null
  memo: string | null
  tx: string | null
  at: number
  /** Extra numbers some rows show (protection ratios, settings). */
  params: Record<string, string>
}

export interface HistoryDeps {
  config: Pick<Config, "network" | "deployment">
  store: Store
  chain: ChainService
  /** Explorer API base (Blockscout v2); injectable for tests. Null disables the explorer backfill. */
  explorerApi?: string | null
  fetch?: typeof fetch
}

const EXPLORER_API: Record<string, string> = { testnet: "https://api.explorer.test.mezo.org/api/v2", mainnet: "https://api.explorer.mezo.org/api/v2" }
const BTC_TYPES = new Set(["add_collateral", "fund_reserve", "withdraw_reserve"])

/** Builds history from our intents plus the on-chain ledger the block watcher keeps, backfilling a wallet once. */
export class History {
  private guardians = new Map<string, Address | null>()
  private backfilling = new Map<string, Promise<void>>()
  constructor(private d: HistoryDeps) {}

  async feed(user: UserRow, opts: { limit?: number; offset?: number } = {}): Promise<{ items: HistoryItem[]; more: boolean }> {
    const { store } = this.d
    const limit = Math.min(opts.limit ?? 10, 50)
    const offset = Math.max(opts.offset ?? 0, 0)
    const wallet = user.address?.toLowerCase() ?? null
    if (wallet) await this.backfill(wallet).catch(() => undefined)

    const intents = store.listIntents(user.tg_id, 300)
    const events = wallet ? store.eventsFor(wallet, 400) : []
    const byTx = new Map<string, ChainEventRow[]>()
    for (const e of events) byTx.set(e.tx, [...(byTx.get(e.tx) ?? []), e])
    const intentTx = new Set(intents.filter((i) => i.tx_hash).map((i) => i.tx_hash!.toLowerCase()))
    const guardian = wallet ? await this.guardianOf(wallet) : null

    const items: HistoryItem[] = []
    for (const i of intents) {
      const it = this.fromIntent(i, byTx)
      if (it) items.push(it)
    }
    for (const e of events) {
      if (intentTx.has(e.tx)) continue
      const it = this.fromEvent(e, byTx.get(e.tx) ?? [], guardian)
      if (it) items.push(it)
    }
    items.sort((a, b) => b.at - a.at || (a.status === "pending" ? -1 : 0))
    return { items: items.slice(offset, offset + limit), more: items.length > offset + limit }
  }

  private fromIntent(i: IntentRow, byTx: Map<string, ChainEventRow[]>): HistoryItem | null {
    // unsigned intents are not history; a broadcast one shows as pending until its receipt arrives
    if (i.status === "pending" && !i.tx_hash) return null
    if (i.status === "failed" && !i.tx_hash) return null
    const p = i.params as Record<string, unknown>
    const str = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]))
    let amount: string | null = str("amount") || null
    if (i.type === "pay_request" && amount) amount = parseUnits18(amount).toString() // stored as a decimal string
    const onChain = i.tx_hash ? byTx.get(i.tx_hash.toLowerCase()) : undefined
    const type: HistoryItem["type"] = i.type === "withdraw_reserve" ? "withdraw_reserve" : (i.type as HistoryItem["type"])
    return {
      id: i.id,
      type,
      status: i.status === "done" ? "confirmed" : i.status === "failed" ? "failed" : "pending",
      amount,
      asset: BTC_TYPES.has(i.type) ? "BTC" : i.type === "protect_config" || i.type === "close" ? null : "MUSD",
      counterparty: i.type === "send" ? str("label") || null : i.type === "create_claim" ? str("forName") || null : null,
      memo: str("memo") || null,
      tx: i.tx_hash,
      at: onChain?.[0]?.at ?? i.created_at,
      params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])),
    }
  }

  private fromEvent(e: ChainEventRow, sameTx: ChainEventRow[], guardian: Address | null): HistoryItem | null {
    const { store, config } = this.d
    const pay = config.deployment.keel?.pay?.toLowerCase()
    const cp = e.counterparty
    const own = !!cp && (cp === zeroAddress || cp === guardian?.toLowerCase())
    const who = cp ? nameOf(store.findByAddress(cp), cp) : null
    const base = { id: `${e.tx}:${e.log_index}`, status: "confirmed" as const, amount: e.amount, asset: "MUSD" as const, memo: null, tx: e.tx, at: e.at, params: e.data }
    switch (e.kind) {
      case "transfer_in":
        if (own) return { ...base, type: "borrow", counterparty: null }
        if (cp === pay) return sameTx.some((x) => x.kind === "link_cancelled") ? { ...base, type: "claim_refunded", counterparty: null } : { ...base, type: "claim_received", counterparty: null }
        return { ...base, type: "received", counterparty: who }
      case "transfer_out":
        if (own) return { ...base, type: "repay", counterparty: null }
        if (cp === pay) return sameTx.some((x) => x.kind === "link_created") ? null : { ...base, type: "create_claim", counterparty: null }
        return { ...base, type: "send", counterparty: who }
      case "link_created":
        return { ...base, type: "create_claim", counterparty: null }
      case "link_claimed":
        return { ...base, type: "claim_claimed", counterparty: who }
      case "protected":
        return { ...base, type: "protected", asset: "BTC", counterparty: null }
      default:
        return null // link_cancelled: the refund transfer in the same tx is the row people care about
    }
  }

  private async guardianOf(wallet: string) {
    if (!this.guardians.has(wallet)) this.guardians.set(wallet, await this.d.chain.guardianOf(wallet as Address).catch(() => null))
    return this.guardians.get(wallet) ?? null
  }

  /**
   * First look at a wallet: load its past MUSD transfers (explorer API, else recent RPC logs) and guardian
   * protections into the ledger. Only blocks the watcher has already passed are written, so a backfill can never
   * swallow a notification the watcher is about to send.
   */
  backfill(wallet: string): Promise<void> {
    const { store } = this.d
    if (store.getKv(`hist:backfilled:${wallet}`)) return Promise.resolve()
    const running = this.backfilling.get(wallet)
    if (running) return running
    const job = (async () => {
      const cursor = store.getKv("watch_block")
      const limit = cursor ? BigInt(cursor) : (await this.d.chain.blockNumber()) - CONFIRMATIONS
      let ok = await this.explorerBackfill(wallet, limit).catch(() => false)
      if (!ok) ok = await this.rpcBackfill(wallet, limit).catch(() => false)
      await this.protectedBackfill(wallet, limit).catch(() => undefined)
      if (ok) store.setKv(`hist:backfilled:${wallet}`, String(limit))
    })().finally(() => this.backfilling.delete(wallet))
    this.backfilling.set(wallet, job)
    return job
  }

  private async explorerBackfill(wallet: string, limit: bigint): Promise<boolean> {
    const base = this.d.explorerApi === undefined ? EXPLORER_API[this.d.config.network] : this.d.explorerApi
    if (!base) return false
    const musd = this.d.config.deployment.musd.musd.toLowerCase()
    const f = this.d.fetch ?? fetch
    let query = `type=ERC-20&token=${musd}`
    for (let page = 0; page < 4; page++) {
      const r = await f(`${base}/addresses/${wallet}/token-transfers?${query}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return page > 0
      const j = (await r.json()) as {
        items: Array<{ transaction_hash: string; log_index: number; block_number: number; timestamp: string; from: { hash: string }; to: { hash: string }; total: { value: string }; token: { address: string } }>
        next_page_params: Record<string, string | number> | null
      }
      for (const t of j.items) {
        if (t.token.address.toLowerCase() !== musd || BigInt(t.block_number) > limit) continue
        const row = { tx: t.transaction_hash, log_index: t.log_index, amount: t.total.value, block: t.block_number, at: Math.floor(Date.parse(t.timestamp) / 1000), data: {} }
        if (t.from.hash.toLowerCase() === wallet) this.d.store.recordEvent({ ...row, wallet, kind: "transfer_out", counterparty: t.to.hash })
        if (t.to.hash.toLowerCase() === wallet) this.d.store.recordEvent({ ...row, wallet, kind: "transfer_in", counterparty: t.from.hash })
      }
      if (!j.next_page_params) break
      query = `type=ERC-20&token=${musd}&` + new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)] as [string, string])).toString()
    }
    return true
  }

  /** Fallback: the last ~3 days of logs straight from the RPC, in ranges it accepts. */
  private async rpcBackfill(wallet: string, limit: bigint): Promise<boolean> {
    const span = 9_000n
    for (let to = limit, k = 0; k < 7 && to > 0n; k++, to -= span + 1n) {
      const from = to > span ? to - span : 0n
      for (const t of await this.d.chain.musdTransfers([wallet as Address], from, to)) {
        const at = await this.d.chain.blockTime(t.block)
        const row = { tx: t.tx, log_index: t.logIndex, amount: t.value.toString(), block: Number(t.block), at, data: {} }
        if (t.from.toLowerCase() === wallet) this.d.store.recordEvent({ ...row, wallet, kind: "transfer_out", counterparty: t.to })
        if (t.to.toLowerCase() === wallet) this.d.store.recordEvent({ ...row, wallet, kind: "transfer_in", counterparty: t.from })
      }
    }
    return true
  }

  private async protectedBackfill(wallet: string, limit: bigint) {
    const g = await this.guardianOf(wallet)
    if (!g) return
    const span = 9_000n
    for (let to = limit, k = 0; k < 3 && to > 0n; k++, to -= span + 1n) {
      const from = to > span ? to - span : 0n
      for (const e of await this.d.chain.protectedEvents([g], from, to)) {
        if (e.block === undefined) continue
        this.d.store.recordEvent({
          tx: e.tx, log_index: e.logIndex ?? 0, wallet, kind: "protected", counterparty: g, amount: e.btcAdded.toString(), block: Number(e.block), at: await this.d.chain.blockTime(e.block),
          data: { btcAdded: e.btcAdded.toString(), musdRepaid: e.musdRepaid.toString(), icrBefore: e.icrBefore.toString(), icrAfter: e.icrAfter.toString() },
        })
      }
    }
  }
}
