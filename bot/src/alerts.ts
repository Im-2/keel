import { CCR, E18, collateralToTarget, maxPartialRepay, explorerTx, fmtBtc, fmtIcr, fmtMusd, fmtUsd, pct } from "@keel/shared"
import type { Address } from "viem"
import type { ChainService, UserView } from "./chain"
import type { Config } from "./config"
import type { Store, UserRow } from "./db"
import type { Notifier, NotifyButton } from "./notify"

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
  private minNetDebt = 0n
  constructor(private d: AlertDeps, private freeEvery = 1) {}

  /** One pass over linked users. Safe to call repeatedly: every alert is deduplicated in the store. */
  async tick(): Promise<void> {
    const { store, chain } = this.d
    this.ticks++
    const sys = await chain.system(true)
    this.minNetDebt = sys.minNetDebt
    let users = store.boundUsers()
    const full = this.ticks % this.freeEvery === 0
    if (!full) users = users.filter((u) => this.d.isPremium?.(u.tg_id))

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
    // Recovery Mode is global state: only on full ticks, so free users are never skipped
    if (full) await this.recoveryMode(users, views, sys.recoveryMode, sys.tcr)
  }

  /**
   * One-tap protection: each button is a ready-made intent (add collateral, repay, fund the reserve, turn protection
   * on) that opens straight on the Mini App's review-and-sign screen. Amounts are sized to reach `target`.
   */
  private protectButtons(u: UserRow, v: UserView, target: bigint): NotifyButton[][] {
    const t = v.trove
    if (!t) return []
    const { store, config } = this.d
    const open = (id: string) => `${config.miniappUrl}/#/i/${id}`
    const rows: NotifyButton[][] = []
    // round the BTC top-up up to 0.00001 so it always reaches the target
    const step = 10n ** 13n
    const addBtc = ((collateralToTarget(t.coll, t.debt, t.price, target) + step - 1n) / step) * step
    if (addBtc > 0n) {
      const i = store.createIntent(u.tg_id, "add_collateral", { amount: addBtc.toString() })
      rows.push([{ text: `🛡 Add ${fmtBtc(addBtc, 5)} → ${fmtIcr(target)}`, webApp: open(i.id) }])
    }
    // or repay enough debt to reach the same ratio, if Mezo's minimum net debt leaves room for it
    const maxDebt = (t.coll * t.price) / target
    let repay = t.debt > maxDebt ? t.debt - maxDebt : 0n
    repay = ((repay + E18 - 1n) / E18) * E18
    if (repay > 0n && repay <= maxPartialRepay(t.debt, this.minNetDebt)) {
      const i = store.createIntent(u.tg_id, "repay", { amount: repay.toString() })
      rows.push([{ text: `💵 Repay ${fmtMusd(repay, 0)} → ${fmtIcr(target)}`, webApp: open(i.id) }])
    }
    const g = v.guardian
    if (!g?.enabled) {
      const i = store.createIntent(u.tg_id, "protect_config", { enabled: true, minIcr: pct(130).toString(), targetIcr: pct(150).toString(), tipBps: 20, cooldown: 300 })
      rows.push([{ text: "🤖 Turn on auto-protection (130% → 150%)", webApp: open(i.id) }])
    } else if (g.reserveBTC < addBtc) {
      const i = store.createIntent(u.tg_id, "fund_reserve", { amount: (addBtc - g.reserveBTC).toString() })
      rows.push([{ text: `🔋 Fund reserve +${fmtBtc(addBtc - g.reserveBTC, 5)}`, webApp: open(i.id) }])
    }
    return rows
  }

  private async recoveryMode(users: UserRow[], views: Map<number, UserView>, on: boolean, tcr: bigint) {
    const { store, notifier } = this.d
    const prev = store.getKv("recovery_mode")
    store.setKv("recovery_mode", on ? "1" : "0")
    if (prev === null || (prev === "1") === on) return
    for (const u of users) {
      if (u.settings.muted) continue
      if (!on) {
        await notifier.send(u.tg_id, `✅ <b>Recovery Mode is over</b> — the system ratio is back above ${fmtIcr(CCR)}.`)
        continue
      }
      const v = views.get(u.tg_id)
      const t = v?.trove
      const exposed = !!t && t.icr < CCR + pct(10)
      const target = t && t.icr > CCR ? t.icr + pct(10) : CCR + pct(10)
      await notifier.send(
        u.tg_id,
        `🚨 <b>Recovery Mode is ON</b> (system ratio ${fmtIcr(tcr)} is under ${fmtIcr(CCR)}).\nLoans below ${fmtIcr(CCR)} can be liquidated and new borrowing is restricted.` +
          (t ? `\nYour ratio: <b>${fmtIcr(t.icr)}</b>${exposed ? " — <b>inside the danger zone</b>. Tap to protect it:" : " — above the line; more collateral keeps it that way."}` : ""),
        { buttons: t && v ? this.protectButtons(u, v, target) : [] },
      )
    }
  }

  /**
   * "Your reserve can't fully protect your loan, add X BTC". Two cases, each sent once until it clears:
   *  - coverage: protection is on and the loan is getting close to the trigger, but if it fell to the trigger the
   *    reserve couldn't bring it back to the target;
   *  - stuck (guardian v2): the loan is under the trigger and the reserve can't do anything Mezo would accept
   *    (in Normal Mode a top-up that leaves the loan under 110% is rejected), so the guardian can't act at all.
   * Amounts include a 2% margin for interest and price moves, rounded up to 0.00001 BTC.
   */
  private async reserveAlerts(u: UserRow, v: UserView) {
    const { store, notifier, config } = this.d
    const t = v.trove
    const g = v.kind === "guardian" ? v.guardian : null
    if (!t || !g?.enabled) {
      store.setAlert(u.tg_id, "reserve", "ok")
      return
    }
    const step = 10n ** 13n
    const withMargin = (x: bigint) => (((x * 102n) / 100n + step - 1n) / step) * step
    const fundButton = (amount: bigint, label: string): NotifyButton[][] => {
      const i = store.createIntent(u.tg_id, "fund_reserve", { amount: amount.toString() })
      return [[{ text: label, webApp: `${config.miniappUrl}/#/i/${i.id}` }]]
    }
    const prev = store.getAlert(u.tg_id, "reserve")?.value ?? "ok"

    if (g.rescue?.result === "insufficient" && t.icr < g.minIcr) {
      const short = g.rescue.btcShortfallToMCR > 0n ? g.rescue.btcShortfallToMCR : g.rescue.btcShortfallToTarget
      if (prev !== "stuck") {
        store.setAlert(u.tg_id, "reserve", "stuck")
        const add = withMargin(short)
        if (!u.settings.muted && add > 0n) {
          await notifier.send(
            u.tg_id,
            `🚨 <b>Your guardian can't act yet.</b> Your ratio is <b>${fmtIcr(t.icr)}</b>, under your ${fmtIcr(g.minIcr)} trigger, and the reserve (${fmtBtc(g.reserveBTC, 5)}) is too small for a top-up Mezo would accept` +
              (t.icr < pct(110) && !g.rescue.recoveryMode ? ` (below 110%, Mezo only accepts a top-up that lifts the loan back over 110%).` : ".") +
              `
Add <b>${fmtBtc(add, 5)}</b> to the reserve and the next keeper check rescues it.`,
            { buttons: fundButton(add, `🔋 Add ${fmtBtc(add, 5)} to the reserve`) },
          )
        }
      }
      return
    }

    // what a rescue from the trigger back to the target costs: the ratio scales with collateral at a fixed price
    const need = (t.coll * (g.targetIcr - g.minIcr)) / g.minIcr
    const needWithTip = (need * BigInt(10_000 + g.tipBps)) / 10_000n
    const short = g.reserveMUSD === 0n && needWithTip > g.reserveBTC ? needWithTip - g.reserveBTC : 0n
    const close = t.icr < g.minIcr + pct(25)
    if (short > 0n && g.reserveBTC > 0n && close) {
      if (prev === "ok") {
        store.setAlert(u.tg_id, "reserve", "short")
        const add = withMargin(short)
        if (!u.settings.muted) {
          await notifier.send(
            u.tg_id,
            `🔋 <b>Your reserve can't fully protect your loan.</b> If your ratio falls to ${fmtIcr(g.minIcr)}, bringing it back to ${fmtIcr(g.targetIcr)} takes about ${fmtBtc(needWithTip, 5)}; the reserve holds ${fmtBtc(g.reserveBTC, 5)}.
Add <b>${fmtBtc(add, 5)}</b> so your guardian can do the whole job${g.version >= 2 ? " (until then it does as much as the reserve allows)" : ""}.`,
            { buttons: fundButton(add, `🔋 Add ${fmtBtc(add, 5)} to the reserve`) },
          )
        }
      }
    } else if (short === 0n && prev !== "ok") {
      store.setAlert(u.tg_id, "reserve", "ok")
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
        const g = v.kind === "guardian" ? v.guardian : null
        const action = g?.enabled
          ? g.reserveBTC > 0n || g.reserveMUSD > 0n
            ? `Your guardian tops you up automatically below ${fmtIcr(g.minIcr)}. Or act now:`
            : "Protection is on but the reserve is empty, so it can't act. One tap to fix:"
          : "One tap to protect it:"
        // aim comfortably above the warning line, and at least at the guardian's own target
        let target = warn + pct(15)
        if (g?.enabled && g.targetIcr > target) target = g.targetIcr
        await notifier.send(
          u.tg_id,
          `${next === "danger" ? "🔴 <b>Urgent</b>" : "🟠 <b>Heads up</b>"}: your ratio is <b>${fmtIcr(t.icr)}</b>.\nLiquidation at ${fmtUsd(t.liqPrice, 0)} · BTC is ${fmtUsd(t.price, 0)} (${(t.bufferBps / 100).toFixed(1)}% buffer).\n${action}`,
          { buttons: this.protectButtons(u, v, target) },
        )
      } else if (prev !== "ok" && next === "ok") {
        await notifier.send(u.tg_id, `🟢 You're back to a healthy <b>${fmtIcr(t.icr)}</b>.`)
      }
    }

    await this.reserveAlerts(u, v)

    // redemption exposure: how much MUSD must be redeemed before this loan is touched
    if (v.redemption) {
      const limit = BigInt(Math.round(u.settings.redemptionAlertMusd)) * E18
      const flagged = store.getAlert(u.tg_id, "redemption")?.value === "1"
      if (v.redemption.ahead <= limit && !flagged) {
        store.setAlert(u.tg_id, "redemption", "1")
        if (!u.settings.muted) {
          await notifier.send(
            u.tg_id,
            `⚠️ <b>Redemption exposure</b>: only ${fmtMusd(v.redemption.ahead, 0)} sits ahead of your loan in the redemption queue (rank ${v.redemption.rank + 1}/${v.redemption.total}).\nRedemptions are not liquidations, but they swap your collateral for your debt at face value. Raising your ratio moves you back in the queue:`,
            { buttons: this.protectButtons(u, v, t.icr + pct(20)) },
          )
        }
      } else if (flagged && v.redemption.ahead > (limit * 5n) / 4n) {
        store.setAlert(u.tg_id, "redemption", "0")
      }
    }
  }
}
