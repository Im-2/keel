import { randomBytes } from "node:crypto"
import { isAddress, type Address } from "viem"
import { E18, SplitError, fmtMusd, parseUnits18, percentShares, requestedShares, splitLink, equalShares, type SplitMode } from "@keel/shared"
import type { Config } from "./config"
import type { IntentRow, ShareRow, SplitRow, Store, UserRow } from "./db"
import { notifyOrQueue, type Notifier } from "./notify"
import { esc } from "./format"
import { nameOf, receivedKey } from "./completion"
import type { LiveBus } from "./live"

/** Telegram plumbing the split card needs (bot.api in production, a recorder in tests). */
export interface SplitTelegram {
  post(chatId: number, html: string, markup: unknown): Promise<number | null>
  edit(chatId: number, messageId: number, html: string, markup: unknown): Promise<void>
}

export interface SplitDeps {
  config: Pick<Config, "network" | "miniappUrl" | "botUsername" | "miniappShortName">
  store: Store
  notifier: Notifier
  live?: LiveBus
}

/** One person in a new split: a @handle or a 0x address, optionally with their own amount or percentage. */
export interface PersonInput {
  raw: string
  amount?: bigint
  /** Basis points (50% = 5000). */
  bps?: number
}

export interface NewSplit {
  total: bigint
  title: string
  people: PersonInput[]
  includeMe: boolean
  dueAt?: number | null
  /** Where the card goes; defaults to the requester's private chat. */
  chatId?: number | null
}

export type SplitResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }
const fail = (error: string, code?: string): { ok: false; error: string; code?: string } => ({ ok: false, error, code })

/** Split ids are letters and digits only: they travel inside split_<id>_<idx> deep links. */
const ALNUM = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const splitId = () => [...randomBytes(8)].map((b) => ALNUM[b % ALNUM.length]).join("")

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const m2 = (wei: string | bigint) => fmtMusd(BigInt(wei), 2)

/**
 * Parse "/split 100 @ada @bob:30 @chidi 20% dinner due friday notme" into people, amounts and options.
 * Amount forms per person: "@ada:30", "@ada=30", "@ada 30", "@ada 30%". Everything left over is the title.
 */
export function parseSplitArgs(text: string, now = new Date()): { total: bigint; people: PersonInput[]; title: string; includeMe: boolean; dueAt: number | null } {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) throw new SplitError("Usage: /split 100 @ada @bob dinner")
  const totalTok = tokens.shift()!.replace(/^\$/, "").replace(/(musd|\$)$/i, "")
  let total: bigint
  try {
    total = parseUnits18(totalTok)
  } catch {
    throw new SplitError(`Start with the total, e.g. /split 100 @ada @bob dinner`)
  }
  if (total <= 0n) throw new SplitError("The total must be more than zero.")
  const people: PersonInput[] = []
  const title: string[] = []
  let includeMe = true
  let dueAt: number | null = null
  const amountOf = (t: string): { amount?: bigint; bps?: number } | null => {
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(t)
    if (pct) return { bps: Math.round(Number(pct[1]) * 100) }
    if (/^\$?\d+(?:[.,]\d+)?$/.test(t)) return { amount: parseUnits18(t.replace("$", "").replace(",", ".")) }
    return null
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const low = t.toLowerCase().replace(/[,.;]$/, "")
    if (["notme", "-me", "excludeme", "without-me"].includes(low)) {
      includeMe = false
      continue
    }
    if ((low === "without" || low === "exclude" || low === "excluding") && tokens[i + 1]?.toLowerCase().replace(/[,.;]$/, "") === "me") {
      includeMe = false
      i++
      continue
    }
    if (low === "due" && tokens[i + 1]) {
      const d = parseDue(tokens.slice(i + 1, i + 4).join(" "), now)
      if (d) {
        dueAt = d.at
        i += d.used
        continue
      }
    }
    const who = /^(@[A-Za-z0-9_]{3,32}|0x[0-9a-fA-F]{40})(?:[:=](.+))?[,;]?$/.exec(t)
    if (who) {
      const p: PersonInput = { raw: who[1] }
      const inline = who[2] ? amountOf(who[2]) : null
      const next = !inline && tokens[i + 1] ? amountOf(tokens[i + 1].replace(/[,;]$/, "")) : null
      Object.assign(p, inline ?? next ?? {})
      if (next) i++
      people.push(p)
      continue
    }
    if (["with", "between", "among", "amongst", "and", "&", "for", "-"].includes(low) && title.length === 0) continue
    title.push(t)
  }
  return { total, people, title: title.join(" ").replace(/^for /i, "").slice(0, 60), includeMe, dueAt }
}

