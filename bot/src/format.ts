import {
  CCR, E18, MCR, RISK_EMOJI, fmtBtc, fmtIcr, fmtMusd, fmtUsd, parseUnits18, riskLevel,
  type BorrowQuote, type SystemState,
} from "@keel/shared"
import type { UserView } from "./chain"
import type { RequestRow } from "./db"

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** 10-cell gauge from the 110% liquidation line to 250%+. */
export function icrGauge(icr: bigint): string {
  const lo = MCR
  const hi = 25n * E18 / 10n
  const clamped = icr < lo ? lo : icr > hi ? hi : icr
  const filled = Number(((clamped - lo) * 10n) / (hi - lo))
  return "▓".repeat(filled) + "░".repeat(10 - filled)
}

export function positionCard(v: UserView, sys: SystemState): string {
  if (!v.trove) {
    const g = v.guardian ? `\n🛡 Guardian account ready · reserve ${fmtBtc(v.guardian.reserveBTC, 4)}` : ""
    return `<b>No open position yet.</b>\nBTC is <b>${fmtUsd(sys.price, 0)}</b> right now.${g}\n\nTry <code>/borrow 5000</code> to borrow MUSD against your BTC.`
  }
  const t = v.trove
  const lines: string[] = []
  lines.push(`${RISK_EMOJI[riskLevel(t.icr)]} <b>Your position</b> ${v.kind === "guardian" ? "· 🛡 guarded" : "· unguarded"}`)
  lines.push(`Collateral: <b>${fmtBtc(t.coll, 5)}</b> (≈ ${fmtUsd((t.coll * sys.price) / E18, 0)})`)
  lines.push(`Debt: <b>${fmtMusd(t.debt, 2)}</b> · fixed ${(t.interestRateBps / 100).toFixed(2)}% APR`)
  lines.push(`Ratio: <b>${fmtIcr(t.icr)}</b>  <code>${icrGauge(t.icr)}</code>`)
  lines.push(`Liquidation at <b>${fmtUsd(t.liqPrice, 0)}</b> — BTC can fall <b>${(t.bufferBps / 100).toFixed(1)}%</b> first`)
  if (v.redemption) {
    const r = v.redemption
    const next = r.ahead === 0n ? "⚠️ <b>you're next in line</b>" : `${fmtMusd(r.ahead, 0)} must be redeemed before yours`
    lines.push(`Redemption queue: ${next} (rank ${r.rank + 1}/${r.total})`)
  }
  if (sys.recoveryMode) lines.push(`\n🚨 <b>Recovery Mode</b> is active (system ratio ${fmtIcr(sys.tcr)} &lt; ${fmtIcr(CCR)}). Extra collateral helps, new debt is restricted.`)
  const g = v.guardian
  if (g) {
    lines.push(
      g.enabled
        ? `\n🛡 Guardian <b>ON</b> · acts below ${fmtIcr(g.minIcr)}, restores to ${fmtIcr(g.targetIcr)} · reserve ${fmtBtc(g.reserveBTC, 4)}${g.reserveMUSD > 0n ? " + " + fmtMusd(g.reserveMUSD, 0) : ""}`
        : `\n🛡 Guardian <b>OFF</b> · reserve ${fmtBtc(g.reserveBTC, 4)}`,
    )
    if (g.enabled && g.reserveBTC === 0n && g.reserveMUSD === 0n) lines.push("⚠️ The reserve is empty, so protection has nothing to spend. Use /fund.")
  } else {
    lines.push("\n🛡 No guardian yet — /protect turns on auto-protection.")
  }
  return lines.join("\n")
}

export function borrowCard(q: BorrowQuote, sys: SystemState, amount: bigint): string {
  const lines = [
    `${RISK_EMOJI[q.risk]} <b>Borrow ${fmtMusd(amount, 2)}</b>`,
    `Lock: <b>${fmtBtc(q.collateral, 5)}</b> (≈ ${fmtUsd((q.collateral * sys.price) / E18, 0)})`,
    `Fee: ${fmtMusd(q.fee)} (0.1%) + 200 MUSD gas reserve (refunded on repay)`,
    `Total debt: <b>${fmtMusd(q.totalDebt)}</b> · interest ≈ ${fmtMusd(q.annualInterest, 0)}/yr (fixed ${(sys.interestRateBps / 100).toFixed(2)}% APR)`,
    `Ratio: <b>${fmtIcr(q.icr)}</b> <code>${icrGauge(q.icr)}</code>`,
    `Liquidation at <b>${fmtUsd(q.liqPrice, 0)}</b> (BTC now ${fmtUsd(sys.price, 0)}, buffer ${(q.priceBufferBps / 100).toFixed(1)}%)`,
  ]
  for (const w of q.warnings) lines.push(`⚠️ ${esc(w)}`)
  lines.push("\nNothing happens until you review and sign in your own wallet.")
  return lines.join("\n")
}

export function helpText(): string {
  return [
    "<b>Keel</b> — borrow dollars against your Bitcoin without selling it. Non-custodial: you sign everything in your own wallet.",
    "",
    "<b>Your position</b>",
    "/position — ratio, liquidation price, redemption queue",
    "/borrow <code>5000</code> [ratio%] — quote &amp; open a loan",
    "/repay <code>1000</code> · /addcollateral <code>0.05</code>",
    "",
    "<b>Protection</b>",
    "/protect [trigger% target%] — auto-restore your ratio",
    "/fund <code>0.02</code> — top up the BTC reserve",
    "/alerts — liquidation &amp; redemption alerts",
    "",
    "<b>Payments</b>",
    "/send <code>@friend 25</code> [note] — pay MUSD by handle",
    "/claimlink <code>25</code> — send MUSD to someone with no wallet",
    "/request <code>25</code> [note] · /split <code>90 @a @b</code>",
    "",
    "/link — connect your wallet · /stats — keeper network",
  ].join("\n")
}

export function renderRequest(r: RequestRow, requesterName: string): string {
  const lines = [`💸 <b>${esc(requesterName)}</b> requests <b>${fmtMusd(parseUnits18(r.amount), 2)}</b>${r.memo ? ` — ${esc(r.memo)}` : ""}`]
  if (r.participants?.length) {
    lines.push("")
    for (const p of r.participants) {
      const paid = r.paid.find((x) => (p.tg_id && x.tg_id === p.tg_id) || (p.username && x.username?.toLowerCase() === p.username.toLowerCase()))
      lines.push(`${paid ? "✅" : "⏳"} ${p.username ? "@" + esc(p.username) : "member"}`)
    }
  } else if (r.paid.length) {
    lines.push("", ...r.paid.map((p) => `✅ ${p.username ? "@" + esc(p.username) : "paid"}`))
  }
  return lines.join("\n")
}
