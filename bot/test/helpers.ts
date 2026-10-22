import { Bot } from "grammy"
import { E18, pct, type SystemState, type TroveState, type GuardianState } from "@keel/shared"
import type { Address } from "viem"
import type { ChainService, UserView, ProtectedEvent, TransferEvent } from "../src/chain"
import type { Config } from "../src/config"
import { createBot } from "../src/bot"
import { Store } from "../src/db"
import type { Notifier, NotifyOpts } from "../src/notify"

export const TOKEN = "123456:TEST-token"
export const ADA: Address = "0x00000000000000000000000000000000000000a1"
export const BOB: Address = "0x00000000000000000000000000000000000000b2"
export const GUARDIAN: Address = "0x00000000000000000000000000000000000000c3"

export const config = {
  botToken: TOKEN, botUsername: "KeelTestBot", network: "local", miniappUrl: "https://app.example", apiPort: 0, dbPath: ":memory:",
  adminIds: [], pollMs: 1000,
  deployment: { network: "local", chainId: 31612, musd: {} as never, keel: { guardianFactory: "0x0000000000000000000000000000000000000f01", pay: "0x0000000000000000000000000000000000000f02" } },
} as unknown as Config

export const sys = (over: Partial<SystemState> = {}): SystemState => ({
  price: 100_000n * E18, tcr: pct(300), recoveryMode: false, minNetDebt: 1800n * E18, borrowingRate: E18 / 1000n, interestRateBps: 100, ...over,
})

export const trove = (icr: bigint, over: Partial<TroveState> = {}): TroveState => ({
  troveOwner: ADA, active: true, coll: E18, debt: 40_000n * E18, icr, price: 100_000n * E18, liqPrice: 44_000n * E18, bufferBps: 5600, risk: "safe", interestRateBps: 100, ...over,
})

export const guardian = (over: Partial<GuardianState> = {}): GuardianState => ({
  guardian: GUARDIAN, owner: ADA, enabled: true, tipBps: 20, cooldown: 300, minIcr: pct(130), targetIcr: pct(150), reserveBTC: E18 / 10n, reserveMUSD: 0n, canProtect: false, btcToAdd: 0n, musdToRepay: 0n, resultingIcr: 0n, ...over,
})

export class FakeChain implements ChainService {
  deployment = config.deployment
  sysState = sys()
  views = new Map<string, UserView>()
  head = 100n
  protectedLogs: ProtectedEvent[] = []
  transfers: TransferEvent[] = []
  receipts = new Map<string, { ok: boolean; from: Address }>()
  async system() { return this.sysState }
  async view(a: Address): Promise<UserView> {
    return this.views.get(a.toLowerCase()) ?? { kind: "none", address: a, troveOwner: null, trove: null, guardian: null, guardianAddress: null, redemption: null }
  }
  async troves() { return [] }
  async guardianCount() { return 3 }
  async blockNumber() { return this.head }
  btc = 10n * E18
  async balance() { return this.btc }
  async blockTime() { return 1_700_000_000 }
  async receipt(h: string) { return this.receipts.get(h) ?? null }
  async protectedEvents() { return this.protectedLogs }
  async incomingTransfers() { return this.transfers }
  setView(a: Address, v: Partial<UserView>) {
    this.views.set(a.toLowerCase(), { kind: "guardian", address: a, troveOwner: GUARDIAN, trove: null, guardian: null, guardianAddress: GUARDIAN, redemption: null, ...v })
  }
}

export class FakeNotifier implements Notifier {
  sent: Array<{ to: number; text: string; opts?: NotifyOpts }> = []
  async send(to: number, text: string, opts?: NotifyOpts) { this.sent.push({ to, text, opts }) }
}

export interface ApiCall { method: string; payload: Record<string, unknown> }

/** A bot whose Telegram API is replaced by a recorder. */
export function harness(chain = new FakeChain()) {
  const store = new Store(":memory:")
  const calls: ApiCall[] = []
  const bot = new Bot(TOKEN, { botInfo: { id: 1, is_bot: true, first_name: "Keel", username: "KeelTestBot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never })
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: 1, type: "private" } } : true } as never
  })
  createBot({ config, store, chain }, bot)
  let n = 0
  const say = (text: string, from = { id: 42, username: "ada", first_name: "Ada" }, chat: { id: number; type: string } = { id: 42, type: "private" }) => {
    const isCmd = text.startsWith("/")
    return bot.handleUpdate({
      update_id: ++n,
      message: { message_id: n, date: 0, chat, from: { ...from, is_bot: false }, text, entities: isCmd ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : [] },
    } as never)
  }
  const last = () => calls.filter((c) => c.method === "sendMessage").at(-1)
  return { bot, store, chain, calls, say, last }
}