/** "friday", "tomorrow", "in 3 days", "2026-11-01" -> end of that day (UTC). */
export function parseDue(text: string, now = new Date()): { at: number; used: number } | null {
  const t = text.toLowerCase()
  const endOf = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) / 1000)
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (iso) return { at: endOf(new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))), used: 1 }
  if (t.startsWith("tomorrow")) return { at: endOf(new Date(now.getTime() + 86_400_000)), used: 1 }
  if (t.startsWith("today")) return { at: endOf(now), used: 1 }
  const inDays = /^in (\d{1,3}) days?/.exec(t)
  if (inDays) return { at: endOf(new Date(now.getTime() + +inDays[1] * 86_400_000)), used: 3 }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
  const wd = days.findIndex((d) => t.startsWith(d))
  if (wd >= 0) {
    const ahead = ((wd - now.getUTCDay() + 7) % 7) || 7
    return { at: endOf(new Date(now.getTime() + ahead * 86_400_000)), used: 1 }
  }
  return null
}

export interface ShareView {
  idx: number
  label: string
  amount: string
  status: "pending" | "paid"
  tx: string | null
  paidAt: number | null
  isMe: boolean
  /** Creator only: link that opens this person's pay screen (to share with people Keel can't message). */
  link?: string
}
export interface SplitView {
  id: string
  title: string
  total: string
  mine: string
  includeMe: boolean
  status: SplitRow["status"]
  dueAt: number | null
  createdAt: number
  creator: { name: string; isMe: boolean }
  shares: ShareView[]
  collected: string
  remaining: string
  /** The viewer's own pending share, if any (what Pay pays). */
  myShare: number | null
}

/** Bill splits: who owes what, live status from on-chain payments, the chat card, reminders. */
export class Splits {
  private tg: SplitTelegram | null = null
  constructor(private d: SplitDeps) {}

  attach(tg: SplitTelegram) {
    this.tg = tg
  }

  link(id: string, idx?: number) {
    return splitLink(this.d.config.botUsername, this.d.config.miniappShortName, id, idx)
  }

  // ------------------------------------------------------------------ create / join / lock

