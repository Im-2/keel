import { zeroAddress, type Address } from "viem"
import { explorerTx, fmtBtc, fmtIcr, fmtMusd } from "@keel/shared"
import type { ChainService, PayEvent, ProtectedEvent, TransferEvent } from "./chain"
import type { Config } from "./config"
import type { Store, UserRow } from "./db"
import { notifyOrQueue, type Notifier } from "./notify"
import { esc } from "./format"
import { nameOf, receivedKey, type Completion } from "./completion"
import type { LiveBus } from "./live"
import type { Splits } from "./splits"

/** Blocks behind the head we treat as settled: public RPC nodes disagree by a few blocks. */
export const CONFIRMATIONS = 3n
/** Every scan re-reads this many already-scanned blocks, so a node that answered from behind can't make us miss logs. */
export const OVERLAP = 30n
/** RPCs cap getLogs ranges; a long outage is caught up over several ticks. */
export const MAX_SPAN = 5_000n
const CURSOR = "watch_block"
const GUARDIAN_RECHECK_MS = 5 * 60_000

export interface WatcherDeps {
  config: Pick<Config, "network" | "miniappUrl" | "deployment">
  store: Store
  chain: ChainService
  notifier: Notifier
  live: LiveBus
  completion: Completion
  splits?: Splits
}

/**
 * One shared watcher for every linked wallet: on each tick it reads MUSD transfers, KeelPay link events and
 * guardian protections since the last scanned block, records them in the ledger (which also feeds /history and the
 * Activity tab), sends each notice exactly once, settles sends the app couldn't confirm, and pings open Mini Apps.
 *
 * The cursor lives in the database (mirrored), so restarts neither replay old notices nor skip blocks.
 */
export class BlockWatcher {
  private guardians = new Map<string, { g: Address | null; at: number }>()
  private balPrints = new Map<number, string>()
  private posPrints = new Map<number, string>()
  private lastPrice: bigint | null = null
  private ticks = 0

  constructor(private d: WatcherDeps) {}

