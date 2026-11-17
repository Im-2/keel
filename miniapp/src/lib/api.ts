import type { Address } from "viem"
import { handoffToken } from "./telegram"
import { clearWebSession, sessionToken } from "./web"

export interface TgWebApp {
  initData: string
  initDataUnsafe: { start_param?: string; user?: { id: number; username?: string; first_name?: string; photo_url?: string } }
  platform?: string
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
  setHeaderColor?(c: string): void
  setBackgroundColor?(c: string): void
  setBottomBarColor?(c: string): void
  disableVerticalSwipes?(): void
  ready(): void
  expand(): void
  close(): void
  colorScheme?: "light" | "dark"
  themeParams?: Record<string, string>
  openTelegramLink?(url: string): void
  openLink?(url: string, opts?: { try_instant_view?: boolean }): void
  HapticFeedback?: { notificationOccurred(t: "success" | "error" | "warning"): void }
  MainButton?: unknown
}

const liveTg = () => (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp
/** Telegram.WebApp, read live on every access (so a dev preview can stand in for a real Telegram client). */
export const tg: TgWebApp | undefined = liveTg()
  ? (new Proxy({}, {
      get: (_, k) => {
        const w = liveTg() as unknown as Record<PropertyKey, unknown> | undefined
        const v = w?.[k]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(w) : v
      },
    }) as TgWebApp)
  : undefined

export interface AppConfig {
  network: "testnet" | "mainnet" | "local"
  chainId: number
  rpcUrl: string | null
  botUsername: string
  miniappShortName: string | null
  deployment: {
    musd: Record<string, Address>
    keel: { guardianFactory: Address; pay: Address; version?: number; pro?: Address; treasury?: Address; protocolShareBps?: number } | null
    legacy?: Array<{ guardianFactory: Address; pay: Address; version?: number }>
  }
}

export interface IntentDto {
  id: string
  tg_id: number
  type: string
  params: Record<string, string>
  status: "pending" | "done" | "failed"
  tx_hash?: string | null
}

/** Telegram initData inside Telegram; a one-time handoff token inside a wallet's own browser. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (tg?.initData) h["x-telegram-init-data"] = tg.initData
  else {
    const t = handoffToken()
    if (t) h["x-keel-handoff"] = t
    else {
      const w = sessionToken()
      if (w) h["x-keel-session"] = w
    }
  }
  return h
}

/** Backend origin when the Mini App is hosted separately from the bot server (set at build time). */
export const apiUrl = (path: string) => `${(import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? ""}${path}`

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    // never leave a screen on a spinner forever if the backend is unreachable
    signal: AbortSignal.timeout(timeoutMs ?? (method === "GET" ? 20_000 : 60_000)),
  }).catch((e: Error) => {
    throw new ApiError(e.name === "TimeoutError" ? "Keel's server is not responding" : "Can't reach Keel's server", 0)
  })
  const data = await res.json().catch(() => ({}))
  // a web session that ran out: drop it, so the app shows the sign-in screen again
  if (res.status === 401 && (data as { code?: string }).code === "session") clearWebSession()
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, (data as { code?: string }).code)
  return data as T
}