  async create(creator: UserRow, input: NewSplit): Promise<SplitResult<{ split: SplitRow; notReached: string[] }>> {
    const { store } = this.d
    if (!creator.address) return fail("Link your wallet first: payments go to it.", "need_wallet")
    if (input.total <= 0n) return fail("The total must be more than zero.")
    const seen = new Set<string>()
    const people: Array<{ label: string; username: string | null; tg_id: number | null; address: string | null; amount?: bigint; bps?: number }> = []
    for (const p of input.people) {
      const raw = p.raw.trim()
      let row: (typeof people)[number]
      if (/^0x/i.test(raw)) {
        if (!isAddress(raw, { strict: false })) return fail(`"${raw}" is not a valid address.`)
        if (raw.toLowerCase() === creator.address.toLowerCase()) return fail("That's your own wallet: use “include me” for your share.")
        const u = store.findByAddress(raw)
        row = { label: u?.username ? "@" + u.username : short(raw), username: u?.username ?? null, tg_id: u?.tg_id ?? null, address: raw.toLowerCase() }
      } else {
        const m = /^@?([A-Za-z0-9_]{3,32})$/.exec(raw)
        if (!m) return fail(`"${raw}" doesn't look like @username or a 0x address.`)
        const u = store.findByUsername(m[1])
        if (u?.tg_id === creator.tg_id || m[1].toLowerCase() === creator.username?.toLowerCase()) return fail("You're the one asking: use “include me” for your own share.")
        row = { label: "@" + (u?.username ?? m[1]), username: (u?.username ?? m[1]).toLowerCase(), tg_id: u?.tg_id ?? null, address: u?.address?.toLowerCase() ?? null }
      }
      const key = row.username ?? row.address!
      if (seen.has(key)) continue
      seen.add(key)
      people.push({ ...row, amount: p.amount, bps: p.bps })
    }

    const id = splitId()
    const title = input.title.trim() || "Shared bill"
    const isGroup = (input.chatId ?? 0) < 0
    // a group split with nobody named: people join with "I'm in", the requester locks it
    if (!people.length) {
      if (!isGroup) return fail("Add at least one person, e.g. /split 90 @ada @bob dinner.")
      const split = store.createSplit({ id, creator_tg: creator.tg_id, creator_address: creator.address, title, total: input.total.toString(), mine: "0", include_me: input.includeMe ? 1 : 0, mode: "equal", status: "collecting", due_at: input.dueAt ?? null, chat_id: input.chatId ?? null }, [])
      await this.postCard(split)
      return { ok: true, value: { split, notReached: [] } }
    }

    let mine = 0n
    let amounts: bigint[]
    let mode = "equal"
    try {
      if (people.some((p) => p.amount !== undefined)) {
        mode = "amounts"
        if (people.some((p) => p.amount === undefined)) {
          // some amounts given: the rest share what's left equally
          const fixed = people.reduce((a, p) => a + (p.amount ?? 0n), 0n)
          const rest = people.filter((p) => p.amount === undefined).length + (input.includeMe ? 1 : 0)
          if (fixed >= input.total) throw new SplitError("The amounts you gave already reach the total.")
          const eq = equalShares(input.total - fixed, rest)
          let k = input.includeMe ? 1 : 0
          if (input.includeMe) mine = eq[0]
          amounts = people.map((p) => p.amount ?? eq[k++])
        } else {
          amounts = people.map((p) => p.amount!)
          const sum = amounts.reduce((a, b) => a + b, 0n)
          if (sum > input.total) throw new SplitError(`The shares add up to ${m2(sum)}, more than the ${m2(input.total)} total.`)
          if (!input.includeMe && sum !== input.total) throw new SplitError(`The shares add up to ${m2(sum)}, not ${m2(input.total)}.`)
          mine = input.total - sum
        }
      } else if (people.some((p) => p.bps !== undefined)) {
        mode = "percent"
        if (people.some((p) => p.bps === undefined)) throw new SplitError("Give a percentage for everyone, e.g. @ada 50% @bob 30%.")
        const theirs = people.reduce((a, p) => a + p.bps!, 0)
        const mineBps = 10_000 - theirs
        if (mineBps < 0) throw new SplitError(`The percentages add up to ${theirs / 100}%, more than 100%.`)
        if (!input.includeMe && mineBps !== 0) throw new SplitError(`The percentages add up to ${theirs / 100}%, not 100%.`)
        const all = percentShares(input.total, mineBps > 0 ? [mineBps, ...people.map((p) => p.bps!)] : people.map((p) => p.bps!))
        mine = mineBps > 0 ? all[0] : 0n
        amounts = mineBps > 0 ? all.slice(1) : all
      } else {
        const r = requestedShares(input.total, people.length, { kind: "equal" } as SplitMode, input.includeMe)
        mine = r.mine
        amounts = r.theirs
      }
    } catch (e) {
      return fail((e as Error).message)
    }

    const split = store.createSplit(
      { id, creator_tg: creator.tg_id, creator_address: creator.address, title, total: input.total.toString(), mine: mine.toString(), include_me: input.includeMe ? 1 : 0, mode, status: "open", due_at: input.dueAt ?? null, chat_id: input.chatId ?? creator.tg_id },
      people.map((p, i) => ({ label: p.label, username: p.username, tg_id: p.tg_id, address: p.address, amount: amounts[i].toString() })),
    )
    await this.postCard(split)
    const notReached = await this.askEveryone(split)
    this.ping(split, "split")
    return { ok: true, value: { split, notReached } }
  }

