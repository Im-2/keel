import { createRequire } from "node:module"
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite"

type SQLInputValue = null | number | bigint | string | Uint8Array
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

export interface Settings {
  warnIcr: number // e.g. 1.5 -> alert when ICR drops below 150%
  dangerIcr: number // e.g. 1.3
  redemptionAlertMusd: number // warn when this much MUSD or less stands between you and redemption
  muted: boolean
}
export const DEFAULT_SETTINGS: Settings = { warnIcr: 1.5, dangerIcr: 1.3, redemptionAlertMusd: 20_000, muted: false }

export interface UserRow {
  tg_id: number
  username: string | null
  first_name: string | null
  address: string | null
  settings: Settings
  created_at: number
}

export type IntentType = "borrow" | "repay" | "add_collateral" | "fund_reserve" | "protect_config" | "send" | "create_claim" | "cancel_claim" | "pay_request" | "pay_split" | "withdraw_reserve" | "close"
export interface IntentRow {
  id: string
  tg_id: number
  type: IntentType
  params: Record<string, unknown>
  status: "pending" | "done" | "failed"
  tx_hash: string | null
  chat_id: number | null
  created_at: number
}

/** What an on-chain event means for one linked wallet. */
export type ChainEventKind = "transfer_in" | "transfer_out" | "protected" | "link_created" | "link_claimed" | "link_cancelled"
export interface ChainEventRow {
  tx: string
  log_index: number
  /** The linked wallet this row belongs to (lowercase). */
  wallet: string
  kind: ChainEventKind
  /** The other side: sender/recipient of a transfer, claimer of a link (lowercase). */
  counterparty: string | null
  amount: string | null
  block: number
  at: number
  data: Record<string, string>
}

export interface SplitRow {
  id: string
  creator_tg: number
  creator_address: string
  title: string
  total: string
  /** The requester's own share when they included themselves (not requested from anyone). */
  mine: string
  include_me: number
  mode: string
  /** collecting: a group split people join with "I'm in" before it is locked. */
  status: "collecting" | "open" | "settled" | "cancelled"
  due_at: number | null
  chat_id: number | null
  message_id: number | null
  created_at: number
  settled_at: number | null
}
export interface ShareRow {
  split_id: string
  idx: number
  label: string
  /** Lowercase Telegram username, when the share was addressed to one. */
  username: string | null
  tg_id: number | null
  /** Lowercase wallet address, when known (linked wallet or pasted address). */
  address: string | null
  amount: string
  status: "pending" | "paid"
  tx_hash: string | null
  paid_at: number | null
  reminded_at: number | null
  auto_reminded: number
}

export interface Handoff {
  token: string
  tg_id: number
  purpose: "link" | "intent"
  intent_id: string | null
  expires: number
  used: number
}

export interface RequestRow {
  id: string
  chat_id: number
  message_id: number | null
  requester_tg: number
  requester_address: string
  amount: string // MUSD, decimal string (per person)
  memo: string | null
  participants: Array<{ username?: string; tg_id?: number }> | null
  paid: Array<{ tg_id: number; tx_hash: string; username?: string }>
  created_at: number
}

// `node:sqlite` has no non-prefixed alias, which bundlers (vitest/vite) cannot resolve; load it via require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
const asRow = (x: unknown) => x as Record<string, unknown> | undefined

const SCHEMA = `
      CREATE TABLE IF NOT EXISTS users (
        tg_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, address TEXT,
        settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(lower(username));
      CREATE INDEX IF NOT EXISTS idx_users_address ON users(lower(address));
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, type TEXT NOT NULL, params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, chat_id INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER, requester_tg INTEGER NOT NULL,
        requester_address TEXT NOT NULL, amount TEXT NOT NULL, memo TEXT, participants TEXT, paid TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_state (tg_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (tg_id, key));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (token TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, purpose TEXT NOT NULL, intent_id TEXT, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chain_events (
        tx TEXT NOT NULL, log_index INTEGER NOT NULL, wallet TEXT NOT NULL, kind TEXT NOT NULL, counterparty TEXT,
        amount TEXT, block INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (tx, log_index, wallet)
      );
      CREATE INDEX IF NOT EXISTS idx_events_wallet ON chain_events(wallet, block);
      CREATE TABLE IF NOT EXISTS notices (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, html TEXT NOT NULL, opts TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS splits (
        id TEXT PRIMARY KEY, creator_tg INTEGER NOT NULL, creator_address TEXT NOT NULL, title TEXT NOT NULL, total TEXT NOT NULL,
        mine TEXT NOT NULL DEFAULT '0', include_me INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'equal', status TEXT NOT NULL DEFAULT 'open',
        due_at INTEGER, chat_id INTEGER, message_id INTEGER, created_at INTEGER NOT NULL, settled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS split_shares (
        split_id TEXT NOT NULL, idx INTEGER NOT NULL, label TEXT NOT NULL, username TEXT, tg_id INTEGER, address TEXT, amount TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, paid_at INTEGER, reminded_at INTEGER, auto_reminded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (split_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_shares_tg ON split_shares(tg_id);
      CREATE INDEX IF NOT EXISTS idx_shares_user ON split_shares(username);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_tx ON split_shares(tx_hash);
`
const TABLES = ["users", "nonces", "intents", "requests", "alert_state", "kv", "handoffs", "chain_events", "notices", "outbox", "splits", "split_shares"] as const

