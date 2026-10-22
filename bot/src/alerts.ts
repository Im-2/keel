import { CCR, E18, explorerTx, fmtBtc, fmtIcr, fmtMusd, fmtUsd, pct } from "@keel/shared"
import type { Address } from "viem"
import type { ChainService, UserView } from "./chain"
import type { Config } from "./config"
import type { Store, UserRow } from "./db"
import type { Notifier } from "./notify"

type Level = "ok" | "warn" | "danger"
const HYSTERESIS = pct(5) // ratio must recover 5 points above a threshold before the alert re-arms

export interface AlertDeps {
  config: Pick<Config, "network" | "miniappUrl">
  store: Store
  chain: ChainService
  notifier: Notifier
  /** Premium users get checked on every tick; free users every `freeEvery`-th tick. */
  isPremium?: (tgId: number) => boolean
}

export class AlertEngine {
  private ticks = 0
  constructor(private d: AlertDeps, private freeEvery = 1) {}

  /** One pass over linked users. Safe to call repeatedly: every alert is deduplicated in the store. */
  async tick(): Promise<void> {
    const { store, chain } = this.d
    this.ticks++
    const sys = await chain.system(true)
    let users = store.boundUsers()
    const full = this.ticks % this.freeEvery === 0
    if (!full) users = users.filter((u) => this.d.isPremium?.(u.tg_id))

    await this.recoveryMode(users, sys.recoveryMode, sys.tcr)

    const views = new Map<number, UserView>()
    for (const u of users) {
      try {
        const v = await chain.view(u.address as Address)
        views.set(u.tg_id, v)
        await this.positionAlerts(u, v)
      } catch (e) {
        console.warn(`alerts: user ${u.tg_id}`, (e as Error).message)
      }
    }
    if (full) await this.eventAlerts(users, views)
  }

  private async recoveryMode(users: UserRow[], on: boolean, tcr: bigint) {
    const { store, notifier } = this.d
    const prev = store.getKv("recovery_mode")
    store.setKv("recovery_mode", on ? "1" : "0")
    if (prev === null || (prev === "1") === on) return
    for (const u of users) {
      if (u.settings.muted) continue
      await notifier.send(
        u.tg_id,
        on
          ? `🚨 <b>Recovery Mode is ON</b> (system ratio ${fmtIcr(tcr)} is under ${fmtIcr(CCR)}).\nLoans below ${fmtIcr(CCR)} are easier to liquidate and new borrowing is restricted. Adding collateral is the safest move: /position`
          : `✅ <b>Recovery Mode is over</b> — the system ratio is back above ${fmtIcr(CCR)}.`,
      )
    }
  }

