import type { Hono } from "hono"
import { formatEther, type Address } from "viem"
import { explorerAddress } from "@keel/shared"
import type { AlertEngine } from "./alerts"
import type { ChainService } from "./chain"
import type { Config } from "./config"
import type { Store } from "./db"
import type { Keeper } from "./keeper"
import type { Notifier } from "./notify"
import type { BlockWatcher } from "./watcher"
import type { LiveBus } from "./live"

/**
 * Operations for an always-on deployment: a schedule that external pingers can drive (so keeper and alerts keep
 * running even if the host's own timers were frozen by a sleep), run records that survive restarts, a keeper-
 * balance watchdog that messages the admins, and a status page.
 */
export interface OpsDeps {
  config: Config
  store: Store
  chain: ChainService
  notifier: Notifier
  alerts: AlertEngine
  watcher?: BlockWatcher
  live?: LiveBus
  keeper?: Keeper
  keeperAddress?: Address
  /** Resolves the bot's identity (getMe); used to show whether Telegram is reachable. */
  botInfo: () => Promise<{ username?: string }>
  mode: "webhook" | "polling"
  /** Below this the keeper can't pay gas for many more protections. */
  minKeeperBtc?: number
  now?: () => number
}

interface RunRecord {
  at: number
  ok: boolean
  ms: number
  detail?: string
}

const LOW_WARN_EVERY = 12 * 3600

export class Ops {
  readonly startedAt = Date.now()
  private running = new Set<string>()
  constructor(private d: OpsDeps) {}

  private now() {
    return this.d.now?.() ?? Math.floor(Date.now() / 1000)
  }
  private record(name: string, r: RunRecord) {
    this.d.store.setKv(`status:${name}_last`, JSON.stringify(r))
  }
  lastRun(name: string): RunRecord | null {
    const raw = this.d.store.getKv(`status:${name}_last`)
    return raw ? (JSON.parse(raw) as RunRecord) : null
  }

  /** Run a job unless the same job is still running (internal timer and external pinger can overlap). */
  private async once(name: string, fn: () => Promise<string | undefined>) {
    if (this.running.has(name)) return
    this.running.add(name)
    const t0 = Date.now()
    try {
      const detail = await fn()
      this.record(name, { at: this.now(), ok: true, ms: Date.now() - t0, detail })
    } catch (e) {
      this.record(name, { at: this.now(), ok: false, ms: Date.now() - t0, detail: (e as Error).message.split("\n")[0].slice(0, 200) })
    } finally {
      this.running.delete(name)
    }
  }

  runKeeper() {
    return this.once("keeper", async () => {
      if (!this.d.keeper) return "no keeper key configured"
      const done = await this.d.keeper.tick()
      await this.checkKeeperBalance()
      return done.length ? `protected ${done.join(", ")}` : "nothing to protect"
    })
  }

  runAlerts() {
    return this.once("alerts", async () => {
      await this.d.alerts.tick()
      return undefined
    })
  }

  runWatcher() {
    return this.once("watcher", async () => {
      if (!this.d.watcher) return "off"
      const r = await this.d.watcher.tick()
      return r ? `blocks ${r.from}–${r.to}, ${r.added} new` : "waiting for blocks"
    })
  }

  async keeperBalance(): Promise<bigint | null> {
    if (!this.d.keeperAddress) return null
    return this.d.chain.balance(this.d.keeperAddress)
  }

  /** Message the admins (at most every 12h) when the keeper is running out of gas money. */
  async checkKeeperBalance(): Promise<{ balance: bigint; low: boolean } | null> {
    const bal = await this.keeperBalance()
    if (bal === null) return null
    const min = BigInt(Math.round((this.d.minKeeperBtc ?? 0.001) * 1e6)) * 10n ** 12n
    const low = bal < min
    if (low) {
      const last = Number(this.d.store.getKv("ops:low_balance_warned") ?? 0)
      if (this.now() - last > LOW_WARN_EVERY) {
        this.d.store.setKv("ops:low_balance_warned", String(this.now()))
        const msg =
          `⛽ <b>Keeper wallet is low</b>: ${formatEther(bal)} BTC (warning below ${formatEther(min)}).\n` +
          `It pays gas for automatic protections and gasless claim links. Send testnet BTC to <code>${this.d.keeperAddress}</code>.`
        for (const id of this.d.config.adminIds) {
          await this.d.notifier.send(id, msg, { buttonText: "Keeper on the explorer", buttonUrl: explorerAddress(this.d.config.network, this.d.keeperAddress!) })
        }
      }
    }
    return { balance: bal, low }
  }