  /** "I'm in" on a group split that is still collecting people. */
  async join(id: string, u: UserRow): Promise<SplitResult<string>> {
    const { store } = this.d
    const split = store.getSplit(id)
    if (!split) return fail("This split no longer exists.")
    if (split.status !== "collecting") return fail("This split is already locked.")
    if (split.creator_tg === u.tg_id) return fail("You're organising this one: tap Lock when everyone's in.")
    const shares = store.sharesOf(id)
    if (shares.some((s) => s.tg_id === u.tg_id)) return fail("You're already in 👍")
    store.addShare(id, shares.length ? Math.max(...shares.map((s) => s.idx)) + 1 : 0, { label: nameOf(u, u.address), username: u.username, tg_id: u.tg_id, address: u.address, amount: "0" })
    await this.refreshCard(id)
    return { ok: true, value: "You're in ✅" }
  }

  /** Requester locks a collecting split: equal shares among everyone who joined (plus themselves if included). */
  async lock(id: string, byTg: number): Promise<SplitResult<SplitRow>> {
    const { store } = this.d
    const split = store.getSplit(id)
    if (!split) return fail("This split no longer exists.")
    if (split.creator_tg !== byTg) return fail("Only the person who asked can lock the split.")
    if (split.status !== "collecting") return fail("Already locked.")
    const shares = store.sharesOf(id)
    if (!shares.length) return fail("Nobody has joined yet.")
    const r = requestedShares(BigInt(split.total), shares.length, { kind: "equal" }, split.include_me === 1)
    shares.forEach((s, i) => store.updateShare(id, s.idx, { amount: r.theirs[i].toString() }))
    store.updateSplit(id, { status: "open", mine: r.mine.toString() })
    await this.refreshCard(id)
    const fresh = store.getSplit(id)!
    await this.askEveryone(fresh)
    this.ping(fresh, "split")
    return { ok: true, value: fresh }
  }

  async cancel(id: string, byTg: number): Promise<SplitResult<SplitRow>> {
    const { store } = this.d
    const split = store.getSplit(id)
    if (!split) return fail("This split no longer exists.")
    if (split.creator_tg !== byTg) return fail("Only the person who asked can cancel it.")
    if (split.status === "settled") return fail("It's already settled.")
    store.updateSplit(id, { status: "cancelled" })
    await this.refreshCard(id)
    this.ping(split, "split")
    return { ok: true, value: store.getSplit(id)! }
  }

  // ------------------------------------------------------------------ paying

  /** Who a share belongs to: their Telegram id, their username, or their linked wallet. */
  private owns(s: ShareRow, u: UserRow) {
    return (s.tg_id !== null && s.tg_id === u.tg_id) || (!!s.username && !!u.username && s.username === u.username.toLowerCase()) || (!!s.address && !!u.address && s.address === u.address.toLowerCase())
  }

