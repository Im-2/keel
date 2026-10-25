import type { Address } from "viem"
import { handoffToken } from "./telegram"

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
    keel: { guardianFactory: Address; pay: Address } | null
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    // never leave a screen on a spinner forever if the backend is unreachable
    signal: AbortSignal.timeout(method === "GET" ? 20_000 : 60_000),
  }).catch((e: Error) => {
    throw new ApiError(e.name === "TimeoutError" ? "Keel's server is not responding" : "Can't reach Keel's server", 0)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, (data as { code?: string }).code)
  return data as T
}

export const api = {
  config: () => call<AppConfig>("GET", "/api/config"),
  me: () => call<{ tgId: number; username?: string; address: Address | null }>("GET", "/api/me"),
  nonce: () => call<{ nonce: string; message: string }>("POST", "/api/nonce", {}),
  bind: (b: { nonce: string; address: Address; signature: string; takeover?: boolean }) => call<{ address: Address }>("POST", "/api/bind", b),
  intent: (id: string) => call<IntentDto>("GET", `/api/intent/${id}`),
  complete: (id: string, b: { status: "submitted" | "done" | "failed"; txHash?: string }) =>
    call<{ ok: boolean; status: "pending" | "done" | "failed"; reason?: string; txHash?: string }>("POST", `/api/intent/${id}/complete`, b),
  claimInfo: (link: Address) => call<{ sender: Address; amount: string; expiry: number; settled: boolean }>("GET", `/api/claim/${link}`),
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