  /** Scan new blocks; returns how many ledger rows were added (for the status page and tests). */
  async tick(): Promise<{ from: bigint; to: bigint; added: number } | null> {
    const { store, chain } = this.d
    this.ticks++
    const head = await chain.blockNumber()
    const safe = head - CONFIRMATIONS
    const saved = store.getKv(CURSOR)
    if (saved === null) {
      // first run: start from now (history before this comes from the backfill, without notifications)
      store.setKv(CURSOR, safe.toString())
      await this.liveChecks()
      return null
    }
    const cursor = BigInt(saved)
    const from = cursor + 1n > OVERLAP ? cursor + 1n - OVERLAP : 0n
    const to = safe < cursor + MAX_SPAN ? safe : cursor + MAX_SPAN
    if (to < from || to <= cursor - OVERLAP) {
      await this.liveChecks()
      return null
    }

    const users = store.boundUsers()
    const byWallet = new Map(users.map((u) => [u.address!.toLowerCase(), u]))
    const byGuardian = await this.guardianMap(users)
    const [transfers, pays, prots] = await Promise.all([
      chain.musdTransfers([...byWallet.keys()] as Address[], from, to),
      chain.payEvents(from, to),
      chain.protectedEvents([...byGuardian.keys()] as Address[], from, to),
    ])

    let added = 0
    const payByTx = new Map<string, PayEvent[]>()
    for (const p of pays) payByTx.set(p.tx.toLowerCase(), [...(payByTx.get(p.tx.toLowerCase()) ?? []), p])
    const order = (a: { block?: bigint; logIndex?: number }, b: { block?: bigint; logIndex?: number }) =>
      Number((a.block ?? 0n) - (b.block ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0)

    for (const p of [...pays].sort(order)) added += await this.onPay(p, byWallet)
    for (const t of [...transfers].sort(order)) added += await this.onTransfer(t, byWallet, byGuardian, payByTx)
    for (const e of [...prots].sort(order)) added += await this.onProtected(e, byGuardian)

    // only now is [from, to] fully processed
    store.setKv(CURSOR, to.toString())
    // about once an hour (sooner while someone watches): the one automatic split reminder after 24h
    if (this.ticks % 60 === 1) await this.d.splits?.autoRemind().catch(() => undefined)
    await this.reconcileSubmitted()
    await this.liveChecks()
    return { from, to, added }
  }

  /** Wallet -> guardian, cached: a guardian never changes once deployed, a missing one is re-checked every few minutes. */
  private async guardianMap(users: UserRow[]) {
    const out = new Map<string, UserRow>()
    for (const u of users) {
      const w = u.address!.toLowerCase()
      let c = this.guardians.get(w)
      if (!c || (!c.g && Date.now() - c.at > GUARDIAN_RECHECK_MS)) {
        const g = await this.d.chain.guardianOf(u.address as Address).catch(() => null)
        this.guardians.set(w, (c = { g, at: Date.now() }))
      }
      if (c.g) out.set(c.g.toLowerCase(), u)
    }
    return out
  }

  private async onTransfer(t: TransferEvent, byWallet: Map<string, UserRow>, byGuardian: Map<string, UserRow>, payByTx: Map<string, PayEvent[]>) {
    const { store, chain, live } = this.d
    const fromU = byWallet.get(t.from.toLowerCase())
    const toU = byWallet.get(t.to.toLowerCase())
    if (!fromU && !toU) return 0
    const at = await chain.blockTime(t.block)
    let added = 0
    const row = { tx: t.tx, log_index: t.logIndex, amount: t.value.toString(), block: Number(t.block), at, data: {} }
    // a bill-split payment, made in Keel or from any wallet: mark the share paid (idempotent, once per tx)
    if (toU) await this.d.splits?.matchTransfer(t)

    // sender side first: settling their intent sends the recipient a notice with the memo, which the
    // recipient side below then recognises (same dedup key) instead of sending a plainer duplicate
    if (fromU && store.recordEvent({ ...row, wallet: t.from, kind: "transfer_out", counterparty: t.to })) {
      added++
      await this.settleSend(fromU, t, at)
      live.publish(fromU.tg_id, { reason: "sent", tx: t.tx })
    }
    if (toU && store.recordEvent({ ...row, wallet: t.to, kind: "transfer_in", counterparty: t.from })) {
      added++
      await this.noticeReceived(toU, t, byGuardian, payByTx.get(t.tx.toLowerCase()) ?? [])
    }
    return added
  }

  /** Money in from someone else. Loan proceeds (guardian or mint) and protocol flows are not "received". */
  private async noticeReceived(u: UserRow, t: TransferEvent, byGuardian: Map<string, UserRow>, pays: PayEvent[]) {
    const { store, notifier, live, config } = this.d
    const from = t.from.toLowerCase()
    const own = byGuardian.get(from)?.tg_id === u.tg_id
    const protocol = from === zeroAddress || Object.values(config.deployment.musd).some((a) => typeof a === "string" && a.toLowerCase() === from)
    if (t.value === 0n || own || protocol) return live.publish(u.tg_id, { reason: "balance", tx: t.tx })
    if (!store.claimNotice(receivedKey(t.tx, t.to))) return live.publish(u.tg_id, { reason: "balance", tx: t.tx })

    const amount = fmtMusd(t.value, 2)
    const fromPay = config.deployment.keel?.pay && from === config.deployment.keel.pay.toLowerCase()
    let text: string
    let toast: string
    if (fromPay && pays.some((p) => p.kind === "cancelled")) {
      text = `↩️ Your claim link was refunded: <b>${amount}</b> is back in your wallet.`
      toast = `Claim link refunded: ${amount}`
    } else if (fromPay) {
      text = `🎁 You claimed <b>${amount}</b> from a claim link.`
      toast = `Claimed ${amount}`
    } else {
      const who = nameOf(store.findByAddress(t.from), t.from)
      text = `💸 You received <b>${amount}</b> from <b>${esc(who)}</b>.`
      toast = `Received ${amount} from ${who}`
    }
    await notifyOrQueue(store, notifier, u.tg_id, text, {
      buttons: [[{ text: "View transaction", url: explorerTx(config.network, t.tx) }, { text: "Open Keel", webApp: `${config.miniappUrl}/#/activity` }]],
    })
    live.publish(u.tg_id, { reason: "received", tx: t.tx, toast })
  }

  /**
   * A transfer out of a linked wallet that matches a send the user started in Keel but never confirmed (the app
   * closed, or a lagging RPC node said "not found"): settle it now, so both sides hear about it.
   */
  private async settleSend(u: UserRow, t: TransferEvent, at: number) {
    const { store, completion } = this.d
    if (store.intentByTx(t.tx)) return
    const match = store.pendingIntents("send").find((i) => {
      const p = i.params as Record<string, string>
      return i.tg_id === u.tg_id && p.to?.toLowerCase() === t.to.toLowerCase() && p.amount === t.value.toString() && (!i.tx_hash || i.tx_hash.toLowerCase() === t.tx.toLowerCase()) && i.created_at <= at + 120 && at - i.created_at < 3 * 86400
    })
    if (!match) return
    store.completeIntent(match.id, "done", t.tx)
    await completion.afterIntent(match, t.tx)
  }

  private async onPay(p: PayEvent, byWallet: Map<string, UserRow>) {
    const { store, chain, notifier, live, config } = this.d
    const at = await chain.blockTime(p.block)
    const base = { tx: p.tx, log_index: p.logIndex, amount: p.amount.toString(), block: Number(p.block), at }
    if (p.kind === "created" || p.kind === "cancelled") {
      const u = p.sender && byWallet.get(p.sender.toLowerCase())
      if (!u) return 0
      if (!store.recordEvent({ ...base, wallet: p.sender!, kind: p.kind === "created" ? "link_created" : "link_cancelled", counterparty: p.link, data: { link: p.link } })) return 0
      live.publish(u.tg_id, { reason: p.kind === "created" ? "balance" : "link_cancelled", tx: p.tx })
      return 1
    }
    // claimed: tell whoever made the link (we know them from its LinkCreated row)
    const owner = store.linkOwner(p.link)
    const u = owner && byWallet.get(owner)
    if (!u) return 0
    if (!store.recordEvent({ ...base, wallet: owner!, kind: "link_claimed", counterparty: p.to ?? null, data: { link: p.link } })) return 0
    const who = p.to ? nameOf(store.findByAddress(p.to), p.to) : "someone"
    if (store.claimNotice(`lc:${p.tx.toLowerCase()}`)) {
      await notifyOrQueue(store, notifier, u.tg_id, `🎁 Your claim link for <b>${fmtMusd(p.amount, 2)}</b> was claimed by <b>${esc(who)}</b>.`, { buttonText: "View transaction", buttonUrl: explorerTx(config.network, p.tx) })
    }
    live.publish(u.tg_id, { reason: "link_claimed", tx: p.tx, toast: `${who} claimed your ${fmtMusd(p.amount, 2)} link` })
    return 1
  }

  private async onProtected(e: ProtectedEvent, byGuardian: Map<string, UserRow>) {
    const { store, chain, notifier, live, config } = this.d
    const u = byGuardian.get(e.guardian.toLowerCase())
    if (!u || e.block === undefined) return 0
    const at = await chain.blockTime(e.block)
    const fresh = store.recordEvent({
      tx: e.tx, log_index: e.logIndex ?? 0, wallet: u.address!, kind: "protected", counterparty: e.guardian, amount: e.btcAdded.toString(), block: Number(e.block), at,
      data: { btcAdded: e.btcAdded.toString(), musdRepaid: e.musdRepaid.toString(), icrBefore: e.icrBefore.toString(), icrAfter: e.icrAfter.toString() },
    })
    if (!fresh) return 0
    store.setKv("stat:protections", String(Number(store.getKv("stat:protections") ?? "0") + 1))
    const did = [e.btcAdded > 0n ? `added ${fmtBtc(e.btcAdded, 5)}` : "", e.musdRepaid > 0n ? `repaid ${fmtMusd(e.musdRepaid, 2)}` : ""].filter(Boolean).join(" and ")
    if (!u.settings.muted && store.claimNotice(`prot:${e.tx.toLowerCase()}`)) {
      await notifier.send(u.tg_id, `🛡 <b>Guardian protected your loan</b>: ${did} from your reserve.\nRatio ${fmtIcr(e.icrBefore)} → <b>${fmtIcr(e.icrAfter)}</b>.`, {
        buttonText: "View transaction",
        buttonUrl: explorerTx(config.network, e.tx),
      })
    }
    live.publish(u.tg_id, { reason: "protected", tx: e.tx, toast: `Guardian ${did}: ratio ${fmtIcr(e.icrAfter)}` })
    return 1
  }

  /** Remember the latest fingerprint; true when it differs from a previous one (the first sighting is not a change). */
  private changed(m: Map<number, string>, tgId: number, print: string) {
    const prev = m.get(tgId)
    m.set(tgId, print)
    return prev !== undefined && prev !== print
  }

  /** Transactions the app reported as broadcast but never confirmed: check their receipts again. */
  private async reconcileSubmitted() {
    const { store, completion } = this.d
    const now = Math.floor(Date.now() / 1000)
    for (const i of store.pendingIntents().slice(0, 10)) {
      if (!i.tx_hash || now - i.created_at > 86400) continue
      await completion.confirm(i, i.tx_hash).catch(() => undefined)
    }
  }

  /**
   * For people with Keel open right now: native BTC moves and trove changes leave no MUSD logs, so compare a cheap
   * fingerprint (balances every tick, the full position every third) and the oracle price, and ping on change.
   */
  private async liveChecks() {
    const { store, chain, live } = this.d
    const online = live.online()
    if (!online.length) return
    const sys = await chain.system().catch(() => null)
    if (sys && this.lastPrice !== null && sys.price !== this.lastPrice) live.broadcast({ reason: "price" })
    if (sys) this.lastPrice = sys.price
    const full = this.ticks % 3 === 0
    await Promise.all(
      online.map(async (tgId) => {
        const u = store.getUser(tgId)
        if (!u?.address) return
        try {
          const a = u.address as Address
          const [btc, musd] = await Promise.all([chain.balance(a), chain.musdBalance(a)])
          if (this.changed(this.balPrints, tgId, `${btc}:${musd}`)) live.publish(tgId, { reason: "balance" })
          if (full) {
            const v = await chain.view(a)
            const pos = `${v.trove?.coll ?? 0n}:${v.trove?.debt ?? 0n}:${v.guardian?.reserveBTC ?? 0n}:${v.guardian?.enabled ?? false}:${v.guardian?.minIcr ?? 0n}`
            if (this.changed(this.posPrints, tgId, pos)) live.publish(tgId, { reason: "position" })
          }
        } catch {
          /* next tick */
        }
      }),
    )
  }
}