  /** Start paying a share: checks it's theirs and unpaid, then makes the same review-and-sign intent as a send. */
  startPay(id: string, idx: number | null, payer: UserRow): SplitResult<IntentRow> {
    const { store } = this.d
    const split = store.getSplit(id)
    if (!split || split.status === "cancelled") return fail("This split was cancelled or doesn't exist.", "gone")
    if (split.creator_tg === payer.tg_id) return fail("That's your own split 🙂 Your share is already counted; this is for the others to pay.", "own")
    if (split.status === "collecting") return fail("This split isn't locked yet: wait for the organiser to tap Lock.", "collecting")
    const shares = store.sharesOf(id)
    const share = idx === null ? shares.find((s) => this.owns(s, payer) && s.status === "pending") ?? shares.find((s) => this.owns(s, payer)) : shares.find((s) => s.idx === idx)
    if (!share) return fail("You're not part of this split.", "not_participant")
    if (!this.owns(share, payer)) return fail(`This share is for ${share.label}.`, "not_participant")
    if (share.status === "paid") return fail("You've already paid your share — thanks! ✅", "paid")
    if (split.status === "settled") return fail("This split is already settled.", "paid")
    if (!payer.address) return fail("Link your wallet first, then pay.", "need_wallet")
    if (payer.address.toLowerCase() === split.creator_address) return fail("That's the requester's own wallet.", "own")
    // remember who they are, so on-chain payments from their wallet match even outside Keel
    if (share.tg_id === null || share.address === null) store.updateShare(id, share.idx, { tg_id: share.tg_id ?? payer.tg_id, address: share.address ?? payer.address.toLowerCase() })
    const creator = store.getUser(split.creator_tg)
    const intent = store.createIntent(payer.tg_id, "pay_split", {
      splitId: id, idx: share.idx, to: split.creator_address, amount: share.amount, label: nameOf(creator, split.creator_address), memo: split.title,
    })
    return { ok: true, value: intent }
  }

  /**
   * A confirmed payment for a share (from the app, or matched on-chain). Idempotent: the same transaction or an
   * already-paid share changes nothing and notifies nobody. Returns whether this call marked it paid.
   */
  async markPaid(id: string, idx: number, tx: string): Promise<boolean> {
    const { store, notifier, config } = this.d
    const split = store.getSplit(id)
    if (!split || !store.markSharePaid(id, idx, tx)) return false
    const share = store.sharesOf(id).find((s) => s.idx === idx)!
    // the generic "you received" notice would repeat this one
    store.claimNotice(receivedKey(tx, split.creator_address))
    for (const i of store.pendingIntents("pay_split")) {
      const p = i.params as Record<string, unknown>
      // close the review screens that never broadcast; one that sent its own tx settles itself (and hears it was extra)
      if (p.splitId === id && Number(p.idx) === idx && (!i.tx_hash || i.tx_hash.toLowerCase() === tx.toLowerCase())) store.completeIntent(i.id, "done", tx)
    }
    const shares = store.sharesOf(id)
    const pending = shares.filter((s) => s.status === "pending")
    const left = pending.reduce((a, s) => a + BigInt(s.amount), 0n)
    await notifyOrQueue(store, notifier, split.creator_tg, `💸 <b>${esc(share.label)}</b> paid <b>${m2(share.amount)}</b> for ${esc(split.title)}.${pending.length ? `\n${pending.length} still to pay (${m2(left)}).` : ""}`, {
      buttons: [[{ text: "Open split", webApp: `${config.miniappUrl}/#/split/${id}` }]],
    })
    this.d.live?.publish(split.creator_tg, { reason: "received", tx, toast: `${share.label} paid ${m2(share.amount)} · ${split.title}` })
    if (!pending.length) {
      store.updateSplit(id, { status: "settled", settled_at: Math.floor(Date.now() / 1000) })
      await notifyOrQueue(store, notifier, split.creator_tg, `🎉 <b>${esc(split.title)}</b> is settled: everyone paid (${m2(BigInt(split.total) - BigInt(split.mine))} collected).`)
    }
    await this.refreshCard(id)
    this.ping(store.getSplit(id)!, "split")
    return true
  }