export const api = {
  config: (timeoutMs?: number) => call<AppConfig>("GET", "/api/config", undefined, timeoutMs),
  me: () => call<{ tgId: number | null; username?: string; address: Address | null; web?: boolean; telegram?: boolean }>("GET", "/api/me"),
  webNonce: (address: Address) => call<{ nonce: string; message: string }>("POST", "/api/web/nonce", { address }),
  webSession: (b: { address: Address; nonce: string; signature: string }) => call<{ token: string; expires: number; address: Address; telegram: boolean }>("POST", "/api/web/session", b),
  webLogout: () => call<{ ok: boolean }>("POST", "/api/web/logout", {}),
  webTelegram: () => call<{ linked: boolean; url?: string }>("POST", "/api/web/telegram", {}),
  stats: (all = false, timeoutMs?: number) => call<StatsDto>("GET", `/api/stats${all ? "?all=1" : ""}`, undefined, timeoutMs),
  nonce: () => call<{ nonce: string; message: string }>("POST", "/api/nonce", {}),
  bind: (b: { nonce: string; address: Address; signature: string; takeover?: boolean }) => call<{ address: Address }>("POST", "/api/bind", b),
  intent: (id: string) => call<IntentDto>("GET", `/api/intent/${id}`),
  complete: (id: string, b: { status: "submitted" | "done" | "failed"; txHash?: string }) =>
    call<{ ok: boolean; status: "pending" | "done" | "failed"; reason?: string; txHash?: string }>("POST", `/api/intent/${id}/complete`, b),
  claimInfo: (link: Address) => call<ClaimInfo>("GET", `/api/claim/${link}`),
  splits: () => call<{ created: SplitDto[]; owed: SplitDto[]; contacts: string[] }>("GET", "/api/splits"),
  createSplit: (b: { total: string; title: string; people: Array<{ raw: string; amount?: string; bps?: number }>; includeMe: boolean; dueAt?: number | null }) =>
    call<{ id: string; notReached: string[] }>("POST", "/api/splits", b),
  split: (id: string) => call<SplitDto>("GET", `/api/split/${id}`),
  payShare: (id: string, idx: number | null) => call<IntentDto>("POST", `/api/split/${id}/pay`, idx === null ? {} : { idx }),
  remindSplit: (id: string) => call<{ reminded: string[]; queued: string[]; links: Array<{ label: string; link: string }>; skipped: string[] }>("POST", `/api/split/${id}/remind`, {}),
  cancelSplit: (id: string) => call<{ ok: boolean }>("POST", `/api/split/${id}/cancel`, {}),
  payRequest: (id: string) => call<IntentDto>("POST", `/api/request/${id}/pay`, {}),
  position: () => call<PositionDto>("GET", "/api/position"),
  market: () => call<{ source: string; prices: Array<[number, number]>; oracle: number }>("GET", "/api/market"),
  activity: (limit = 30, offset = 0) => call<{ items: ActivityItem[]; more: boolean }>("GET", `/api/activity?limit=${limit}&offset=${offset}`),
  liveToken: () => call<{ token: string; url: string }>("POST", "/api/live/token", {}),
  disconnect: () => call<{ ok: boolean; disconnected: Address | null }>("POST", "/api/disconnect", {}),
  handoff: (b: { purpose: "link" } | { purpose: "intent"; intentId: string }) => call<{ token: string; expires: number; url: string }>("POST", "/api/handoff", b),
  createIntent: (b: Record<string, unknown>) => call<IntentDto>("POST", "/api/intent", b),
  claimRelay: (b: { link: Address; to: Address; signature: string }) => call<{ txHash: string }>("POST", "/api/claim/relay", b),
}

/** Server view of the user's position. Every big number is a decimal string of an 18-decimal integer. */
export interface PositionDto {
  linked: boolean
  address?: Address
  user: { firstName: string | null; username: string | null }
  wallet?: { btc: string; musd?: string }
  kind?: "guardian" | "direct" | "none"
  guardianAddress?: Address | null
  trove?: { coll: string; debt: string; icr: string; liqPrice: string; bufferBps: number; risk: string; interestRateBps: number } | null
  guardian?: { enabled: boolean; minIcr: string; targetIcr: string; tipBps: number; cooldown: number; reserveBTC: string; reserveMUSD: string; canProtect: boolean } | null
  redemption?: { ahead: string; rank: number; total: number } | null
  system?: { price: string; tcr: string; recoveryMode: boolean; minNetDebt: string; borrowingRate: string; interestRateBps: number }
}

export interface ClaimInfo {
  sender: Address
  senderName: string | null
  amount: string
  expiry: number
  settled: boolean
  status: "open" | "claimed" | "cancelled" | "expired"
  claimedBy: string | null
  /** KeelPay contract holding the link (older links live on the previous KeelPay). */
  pay?: Address
}

/** A bill split as one viewer sees it (bot/src/splits.ts `view`). Amounts are 18-decimal integer strings. */
export interface SplitDto {
  id: string
  title: string
  total: string
  mine: string
  includeMe: boolean
  status: "collecting" | "open" | "settled" | "cancelled"
  dueAt: number | null
  createdAt: number
  creator: { name: string; isMe: boolean }
  shares: Array<{ idx: number; label: string; amount: string; status: "pending" | "paid"; tx: string | null; paidAt: number | null; isMe: boolean; link?: string }>
  collected: string
  remaining: string
  myShare: number | null
}

/** One history row; the bot's /history uses the same feed (bot/src/history.ts). */
export interface ActivityItem {
  id: string
  type: string
  status: "confirmed" | "pending" | "failed"
  /** 18-decimal integer string. */
  amount: string | null
  asset: "MUSD" | "BTC" | null
  counterparty: string | null
  memo: string | null
  tx: string | null
  at: number
  params: Record<string, string>
}

/** Public on-chain stats (bot/src/stats.ts). Amounts are 18-decimal integer strings. */
export interface StatsDto {
  network: string
  updatedAt: number
  excludedTeam: boolean
  guardians: number
  wallets: number
  activeLoans: number
  musdBorrowed: string
  btcCollateral: string
  protections: ProtectionDto[]
  revenue?: { protocolFeesBTC: string; protocolFeesMUSD: string; tipsBTC: string; tipsMUSD: string; treasury: string | null; feeBps: number | null }
  contracts: Array<{ name: string; address: string; version: string; verified: boolean }>
}

export interface ProtectionDto {
  tx: string
  block: number
  at: number
  guardian: string
  kind: "full" | "partial" | "insufficient"
  btcAdded: string
  musdRepaid: string
  icrBefore: string
  icrAfter: string
  price: string | null
  trigger: "price" | "owner" | "unknown"
  team: boolean
}
