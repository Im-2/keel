import { createRequire } from "node:module"
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite"
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

export type IntentType = "borrow" | "repay" | "add_collateral" | "fund_reserve" | "protect_config" | "send" | "create_claim" | "pay_request" | "withdraw_reserve" | "close"
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

const now = () => Math.floor(Date.now() / 1000)
export const newId = (bytes = 6) => randomBytes(bytes).toString("base64url")

export class Store {
  db: DatabaseSyncType
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
    `)
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
    this.db
      .prepare(
        `INSERT INTO users (tg_id, username, first_name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name`,
      )
      .run(tgId, username ?? null, firstName ?? null, now())
    return this.getUser(tgId)!
  }
  setAddress(tgId: number, address: string) {
    // an address belongs to exactly one Telegram account
    this.db.prepare("UPDATE users SET address = NULL WHERE lower(address) = lower(?) AND tg_id != ?").run(address, tgId)
    this.db.prepare("UPDATE users SET address = ? WHERE tg_id = ?").run(address, tgId)
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
    this.db.prepare("UPDATE users SET settings = ? WHERE tg_id = ?").run(JSON.stringify(next), tgId)
    return next
  }

  // ---- nonces (wallet binding)
  issueNonce(tgId: number, ttl = 600): string {
    const nonce = newId(12)
    this.db.prepare("INSERT INTO nonces (nonce, tg_id, expires) VALUES (?, ?, ?)").run(nonce, tgId, now() + ttl)
    return nonce
  }
  consumeNonce(nonce: string, tgId: number): boolean {
    const r = this.db.prepare("SELECT * FROM nonces WHERE nonce = ? AND tg_id = ?").get(nonce, tgId) as { expires: number } | undefined
    if (!r) return false
    this.db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce)
    this.db.prepare("DELETE FROM nonces WHERE expires < ?").run(now())
    return r.expires >= now()
  }

  // ---- intents
  createIntent(tgId: number, type: IntentType, params: Record<string, unknown>, chatId?: number): IntentRow {
    const id = newId(6)
    this.db.prepare("INSERT INTO intents (id, tg_id, type, params, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tgId, type, JSON.stringify(params), chatId ?? null, now())
    return this.getIntent(id)!
  }
  getIntent(id: string): IntentRow | null {
    const r = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return r ? ({ ...r, params: JSON.parse(r.params as string) } as unknown as IntentRow) : null
  }
  listIntents(tgId: number, limit = 30): IntentRow[] {
    const rows = this.db.prepare("SELECT * FROM intents WHERE tg_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(tgId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({ ...r, params: JSON.parse(r.params as string) }) as unknown as IntentRow)
  }
  completeIntent(id: string, status: "done" | "failed", txHash?: string) {
    this.db.prepare("UPDATE intents SET status = ?, tx_hash = ? WHERE id = ? AND status = 'pending'").run(status, txHash ?? null, id)
  }

  // ---- payment requests / splits
  createRequest(r: Omit<RequestRow, "id" | "created_at" | "paid" | "message_id">): RequestRow {
    const id = newId(6)
    this.db
      .prepare("INSERT INTO requests (id, chat_id, requester_tg, requester_address, amount, memo, participants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, r.chat_id, r.requester_tg, r.requester_address, r.amount, r.memo, r.participants ? JSON.stringify(r.participants) : null, now())
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
    this.db.prepare("UPDATE requests SET message_id = ? WHERE id = ?").run(messageId, id)
  }
  markRequestPaid(id: string, entry: { tg_id: number; tx_hash: string; username?: string }): RequestRow | null {
    const r = this.getRequest(id)
    if (!r) return null
    if (!r.paid.some((p) => p.tg_id === entry.tg_id)) r.paid.push(entry)
    this.db.prepare("UPDATE requests SET paid = ? WHERE id = ?").run(JSON.stringify(r.paid), id)
    return r
  }

  // ---- alert dedup + kv
  getAlert(tgId: number, key: string): { value: string; updated_at: number } | null {
    return (this.db.prepare("SELECT value, updated_at FROM alert_state WHERE tg_id = ? AND key = ?").get(tgId, key) as { value: string; updated_at: number } | undefined) ?? null
  }
  setAlert(tgId: number, key: string, value: string) {
    this.db.prepare("INSERT INTO alert_state (tg_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(tgId, key, value, now())
  }
  getKv(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null
  }
  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }
}