  /**
   * On-chain matching (the block watcher calls this for every MUSD transfer between linked wallets): a transfer of
   * exactly a pending share's amount, to the requester, from that participant's wallet, pays it. Works whether
   * they paid in Keel or from any wallet app.
   */
  async matchTransfer(t: { from: string; to: string; value: bigint; tx: string }): Promise<boolean> {
    const { store } = this.d
    if (store.shareByTx(t.tx)) return false
    const from = t.from.toLowerCase()
    for (const s of store.pendingSharesTo(t.to, t.value.toString())) {
      const addr = s.address ?? (s.tg_id !== null ? store.getUser(s.tg_id)?.address : s.username ? store.findByUsername(s.username)?.address : null)
      if (addr?.toLowerCase() === from) return this.markPaid(s.split_id, s.idx, t.tx)
    }
    return false
  }

  // ------------------------------------------------------------------ reminders

  async remind(id: string, byTg: number): Promise<SplitResult<{ reminded: string[]; queued: string[]; links: Array<{ label: string; link: string }>; skipped: string[] }>> {
    const { store, notifier, config } = this.d
    const split = store.getSplit(id)
    if (!split) return fail("This split no longer exists.")
    if (split.creator_tg !== byTg) return fail("Only the person who asked can send reminders.")
    if (split.status !== "open") return fail(split.status === "settled" ? "Everyone has paid already 🎉" : "This split isn't open.")
    const creator = store.getUser(split.creator_tg)
    const now = Math.floor(Date.now() / 1000)
    const out = { reminded: [] as string[], queued: [] as string[], links: [] as Array<{ label: string; link: string }>, skipped: [] as string[] }
    for (const s of store.sharesOf(id).filter((x) => x.status === "pending")) {
      const tgId = s.tg_id ?? (s.username ? store.findByUsername(s.username)?.tg_id ?? null : null)
      if (tgId === null) {
        out.links.push({ label: s.label, link: this.link(id, s.idx) })
        continue
      }
      if (s.reminded_at && now - s.reminded_at < 3600) {
        out.skipped.push(s.label)
        continue
      }
      store.updateShare(id, s.idx, { reminded_at: now, tg_id: tgId })
      const how = await notifyOrQueue(store, notifier, tgId, `⏰ Reminder from <b>${esc(nameOf(creator, split.creator_address))}</b>: your share of <b>${esc(split.title)}</b> is <b>${m2(s.amount)}</b>.`, {
        buttons: [[{ text: `Pay ${m2(s.amount)}`, webApp: `${config.miniappUrl}/#/split/${id}/${s.idx}` }]],
      })
      ;(how === "sent" ? out.reminded : out.queued).push(s.label)
    }
    return { ok: true, value: out }
  }

  /** One automatic nudge, 24h after a split was created, to participants the bot can reach. Never queued. */
  async autoRemind(now = Math.floor(Date.now() / 1000)): Promise<number> {
    const { store, notifier, config } = this.d
    let n = 0
    for (const s of store.sharesDueForAutoReminder(now - 86_400)) {
      store.updateShare(s.split_id, s.idx, { auto_reminded: 1 })
      const creator = store.getUser(s.creator_tg)
      const ok = await notifier.send(s.tg_id!, `⏰ Still open: your share of <b>${esc(s.title)}</b> for <b>${esc(nameOf(creator))}</b> is <b>${m2(s.amount)}</b>.`, {
        buttons: [[{ text: `Pay ${m2(s.amount)}`, webApp: `${config.miniappUrl}/#/split/${s.split_id}/${s.idx}` }]],
      })
      if (ok) n++
    }
    return n
  }