  async status() {
    const t0 = Date.now()
    const [rpc, bot, keeper] = await Promise.all([
      this.d.chain.blockNumber().then((b) => ({ ok: true, block: b.toString(), ms: Date.now() - t0 }), (e: Error) => ({ ok: false, error: e.message.slice(0, 120) })),
      this.d.botInfo().then((b) => ({ ok: true, username: b.username, mode: this.d.mode }), (e: Error) => ({ ok: false, error: e.message.slice(0, 120), mode: this.d.mode })),
      this.keeperBalance().then(
        (bal) => {
          if (bal === null) return { configured: false }
          const min = BigInt(Math.round((this.d.minKeeperBtc ?? 0.001) * 1e6)) * 10n ** 12n
          return { configured: true, address: this.d.keeperAddress, balanceBtc: formatEther(bal), low: bal < min, minBtc: formatEther(min) }
        },
        (e: Error) => ({ configured: true, address: this.d.keeperAddress, error: e.message.slice(0, 120) }),
      ),
    ])
    return {
      ok: rpc.ok && bot.ok,
      network: this.d.config.network,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      bot,
      rpc,
      keeper: { ...keeper, lastRun: this.lastRun("keeper") },
      alerts: { lastRun: this.lastRun("alerts") },
      watcher: { lastRun: this.lastRun("watcher"), cursor: this.d.store.getKv("watch_block"), liveClients: this.d.live?.connections() ?? 0 },
      database: { rows: this.d.store.counts(), mirrored: !!process.env.TURSO_DATABASE_URL, mirrorBacklog: this.d.store.mirrorBacklog, mirrorError: this.d.store.mirrorError },
    }
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const ago = (at?: number) => {
  if (!at) return "never"
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

export function mountOps(app: Hono<any>, ops: Ops, cronSecret: string | undefined) {
  // (/healthz, the host's cheap liveness check, is served by api.ts)
  app.get("/status.json", async (c) => c.json(await ops.status()))

  app.get("/status", async (c) => {
    const s = await ops.status()
    const k = s.keeper as Record<string, unknown> & { lastRun: { at: number; ok: boolean; detail?: string } | null }
    const a = s.alerts.lastRun
    const dot = (ok: boolean | undefined) => `<span class="dot ${ok ? "ok" : "bad"}">${ok ? "✓" : "!"}</span>`
    const row = (label: string, ok: boolean | undefined, value: string) => `<tr><td>${dot(ok)}${esc(label)}</td><td>${value}</td></tr>`
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Keel status</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f6f7;color:#0a0a0a}main{max-width:640px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{color:#555;margin:0 0 16px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e3e5;border-radius:14px;overflow:hidden}td{padding:12px 14px;border-bottom:1px solid #eee;vertical-align:top}td:last-child{text-align:right;font-variant-numeric:tabular-nums;word-break:break-all}.dot{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;margin-right:8px;font-size:12px;font-weight:700;color:#fff}.ok{background:#111}.bad{background:#c40500}code{font-size:12px}</style></head>
<body><main><h1>Keel status</h1><p>${esc(s.network)} · up ${esc(Math.round(s.uptimeSec / 60))} min${s.commit ? ` · build ${esc(s.commit)}` : ""} · refreshes every 30s</p><table>
${row("Telegram bot", s.bot.ok, s.bot.ok ? `@${esc((s.bot as { username?: string }).username)} (${esc(s.bot.mode)})` : esc((s.bot as { error?: string }).error))}
${row("Mezo RPC", s.rpc.ok, s.rpc.ok ? `block ${esc((s.rpc as { block: string }).block)} · ${esc((s.rpc as { ms: number }).ms)} ms` : esc((s.rpc as { error?: string }).error))}
${row("Keeper wallet", k.configured ? !k.low && !k.error : false, k.configured ? `${esc(k.balanceBtc ?? "?")} BTC${k.low ? ` — <b>LOW</b>, top up (min ${esc(k.minBtc)})` : ""}<br><code>${esc(k.address)}</code>` : "not configured")}
${row("Last keeper run", k.lastRun?.ok, k.lastRun ? `${esc(ago(k.lastRun.at))} · ${esc(k.lastRun.detail ?? "")}` : "never")}
${row("Last alerts run", a?.ok, a ? `${esc(ago(a.at))}${a.ok ? "" : " · " + esc(a.detail)}` : "never")}
${row("Block watcher", s.watcher.lastRun?.ok, s.watcher.lastRun ? `${esc(ago(s.watcher.lastRun.at))} · ${esc(s.watcher.lastRun.detail ?? "")} · ${esc(s.watcher.liveClients)} live` : "never")}
${row("Database", !s.database.mirrorError, `${esc(Object.entries(s.database.rows).map(([t, n]) => `${t} ${n}`).join(" · "))}<br>${s.database.mirrored ? `mirrored to Turso${s.database.mirrorBacklog ? `, ${esc(s.database.mirrorBacklog)} pending` : ""}` : "local only"}${s.database.mirrorError ? `<br>${esc(s.database.mirrorError)}` : ""}`)}
</table></main></body></html>`)
  })

  // External schedule (cron-job.org every minute): runs keeper + alerts and keeps a sleeping host awake.
  const tick = async (c: { req: { query(k: string): string | undefined; header(k: string): string | undefined }; json: (v: unknown, s?: number) => Response }) => {
    const key = c.req.query("key") ?? c.req.header("x-cron-key")
    if (!cronSecret || key !== cronSecret) return c.json({ error: "forbidden" }, 403)
    // answer at once; the jobs run in the background (cron services time out after ~30s)
    void ops.runKeeper()
    void ops.runAlerts()
    void ops.runWatcher()
    return c.json({ ok: true, keeper: ops.lastRun("keeper"), alerts: ops.lastRun("alerts") })
  }
  app.get("/cron/tick", tick as never)
  app.post("/cron/tick", tick as never)
}