/** A remote copy of the database (Turso/libSQL in production). */
export interface Mirror {
  execute(sql: string, args: unknown[]): Promise<unknown>
  query(sql: string): Promise<Array<Record<string, unknown>>>
}

const now = () => Math.floor(Date.now() / 1000)
export const newId = (bytes = 6) => randomBytes(bytes).toString("base64url")

export class Store {
  db: DatabaseSyncType
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec("PRAGMA journal_mode = WAL;\n" + SCHEMA)
  }

  // ---- durability: every write runs locally (synchronously) and is replayed, in order, on a remote mirror
  private mirror: Mirror | null = null
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  /** Last mirror error, for the status page. */
  mirrorError: string | null = null

  private write(sql: string, ...args: SQLInputValue[]) {
    const res = this.db.prepare(sql).run(...args)
    const m = this.mirror
    if (m) {
      this.pending++
      this.queue = this.queue.then(async () => {
        // a few retries ride out network blips; the write is never lost locally
        for (let attempt = 0; ; attempt++) {
          try {
            await m.execute(sql, args)
            this.mirrorError = null
            break
          } catch (e) {
            this.mirrorError = (e as Error).message
            if (attempt >= 4) break
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
          }
        }
        this.pending--
      })
    }
    return res
  }

  /** Writes not yet confirmed by the mirror. */
  get mirrorBacklog() {
    return this.pending
  }

  /** Wait until every write has reached the mirror (call before shutdown). */
  flush(): Promise<void> {
    return this.queue
  }

  /**
   * Open a store backed by a remote mirror (Turso/libSQL): create the schema there, copy every row into the
   * local SQLite file, then mirror all further writes. Hosts with an ephemeral disk lose nothing on restart.
   */
  static async open(path: string, mirror?: Mirror): Promise<Store> {
    const s = new Store(path)
    if (!mirror) return s
    for (const stmt of SCHEMA.split(";").map((x) => x.trim()).filter(Boolean)) await mirror.execute(stmt, [])
    for (const table of TABLES) {
      const rows = await mirror.query(`SELECT * FROM ${table}`)
      for (const r of rows) {
        const cols = Object.keys(r)
        s.db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c] as SQLInputValue))
      }
    }
    s.mirror = mirror
    return s
  }

  /** Row counts per table (status page, backups). */
  counts(): Record<string, number> {
    return Object.fromEntries(TABLES.map((t) => [t, (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]))
  }

  // ---- users
  private mapUser(r: Record<string, unknown> | undefined): UserRow | null {
    if (!r) return null
    return {
      tg_id: r.tg_id as number,
      username: (r.username as string) ?? null,
      first_name: (r.first_name as string) ?? null,
      address: (r.address as string) ?? null,
      settings: { ...DEFAULT_SETTINGS, ...JSON.parse((r.settings as string) || "{}") },
      created_at: r.created_at as number,
    }
  }
  getUser(tgId: number): UserRow | null {
    return this.mapUser(asRow(this.db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId)))
  }
  upsertUser(tgId: number, username?: string | null, firstName?: string | null): UserRow {
    this.write(`INSERT INTO users (tg_id, username, first_name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name`, tgId, username ?? null, firstName ?? null, now())
    return this.getUser(tgId)!
  }
  setAddress(tgId: number, address: string) {
    // an address belongs to exactly one Telegram account
    this.write("UPDATE users SET address = NULL WHERE lower(address) = lower(?) AND tg_id != ?", address, tgId)
    this.write("UPDATE users SET address = ? WHERE tg_id = ?", address, tgId)
    // (re)linking: fill any gap in this wallet's history on the next look (rows are deduplicated)
    this.write("DELETE FROM kv WHERE key = ?", `hist:backfilled:${address.toLowerCase()}`)
  }
  findByUsername(username: string): UserRow | null {
    return this.mapUser(asRow(this.db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(username.replace(/^@/, ""))))
  }
  findByAddress(address: string): UserRow | null {
    return this.mapUser(asRow(this.db.prepare("SELECT * FROM users WHERE lower(address) = lower(?)").get(address)))
  }
  boundUsers(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users WHERE address IS NOT NULL").all() as Record<string, unknown>[]).map((r) => this.mapUser(r)!)
  }
  updateSettings(tgId: number, patch: Partial<Settings>): Settings {
    const u = this.getUser(tgId)
    const next = { ...(u?.settings ?? DEFAULT_SETTINGS), ...patch }
    this.write("UPDATE users SET settings = ? WHERE tg_id = ?", JSON.stringify(next), tgId)
    return next
  }

  /**
   * Unlink the user's wallet and drop everything tied to it: pending binding nonces, unsigned intents (including
   * unsent claim links), one-time handoff links, alert state and any half-finished chat question. Completed intents
   * stay as history. Nothing on-chain is touched: re-linking the same wallet finds its guardian and loan again.
   * Returns the address that was linked.
   */
  disconnect(tgId: number): string | null {
    const before = this.getUser(tgId)?.address ?? null
    this.write("UPDATE users SET address = NULL WHERE tg_id = ?", tgId)
    this.write("DELETE FROM nonces WHERE tg_id = ?", tgId)
    this.write("DELETE FROM intents WHERE tg_id = ? AND status = 'pending'", tgId)
    this.write("DELETE FROM handoffs WHERE tg_id = ?", tgId)
    this.write("DELETE FROM alert_state WHERE tg_id = ?", tgId)
    this.write("DELETE FROM kv WHERE key = ?", `nl:await:${tgId}`)
    return before
  }

  /** Delete every record of a Telegram user, as if they had never used the bot (admin testing of onboarding). */
  resetUser(tgId: number) {
    this.write("DELETE FROM users WHERE tg_id = ?", tgId)
    this.write("DELETE FROM nonces WHERE tg_id = ?", tgId)
    this.write("DELETE FROM intents WHERE tg_id = ?", tgId)
    this.write("DELETE FROM requests WHERE requester_tg = ?", tgId)
    this.write("DELETE FROM handoffs WHERE tg_id = ?", tgId)
    this.write("DELETE FROM alert_state WHERE tg_id = ?", tgId)
    this.write("DELETE FROM outbox WHERE tg_id = ?", tgId)
    this.write("DELETE FROM kv WHERE key = ? OR key = ?", `nl:await:${tgId}`, `premium:${tgId}`)
    // pending chat confirmations are stored as JSON under random ids; match them by owner
    this.write("DELETE FROM kv WHERE key LIKE 'nl:p:%' AND value LIKE ?", `{"tg":${tgId},%`)
  }

  // ---- on-chain ledger: MUSD transfers, KeelPay links and guardian events touching a linked wallet
  /** Insert once per (tx, log, wallet); returns false when the event was already recorded. */
  recordEvent(e: ChainEventRow): boolean {
    const r = this.write(
      "INSERT OR IGNORE INTO chain_events (tx, log_index, wallet, kind, counterparty, amount, block, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      e.tx.toLowerCase(), e.log_index, e.wallet.toLowerCase(), e.kind, e.counterparty?.toLowerCase() ?? null, e.amount ?? null, e.block, e.at, JSON.stringify(e.data ?? {}),
    )
    return Number(r.changes) > 0
  }
  eventsFor(wallet: string, limit = 200): ChainEventRow[] {
    return (this.db.prepare("SELECT * FROM chain_events WHERE wallet = ? ORDER BY block DESC, log_index DESC LIMIT ?").all(wallet.toLowerCase(), limit) as Record<string, unknown>[]).map((r) => ({
      tx: r.tx as string, log_index: r.log_index as number, wallet: r.wallet as string, kind: r.kind as ChainEventKind, counterparty: (r.counterparty as string) ?? null,
      amount: (r.amount as string) ?? null, block: r.block as number, at: r.at as number, data: JSON.parse((r.data as string) || "{}"),
    }))
  }
  eventsInTx(tx: string): ChainEventRow[] {
    return (this.db.prepare("SELECT * FROM chain_events WHERE tx = ?").all(tx.toLowerCase()) as Record<string, unknown>[]).map((r) => ({
      tx: r.tx as string, log_index: r.log_index as number, wallet: r.wallet as string, kind: r.kind as ChainEventKind, counterparty: (r.counterparty as string) ?? null,
      amount: (r.amount as string) ?? null, block: r.block as number, at: r.at as number, data: JSON.parse((r.data as string) || "{}"),
    }))
  }
  /** The linked wallet that created a claim link, from its LinkCreated row. */
  linkOwner(link: string): string | null {
    const r = this.db.prepare("SELECT wallet FROM chain_events WHERE kind = 'link_created' AND counterparty = ? LIMIT 1").get(link.toLowerCase()) as { wallet: string } | undefined
    return r?.wallet ?? null
  }
  intentByTx(tx: string): IntentRow | null {
    const r = asRow(this.db.prepare("SELECT * FROM intents WHERE lower(tx_hash) = lower(?)").get(tx))
    return r ? this.mapIntent(r) : null
  }
  /** Pending (unsigned or unconfirmed) intents of one type, newest first. */
  pendingIntents(type?: IntentType): IntentRow[] {
    const rows = type
      ? this.db.prepare("SELECT * FROM intents WHERE status = 'pending' AND type = ? ORDER BY created_at DESC").all(type)
      : this.db.prepare("SELECT * FROM intents WHERE status = 'pending' AND tx_hash IS NOT NULL ORDER BY created_at DESC").all()
    return (rows as Record<string, unknown>[]).map((r) => this.mapIntent(r))
  }
  /** The wallet reported a broadcast transaction: remember it so the server can confirm it even if the app closes. */
  setIntentTx(id: string, txHash: string) {
    this.write("UPDATE intents SET tx_hash = ? WHERE id = ? AND status = 'pending'", txHash, id)
  }

  // ---- bill splits
  createSplit(s: Omit<SplitRow, "created_at" | "settled_at" | "message_id">, shares: Array<Pick<ShareRow, "label" | "username" | "tg_id" | "address" | "amount">>): SplitRow {
    this.write(
      "INSERT INTO splits (id, creator_tg, creator_address, title, total, mine, include_me, mode, status, due_at, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      s.id, s.creator_tg, s.creator_address.toLowerCase(), s.title, s.total, s.mine, s.include_me, s.mode, s.status, s.due_at, s.chat_id, now(),
    )
    shares.forEach((x, i) => this.addShare(s.id, i, x))
    return this.getSplit(s.id)!
  }
  addShare(splitId: string, idx: number, x: Pick<ShareRow, "label" | "username" | "tg_id" | "address" | "amount">) {
    this.write("INSERT OR IGNORE INTO split_shares (split_id, idx, label, username, tg_id, address, amount) VALUES (?, ?, ?, ?, ?, ?, ?)", splitId, idx, x.label, x.username?.toLowerCase() ?? null, x.tg_id, x.address?.toLowerCase() ?? null, x.amount)
  }
  getSplit(id: string): SplitRow | null {
    return (this.db.prepare("SELECT * FROM splits WHERE id = ?").get(id) as unknown as SplitRow | undefined) ?? null
  }
  sharesOf(splitId: string): ShareRow[] {
    return this.db.prepare("SELECT * FROM split_shares WHERE split_id = ? ORDER BY idx").all(splitId) as unknown as ShareRow[]
  }
  updateSplit(id: string, patch: Partial<Pick<SplitRow, "status" | "message_id" | "chat_id" | "settled_at" | "mine" | "total">>) {
    for (const [k, v] of Object.entries(patch)) this.write(`UPDATE splits SET ${k} = ? WHERE id = ?`, v as SQLInputValue, id)
  }
  updateShare(splitId: string, idx: number, patch: Partial<Pick<ShareRow, "amount" | "tg_id" | "address" | "reminded_at" | "auto_reminded">>) {
    for (const [k, v] of Object.entries(patch)) this.write(`UPDATE split_shares SET ${k} = ? WHERE split_id = ? AND idx = ?`, v as SQLInputValue, splitId, idx)
  }
  /** Idempotent: only a pending share becomes paid, and one transaction can pay only one share. */
  markSharePaid(splitId: string, idx: number, txHash: string): boolean {
    if (this.db.prepare("SELECT 1 FROM split_shares WHERE tx_hash = ?").get(txHash.toLowerCase())) return false
    return Number(this.write("UPDATE split_shares SET status = 'paid', tx_hash = ?, paid_at = ? WHERE split_id = ? AND idx = ? AND status = 'pending'", txHash.toLowerCase(), now(), splitId, idx).changes) > 0
  }
  shareByTx(txHash: string): (ShareRow & { title: string; creator_tg: number }) | null {
    return (this.db.prepare("SELECT s.*, p.title, p.creator_tg FROM split_shares s JOIN splits p ON p.id = s.split_id WHERE s.tx_hash = ?").get(txHash.toLowerCase()) as unknown as (ShareRow & { title: string; creator_tg: number }) | undefined) ?? null
  }
  /** Pending shares owed to `creatorAddress` for exactly this amount, in open splits (on-chain payment matching). */
  pendingSharesTo(creatorAddress: string, amount: string): ShareRow[] {
    return this.db.prepare(
      "SELECT s.* FROM split_shares s JOIN splits p ON p.id = s.split_id WHERE p.creator_address = ? AND p.status = 'open' AND s.status = 'pending' AND s.amount = ? ORDER BY p.created_at, s.idx",
    ).all(creatorAddress.toLowerCase(), amount) as unknown as ShareRow[]
  }
  splitsCreatedBy(tgId: number, limit = 30): SplitRow[] {
    return this.db.prepare("SELECT * FROM splits WHERE creator_tg = ? ORDER BY created_at DESC LIMIT ?").all(tgId, limit) as unknown as SplitRow[]
  }
  /** Splits where this person has a share (by Telegram id, username, or linked wallet). */
  splitsOwedBy(u: { tg_id: number; username: string | null; address: string | null }, limit = 30): SplitRow[] {
    return this.db.prepare(
      `SELECT DISTINCT p.* FROM splits p JOIN split_shares s ON s.split_id = p.id
       WHERE p.creator_tg != ? AND (s.tg_id = ? OR (s.username IS NOT NULL AND s.username = ?) OR (s.address IS NOT NULL AND s.address = ?))
       ORDER BY p.created_at DESC LIMIT ?`,
    ).all(u.tg_id, u.tg_id, (u.username ?? "").toLowerCase(), (u.address ?? "").toLowerCase(), limit) as unknown as SplitRow[]
  }
  /** Unpaid shares in open splits created before `before` that haven't had their automatic reminder yet. */
  sharesDueForAutoReminder(before: number): Array<ShareRow & { title: string; creator_tg: number }> {
    return this.db.prepare(
      "SELECT s.*, p.title, p.creator_tg FROM split_shares s JOIN splits p ON p.id = s.split_id WHERE p.status = 'open' AND s.status = 'pending' AND s.auto_reminded = 0 AND s.tg_id IS NOT NULL AND p.created_at < ?",
    ).all(before) as unknown as Array<ShareRow & { title: string; creator_tg: number }>
  }

  // ---- notification dedup: a notice key is claimed exactly once, across restarts
  claimNotice(key: string): boolean {
    return Number(this.write("INSERT OR IGNORE INTO notices (key, at) VALUES (?, ?)", key, now()).changes) > 0
  }

  // ---- outbox: messages for people Telegram won't let us reach yet (never started the bot, or blocked it)
  queueMessage(tgId: number, html: string, opts: unknown) {
    this.write("INSERT INTO outbox (id, tg_id, html, opts, created_at) VALUES (?, ?, ?, ?, ?)", newId(8), tgId, html, JSON.stringify(opts ?? {}), now())
  }
  takeMessages(tgId: number): Array<{ html: string; opts: unknown }> {
    const rows = this.db.prepare("SELECT * FROM outbox WHERE tg_id = ? ORDER BY created_at, rowid").all(tgId) as Record<string, unknown>[]
    if (rows.length) this.write("DELETE FROM outbox WHERE tg_id = ?", tgId)
    return rows.map((r) => ({ html: r.html as string, opts: JSON.parse(r.opts as string) }))
  }
  hasQueued(tgId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE tg_id = ? LIMIT 1").get(tgId)
  }

  // ---- nonces (wallet binding)
  issueNonce(tgId: number, ttl = 600): string {
    const nonce = newId(12)
    this.write("INSERT INTO nonces (nonce, tg_id, expires) VALUES (?, ?, ?)", nonce, tgId, now() + ttl)
    return nonce
  }
  consumeNonce(nonce: string, tgId: number): boolean {
    const r = this.db.prepare("SELECT * FROM nonces WHERE nonce = ? AND tg_id = ?").get(nonce, tgId) as { expires: number } | undefined
    if (!r) return false
    this.write("DELETE FROM nonces WHERE nonce = ?", nonce)
    this.write("DELETE FROM nonces WHERE expires < ?", now())
    return r.expires >= now()
  }

  // ---- intents
  createIntent(tgId: number, type: IntentType, params: Record<string, unknown>, chatId?: number): IntentRow {
    const id = newId(6)
    this.write("INSERT INTO intents (id, tg_id, type, params, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, tgId, type, JSON.stringify(params), chatId ?? null, now())
    return this.getIntent(id)!
  }
  private mapIntent(r: Record<string, unknown>): IntentRow {
    return { ...r, params: JSON.parse(r.params as string) } as unknown as IntentRow
  }
  getIntent(id: string): IntentRow | null {
    const r = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return r ? this.mapIntent(r) : null
  }
  listIntents(tgId: number, limit = 30): IntentRow[] {
    const rows = this.db.prepare("SELECT * FROM intents WHERE tg_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(tgId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({ ...r, params: JSON.parse(r.params as string) }) as unknown as IntentRow)
  }
  completeIntent(id: string, status: "done" | "failed", txHash?: string) {
    this.write("UPDATE intents SET status = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ? AND status = 'pending'", status, txHash ?? null, id)
  }

  // ---- payment requests / splits
  createRequest(r: Omit<RequestRow, "id" | "created_at" | "paid" | "message_id">): RequestRow {
    const id = newId(6)
    this.write("INSERT INTO requests (id, chat_id, requester_tg, requester_address, amount, memo, participants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, r.chat_id, r.requester_tg, r.requester_address, r.amount, r.memo, r.participants ? JSON.stringify(r.participants) : null, now())
    return this.getRequest(id)!
  }
  getRequest(id: string): RequestRow | null {
    const x = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined
    if (!x) return null
    return {
      ...(x as object),
      participants: x.participants ? JSON.parse(x.participants as string) : null,
      paid: JSON.parse(x.paid as string),
    } as RequestRow
  }
  setRequestMessage(id: string, messageId: number) {
    this.write("UPDATE requests SET message_id = ? WHERE id = ?", messageId, id)
  }
  markRequestPaid(id: string, entry: { tg_id: number; tx_hash: string; username?: string }): RequestRow | null {
    const r = this.getRequest(id)
    if (!r) return null
    if (!r.paid.some((p) => p.tg_id === entry.tg_id)) r.paid.push(entry)
    this.write("UPDATE requests SET paid = ? WHERE id = ?", JSON.stringify(r.paid), id)
    return r
  }

  // ---- wallet-browser handoff: a one-time token standing in for Telegram initData outside Telegram
  createHandoff(tgId: number, purpose: "link" | "intent", intentId: string | null, ttl = 600): { token: string; expires: number } {
    const token = newId(24)
    const expires = now() + ttl
    this.write("DELETE FROM handoffs WHERE expires < ?", now())
    this.write("INSERT INTO handoffs (token, tg_id, purpose, intent_id, expires) VALUES (?, ?, ?, ?, ?)", token, tgId, purpose, intentId, expires)
    return { token, expires }
  }
  /** A live (unused, unexpired) handoff, or null. */
  getHandoff(token: string): Handoff | null {
    const r = this.db.prepare("SELECT * FROM handoffs WHERE token = ? AND used = 0 AND expires >= ?").get(token, now()) as Handoff | undefined
    return r ?? null
  }
  /** Marks a handoff used; returns false if it was already used (single-use under concurrency). */
  useHandoff(token: string): boolean {
    return Number(this.write("UPDATE handoffs SET used = 1 WHERE token = ? AND used = 0", token).changes) === 1
  }

  // ---- alert dedup + kv
  getAlert(tgId: number, key: string): { value: string; updated_at: number } | null {
    return (this.db.prepare("SELECT value, updated_at FROM alert_state WHERE tg_id = ? AND key = ?").get(tgId, key) as { value: string; updated_at: number } | undefined) ?? null
  }
  setAlert(tgId: number, key: string, value: string) {
    this.write("INSERT INTO alert_state (tg_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", tgId, key, value, now())
  }
  getKv(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null
  }
  setKv(key: string, value: string) {
    this.write("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  }
}