  /** Message every participant Keel knows; returns the ones it can't reach (share their link instead). */
  private async askEveryone(split: SplitRow): Promise<string[]> {
    const { store, notifier, config } = this.d
    const creator = store.getUser(split.creator_tg)
    const shares = store.sharesOf(split.id)
    const notReached: string[] = []
    for (const s of shares) {
      if (s.tg_id === null) {
        notReached.push(s.label)
        continue
      }
      const how = await notifyOrQueue(store, notifier, s.tg_id, `🧾 <b>${esc(nameOf(creator, split.creator_address))}</b> split <b>${esc(split.title)}</b> (${m2(split.total)}, ${shares.length + (split.include_me ? 1 : 0)} people).\nYour share: <b>${m2(s.amount)}</b>${split.due_at ? ` · due ${dueText(split.due_at)}` : ""}.`, {
        buttons: [[{ text: `Pay ${m2(s.amount)}`, webApp: `${config.miniappUrl}/#/split/${split.id}/${s.idx}` }]],
      })
      if (how === "queued") notReached.push(s.label)
      this.d.live?.publish(s.tg_id, { reason: "split", toast: `${nameOf(creator)} asked you for ${m2(s.amount)} · ${split.title}` })
    }
    if (notReached.length && split.chat_id !== null && split.chat_id > 0) {
      await notifyOrQueue(store, notifier, split.creator_tg, `📨 ${notReached.map(esc).join(", ")} ${notReached.length > 1 ? "haven't" : "hasn't"} started Keel yet, so I can't message them. Send them their pay link with the 📤 buttons on the card.`)
    }
    return notReached
  }

  // ------------------------------------------------------------------ the chat card