  private async positionAlerts(u: UserRow, v: UserView) {
    const { store, notifier } = this.d
    const t = v.trove
    if (!t) {
      store.setAlert(u.tg_id, "icr", "ok")
      return
    }
    const warn = pct(u.settings.warnIcr * 100)
    const danger = pct(u.settings.dangerIcr * 100)
    const prev = (store.getAlert(u.tg_id, "icr")?.value ?? "ok") as Level

    // state machine with hysteresis: escalate immediately, de-escalate only after a clear recovery
    let next: Level = prev
    if (t.icr < danger) next = "danger"
    else if (t.icr < warn) next = prev === "danger" && t.icr < danger + HYSTERESIS ? "danger" : "warn"
    else if (t.icr >= warn + HYSTERESIS) next = "ok"
    else next = prev === "danger" ? "warn" : prev
    if (next !== prev) store.setAlert(u.tg_id, "icr", next)

    if (!u.settings.muted) {
      if (next !== prev && next !== "ok" && !(prev === "danger" && next === "warn")) {
        const guarded = v.kind === "guardian" && v.guardian?.enabled
        const action = guarded ? "Your guardian will step in automatically if it keeps falling." : "Add collateral or repay now, or turn on /protect."
        await notifier.send(
          u.tg_id,
          `${next === "danger" ? "🔴 <b>Urgent</b>" : "🟠 <b>Heads up</b>"}: your ratio is <b>${fmtIcr(t.icr)}</b>.\nLiquidation at ${fmtUsd(t.liqPrice, 0)} · BTC is ${fmtUsd(t.price, 0)} (${(t.bufferBps / 100).toFixed(1)}% buffer).\n${action}`,
        )
      } else if (prev !== "ok" && next === "ok") {
        await notifier.send(u.tg_id, `🟢 You're back to a healthy <b>${fmtIcr(t.icr)}</b>.`)
      }
    }

    // redemption exposure: how much MUSD must be redeemed before this loan is touched
    if (v.redemption) {
      const limit = BigInt(Math.round(u.settings.redemptionAlertMusd)) * E18
      const flagged = store.getAlert(u.tg_id, "redemption")?.value === "1"
      if (v.redemption.ahead <= limit && !flagged) {
        store.setAlert(u.tg_id, "redemption", "1")
        if (!u.settings.muted) {
          await notifier.send(
            u.tg_id,
            `⚠️ <b>Redemption exposure</b>: only ${fmtMusd(v.redemption.ahead, 0)} sits ahead of your loan in the redemption queue (rank ${v.redemption.rank + 1}/${v.redemption.total}).\nRedemptions are not liquidations, but they convert your collateral. Raising your ratio moves you back in the queue.`,
          )
        }
      } else if (flagged && v.redemption.ahead > (limit * 5n) / 4n) {
        store.setAlert(u.tg_id, "redemption", "0")
      }
    }
  }

  private async eventAlerts(users: UserRow[], views: Map<number, UserView>) {
    const { store, chain, notifier, config } = this.d
    const head = await chain.blockNumber()
    const last = store.getKv("alerts_block")
    store.setKv("alerts_block", head.toString())
    if (last === null) return
    const from = BigInt(last) + 1n
    if (from > head) return

    const byGuardian = new Map<string, UserRow>()
    const byWallet = new Map<string, UserRow>()
    for (const u of users) {
      const g = views.get(u.tg_id)?.guardianAddress
      if (g) byGuardian.set(g.toLowerCase(), u)
      byWallet.set(u.address!.toLowerCase(), u)
    }
    for (const e of await chain.protectedEvents([...byGuardian.keys()] as Address[], from, head)) {
      const u = byGuardian.get(e.guardian.toLowerCase())
      if (!u) continue
      store.setKv("stat:protections", String(Number(store.getKv("stat:protections") ?? "0") + 1))
      if (u.settings.muted) continue
      const did = [e.btcAdded > 0n ? `added ${fmtBtc(e.btcAdded, 5)}` : "", e.musdRepaid > 0n ? `repaid ${fmtMusd(e.musdRepaid, 2)}` : ""].filter(Boolean).join(" and ")
      await notifier.send(u.tg_id, `🛡 <b>Guardian protected your loan</b>: ${did} from your reserve.\nRatio ${fmtIcr(e.icrBefore)} → <b>${fmtIcr(e.icrAfter)}</b>.`, {
        buttonText: "View transaction",
        buttonUrl: explorerTx(config.network, e.tx),
      })
    }
    for (const e of await chain.incomingTransfers([...byWallet.keys()] as Address[], from, head)) {
      const u = byWallet.get(e.to.toLowerCase())
      if (!u || u.settings.muted || e.value === 0n) continue
      const s = store.findByAddress(e.from)
      const who = s ? (s.username ? "@" + s.username : s.first_name ?? "a Keel user") : `${e.from.slice(0, 8)}…`
      await notifier.send(u.tg_id, `💸 You received <b>${fmtMusd(e.value, 2)}</b> from ${who}.`, { buttonText: "View transaction", buttonUrl: explorerTx(config.network, e.tx) })
    }
  }
}
