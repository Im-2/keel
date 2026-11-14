import { createHash, randomBytes } from "node:crypto"
import type { Hono } from "hono"
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem"
import type { Store, UserRow } from "./db"
import { RateLimiter } from "./live"

/**
 * Sign-in with a wallet, for the web app outside Telegram.
 *
 * The browser asks for a nonce for an address, the wallet signs a fixed message containing it, and the server
 * returns a short-lived session token. The session holds only the wallet address: every request resolves the account
 * from the address on the server, so a client can never choose whose data it reads. A wallet that is already linked
 * to a Telegram account signs in to that same account (the signature proves control of the wallet that account uses);
 * a new wallet gets a web-only account with an id far below any Telegram user or group id.
 */

export const SESSION_HEADER = "x-keel-session"
export const SESSION_TTL = 12 * 3600
const NONCE_TTL = 600
const TG_LINK_TTL = 1800

const now = () => Math.floor(Date.now() / 1000)
const hash = (token: string) => createHash("sha256").update(token).digest("hex")

/**
 * Stable web-only account id for an address. Telegram users are positive and Telegram groups are negative but far
 * above -2^52, so web accounts live below -2^52 (still a safe integer) and can never be mistaken for either.
 */
const WEB_BASE = 2 ** 52
export const webUserId = (address: string) => -(WEB_BASE + 1 + parseInt(address.toLowerCase().slice(2, 14), 16))
export const isWebUser = (tgId: number) => tgId <= -WEB_BASE

export function signInMessage(o: { domain: string; address: Address; chainId: number; nonce: string; issuedAt: string }) {
  return [
    `${o.domain} wants you to sign in to Keel with your wallet:`,
    o.address,
    "",
    "Sign in to Keel. This only proves you own this wallet: it is free and moves no funds.",
    "",
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${o.issuedAt}`,
  ].join("\n")
}

interface Pending {
  address: string
  message: string
  exp: number
}

export class WebSessions {
  constructor(private store: Store) {}

  issueNonce(address: Address, domain: string, chainId: number) {
    const nonce = randomBytes(12).toString("base64url")
    const message = signInMessage({ domain, address: getAddress(address), chainId, nonce, issuedAt: new Date().toISOString() })
    this.store.setKv(`wn:${nonce}`, JSON.stringify({ address: address.toLowerCase(), message, exp: now() + NONCE_TTL } satisfies Pending))
    return { nonce, message }
  }

  /** Verify the signed nonce (single use) and open a session. Returns null when anything doesn't match. */
  async signIn(address: Address, nonce: string, signature: Hex): Promise<{ token: string; expires: number; user: UserRow } | null> {
    const raw = this.store.getKv(`wn:${nonce}`)
    if (!raw) return null
    this.store.deleteKv(`wn:${nonce}`)
    const p = JSON.parse(raw) as Pending
    if (p.exp < now() || p.address !== address.toLowerCase()) return null
    const ok = await verifyMessage({ address, message: p.message, signature }).catch(() => false)
    if (!ok) return null
    let user = this.store.findByAddress(address)
    if (!user) {
      const id = webUserId(address)
      this.store.upsertUser(id, null, null)
      this.store.setAddress(id, getAddress(address))
      user = this.store.getUser(id)!
    }
    const token = randomBytes(32).toString("base64url")
    const expires = now() + SESSION_TTL
    this.store.setKv(`ws:${hash(token)}`, JSON.stringify({ address: address.toLowerCase(), exp: expires }))
    return { token, expires, user }
  }

  /** The account behind a session token, resolved from the session's wallet on every call. */
  resolve(token: string): UserRow | null {
    if (!token || token.length > 100) return null
    const key = `ws:${hash(token)}`
    const raw = this.store.getKv(key)
    if (!raw) return null
    const s = JSON.parse(raw) as { address: string; exp: number }
    if (s.exp < now()) {
      this.store.deleteKv(key)
      return null
    }
    // the wallet may have been unlinked (or moved to another account) since sign-in: then the session is over
    return this.store.findByAddress(s.address)
  }

  end(token: string) {
    this.store.deleteKv(`ws:${hash(token)}`)
  }

  /** One-time code that lets a web-only account attach a Telegram account later (t.me/<bot>?start=web_<code>). */
  telegramLinkCode(user: UserRow) {
    const code = randomBytes(16).toString("base64url")
    this.store.setKv(`wl:${code}`, JSON.stringify({ address: user.address, exp: now() + TG_LINK_TTL }))
    return code
  }

  /**
   * Called from the bot's /start web_<code>: moves the web account's wallet and its history to the Telegram account.
   * After this the same wallet session reads the Telegram account (sessions resolve by address).
   */
  redeemTelegramLink(code: string, tgId: number): { ok: true; address: string } | { ok: false; error: string } {
    const raw = this.store.getKv(`wl:${code}`)
    if (!raw) return { ok: false, error: "This link has expired or was already used. Open Keel on the web and tap “Connect Telegram” again." }
    const l = JSON.parse(raw) as { address: string | null; exp: number }
    this.store.deleteKv(`wl:${code}`)
    if (l.exp < now() || !l.address) return { ok: false, error: "This link has expired. Open Keel on the web and tap “Connect Telegram” again." }
    const web = this.store.findByAddress(l.address)
    if (!web) return { ok: false, error: "That wallet is no longer signed in on the web. Sign in again and retry." }
    if (web.tg_id === tgId) return { ok: true, address: l.address }
    if (!isWebUser(web.tg_id)) return { ok: false, error: "That wallet is already linked to another Telegram account." }
    const me = this.store.getUser(tgId)
    if (me?.address && me.address.toLowerCase() !== l.address.toLowerCase()) {
      return { ok: false, error: "This Telegram account already has a different wallet linked. Send /disconnect first, then open the link again." }
    }
    this.store.mergeUser(web.tg_id, tgId)
    this.store.setAddress(tgId, web.address!)
    return { ok: true, address: web.address! }
  }
}

/** Public routes: /api/web/nonce and /api/web/session. Session-only routes are mounted by the caller. */
export function mountWebAuth(app: Hono<any>, d: { sessions: WebSessions; chainId: number; domain: string }) {
  const limit = new RateLimiter(20, 60_000)
  const ip = (c: { req: { header(n: string): string | undefined } }) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"

  app.post("/api/web/nonce", async (c) => {
    if (!limit.allow(`n:${ip(c)}`)) return c.json({ error: "Too many requests, slow down." }, 429)
    const body = await c.req.json().catch(() => null)
    if (!body || !isAddress(body.address)) return c.json({ error: "bad request" }, 400)
    return c.json(d.sessions.issueNonce(body.address, d.domain, d.chainId))
  })

  app.post("/api/web/session", async (c) => {
    if (!limit.allow(`s:${ip(c)}`)) return c.json({ error: "Too many requests, slow down." }, 429)
    const body = await c.req.json().catch(() => null)
    if (!body || !isAddress(body.address) || typeof body.nonce !== "string" || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
      return c.json({ error: "bad request" }, 400)
    }
    const s = await d.sessions.signIn(body.address, body.nonce, body.signature as Hex)
    if (!s) return c.json({ error: "Sign-in failed: the signature didn't match or the request expired. Try again." }, 401)
    return c.json({ token: s.token, expires: s.expires, address: s.user.address, telegram: !isWebUser(s.user.tg_id) })
  })

  app.post("/api/web/logout", (c) => {
    const t = c.req.header(SESSION_HEADER)
    if (t) d.sessions.end(t)
    return c.json({ ok: true })
  })
}