  render(split: SplitRow): { html: string; markup: unknown } {
    const { store, config } = this.d
    const shares = store.sharesOf(split.id)
    const creator = store.getUser(split.creator_tg)
    const who = nameOf(creator, split.creator_address)
    const isGroup = (split.chat_id ?? 0) < 0
    const lines = [`🧾 <b>${esc(split.title)}</b> — ${m2(split.total)}${split.due_at ? ` · due ${dueText(split.due_at)}` : ""}`, `Requested by ${esc(who)}`]
    const rows: Array<Array<Record<string, unknown>>> = []
    if (split.status === "collecting") {
      lines.push("", shares.length ? `In so far: ${shares.map((s) => esc(s.label)).join(", ")}` : "Nobody's in yet.", "", `Tap <b>I'm in</b> to join. ${esc(who)} taps <b>Lock</b> when everyone's in, and it's split equally${split.include_me ? ` (${esc(who)} pays a share too)` : ""}.`)
      rows.push([{ text: "🙋 I'm in", callback_data: `split:join:${split.id}` }], [{ text: "🔒 Lock & request", callback_data: `split:lock:${split.id}` }, { text: "Cancel", callback_data: `split:cancel:${split.id}` }])
      return { html: lines.join("\n"), markup: { inline_keyboard: rows } }
    }
    lines.push("")
    for (const s of shares) lines.push(`${s.status === "paid" ? "✅" : "⏳"} ${esc(s.label)} · ${m2(s.amount)}${s.status === "paid" ? " <i>paid</i>" : ""}`)
    if (split.include_me && BigInt(split.mine) > 0n) lines.push(`👤 ${esc(who)} · ${m2(split.mine)} <i>own share</i>`)
    const requested = shares.reduce((a, s) => a + BigInt(s.amount), 0n)
    const collected = shares.filter((s) => s.status === "paid").reduce((a, s) => a + BigInt(s.amount), 0n)
    const pending = shares.filter((s) => s.status === "pending")
    lines.push("")
    if (split.status === "settled") lines.push(`🎉 <b>Settled</b> — ${m2(collected)} collected.`)
    else if (split.status === "cancelled") lines.push("❌ <b>Cancelled</b> by the requester.")
    else lines.push(`Collected <b>${m2(collected)}</b> of ${m2(requested)} · ${pending.length} to pay`)
    if (split.status === "open") {
      for (const s of pending) {
        const link = this.link(split.id, s.idx)
        rows.push(isGroup
          ? [{ text: `💸 ${s.label} · pay ${m2(s.amount)}`, url: link }]
          : [{ text: `📤 Send ${s.label} their link`, url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`${s.label}: your share of ${split.title} is ${m2(s.amount)}. Tap to pay with Keel:`)}` }])
      }
      rows.push([{ text: "🔔 Remind pending", callback_data: `split:remind:${split.id}` }, isGroup ? { text: "Open", url: this.link(split.id) } : { text: "Open split", web_app: { url: `${config.miniappUrl}/#/split/${split.id}` } }])
    }
    return { html: lines.join("\n"), markup: rows.length ? { inline_keyboard: rows } : { inline_keyboard: [] } }
  }

  private async postCard(split: SplitRow) {
    if (!this.tg || split.chat_id === null) return
    const { html, markup } = this.render(split)
    const mid = await this.tg.post(split.chat_id, html, markup).catch(() => null)
    if (mid) this.d.store.updateSplit(split.id, { message_id: mid })
  }

  async refreshCard(id: string) {
    const split = this.d.store.getSplit(id)
    if (!split || !this.tg || split.chat_id === null || !split.message_id) return
    const { html, markup } = this.render(split)
    await this.tg.edit(split.chat_id, split.message_id, html, markup).catch(() => undefined)
  }

  // ------------------------------------------------------------------ views (API)

  canView(split: SplitRow, u: UserRow) {
    return split.creator_tg === u.tg_id || this.d.store.sharesOf(split.id).some((s) => this.owns(s, u))
  }

  view(id: string, u: UserRow): SplitView | null {
    const { store } = this.d
    const split = store.getSplit(id)
    if (!split || !this.canView(split, u)) return null
    const isCreator = split.creator_tg === u.tg_id
    const shares = store.sharesOf(id)
    const collected = shares.filter((s) => s.status === "paid").reduce((a, s) => a + BigInt(s.amount), 0n)
    const requested = shares.reduce((a, s) => a + BigInt(s.amount), 0n)
    const mine = shares.find((s) => this.owns(s, u))
    return {
      id, title: split.title, total: split.total, mine: split.mine, includeMe: split.include_me === 1, status: split.status, dueAt: split.due_at, createdAt: split.created_at,
      creator: { name: nameOf(store.getUser(split.creator_tg), split.creator_address), isMe: isCreator },
      shares: shares.map((s) => ({
        idx: s.idx, label: s.label, amount: s.amount, status: s.status, tx: s.tx_hash, paidAt: s.paid_at, isMe: this.owns(s, u),
        ...(isCreator && s.status === "pending" && split.status === "open" ? { link: this.link(id, s.idx) } : {}),
      })),
      collected: collected.toString(),
      remaining: (requested - collected).toString(),
      myShare: mine ? mine.idx : null,
    }
  }

  listFor(u: UserRow) {
    const { store } = this.d
    const sum = (s: SplitRow) => this.view(s.id, u)!
    return {
      created: store.splitsCreatedBy(u.tg_id).map(sum),
      owed: store.splitsOwedBy(u).map(sum),
    }
  }

  /** People this user has paid or split with before, for the Mini App's people picker. */
  contacts(u: UserRow): string[] {
    const { store } = this.d
    const names = new Set<string>()
    for (const i of store.listIntents(u.tg_id, 100)) {
      const l = (i.params as Record<string, unknown>).label
      if (typeof l === "string" && l.startsWith("@")) names.add(l)
    }
    for (const s of store.splitsCreatedBy(u.tg_id, 20)) for (const x of store.sharesOf(s.id)) if (x.username) names.add(x.label)
    return [...names].slice(0, 20)
  }

  private ping(split: SplitRow, reason: "split") {
    const live = this.d.live
    if (!live) return
    live.publish(split.creator_tg, { reason })
    for (const s of this.d.store.sharesOf(split.id)) if (s.tg_id !== null) live.publish(s.tg_id, { reason })
  }
}

export const dueText = (at: number) => new Date(at * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
export const toWei = (n: number) => BigInt(Math.round(n * 100)) * (E18 / 100n)
