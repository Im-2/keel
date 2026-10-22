import type { Address } from "viem"

export interface TgWebApp {
  initData: string
  initDataUnsafe: { start_param?: string; user?: { id: number; username?: string } }
  ready(): void
  expand(): void
  close(): void
  colorScheme?: "light" | "dark"
  themeParams?: Record<string, string>
  openTelegramLink?(url: string): void
  openLink?(url: string): void
  HapticFeedback?: { notificationOccurred(t: "success" | "error" | "warning"): void }
  MainButton?: unknown
}

export const tg = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp

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
}

/** Backend origin when the Mini App is hosted separately from the bot server (set at build time). */
export const apiUrl = (path: string) => `${(import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? ""}${path}`

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { "content-type": "application/json", "x-telegram-init-data": tg?.initData ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status)
  return data as T
}

export const api = {
  config: () => call<AppConfig>("GET", "/api/config"),
  me: () => call<{ tgId: number; username?: string; address: Address | null }>("GET", "/api/me"),
  nonce: () => call<{ nonce: string; message: string }>("POST", "/api/nonce", {}),
  bind: (b: { nonce: string; address: Address; signature: string }) => call<{ address: Address }>("POST", "/api/bind", b),
  intent: (id: string) => call<IntentDto>("GET", `/api/intent/${id}`),
  complete: (id: string, b: { status: "done" | "failed"; txHash?: string }) => call<{ ok: boolean }>("POST", `/api/intent/${id}/complete`, b),
  claimInfo: (link: Address) => call<{ sender: Address; amount: string; expiry: number; settled: boolean }>("GET", `/api/claim/${link}`),
  claimRelay: (b: { link: Address; to: Address; signature: string }) => call<{ txHash: string }>("POST", "/api/claim/relay", b),
}
