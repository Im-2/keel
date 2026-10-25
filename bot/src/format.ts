import {
  CCR, E18, MCR, RISK_EMOJI, fmtBtc, fmtIcr, fmtMusd, fmtUsd, fmtUsdCents, parseUnits18, riskLevel, summarizeBalances,
  type BorrowQuote, type SystemState,
} from "@keel/shared"
import type { UserView } from "./chain"
import type { RequestRow } from "./db"
import type { HistoryItem } from "./history"

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
    return `<b>No open position yet.</b>\nBTC is <b>${fmtUsd(sys.price, 0)}</b> right now.${g}\n\nTry <code>/borrow 1800 160</code> to borrow MUSD against your BTC.`
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
    "💬 <b>Just talk to me</b>, for example:",
    "• <i>borrow 2000 at 180%</i> · <i>pay back 500</i> · <i>add 0.01 btc</i>",
    "• <i>how safe is my loan?</i> · <i>when would I get liquidated?</i>",
    "• <i>what if BTC drops 20%?</i> · <i>what does protection do?</i>",
    "• <i>protect me at 170</i> · <i>turn off protection</i>",
    "• <i>send 20 to @ada for lunch</i> · <i>split 90 with ada, bob and chidi for dinner</i>",
    "• <i>request 30 from the group for pizza</i> · <i>mute alerts</i>",
    "• <i>what's my balance?</i> · <i>show my history</i>",
    "I always repeat the amount and recipient back and show the full quote before anything is signed.",
    "",
    "<b>Or use commands</b>",
    "",
    "<b>Your position</b>",
    "/position — ratio, liquidation price, redemption queue",
    "/balance — BTC, MUSD and total value · /history — recent activity",
    "/borrow <code>1800 160</code> — quote &amp; open a loan (amount, ratio%)",
    "/repay <code>1000</code> · /addcollateral <code>0.05</code>",
    "",
    "<b>Protection</b>",
    "/protect <code>170 180</code> — act below 170%, restore to 180%",
    "/fund <code>0.02</code> — top up the BTC reserve",
    "/alerts — liquidation &amp; redemption alerts",
    "",
    "<b>Payments</b>",
    "/send <code>@friend 25</code> [note] — pay MUSD by handle",
    "/claimlink <code>25</code> — send MUSD to someone with no wallet",
    "/split <code>100 @ada @bob @chidi dinner</code> — equal shares, live card, Pay buttons",
    "   custom: <code>@ada:50 @bob:30</code> or <code>@ada 50% @bob 30%</code> · <code>notme</code> · <code>due friday</code>",
    "   in a group with no names, people tap <b>I'm in</b> and you lock it",
    "/request <code>25</code> [note] — anyone in the group can pay",
    "",
    "/link — connect or switch wallet · /disconnect — unlink it · /stats — keeper network",
  ].join("\n")
}

export function welcomeText(): string {
  return [
    "<b>Keel</b> — borrow dollars against your Bitcoin without selling it, with a guardian that keeps your loan safe.",
    "",
    "• Non-custodial: you sign everything in your own wallet",
    "• Auto-protection against liquidation",
    "• Alerts before redemptions reach you",
    "• Send MUSD to anyone with a link",
    "",
    "💬 No commands needed. Connect your wallet, then just say things like:",
    "<i>borrow 2000 at 180%</i> · <i>how safe is my loan?</i> · <i>what if BTC drops 20%?</i> · <i>send 20 to @ada for lunch</i>",
    "",
    "Built on Mezo's MUSD.",
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

/** Wallet, locked and total figures; the same numbers as the Mini App's balance card. */
export function balanceCard(v: UserView, sys: SystemState, wallet: { btc: bigint; musd: bigint }, faucetUrl?: string): string {
  const b = summarizeBalances({
    walletBtc: wallet.btc, walletMusd: wallet.musd, price: sys.price,
    loanColl: v.trove?.coll, loanDebt: v.trove?.debt, reserveBtc: v.guardian?.reserveBTC, reserveMusd: v.guardian?.reserveMUSD,
  })
  const lines = [
    `💼 <b>Wallet ${fmtUsdCents(b.walletUsd)}</b>`,
    `• BTC <b>${fmtBtc(wallet.btc, 6)}</b> ≈ ${fmtUsdCents(b.walletBtcUsd)}`,
    `• MUSD <b>${fmtMusd(wallet.musd, 2)}</b> ≈ ${fmtUsdCents(b.walletMusdUsd)}`,
  ]
  if (b.lockedUsd > 0n) {
    lines.push("🔒 <b>Locked in Keel</b>")
    if (v.trove) lines.push(`• In your loan: <b>${fmtBtc(v.trove.coll, 5)}</b> ≈ ${fmtUsdCents(b.loanCollUsd)} (debt ${fmtMusd(v.trove.debt, 2)})`)
    if (b.reserveUsd > 0n) lines.push(`• In protection reserve: <b>${fmtBtc(v.guardian!.reserveBTC, 5)}</b>${v.guardian!.reserveMUSD > 0n ? " + " + fmtMusd(v.guardian!.reserveMUSD, 2) : ""} ≈ ${fmtUsdCents(b.reserveUsd)}`)
    lines.push(`Σ <b>Total ${fmtUsdCents(b.grossUsd)}</b> (wallet + locked)${b.debt > 0n ? ` · after debt ${fmtUsdCents(b.netUsd)}` : ""}`)
  }
  lines.push(`<i>BTC at ${fmtUsd(sys.price, 0)} (Mezo price feed).</i>`)
  if (wallet.btc === 0n && faucetUrl) lines.push(`0 BTC — get testnet BTC from the <a href="${faucetUrl}">faucet</a>.`)
  return lines.join("\n")
}

const HISTORY_LABEL: Record<HistoryItem["type"], string> = {
  borrow: "💵 Borrowed", repay: "↩️ Repaid", add_collateral: "➕ Collateral added", fund_reserve: "🔋 Reserve funded", withdraw_reserve: "🔋 Reserve withdrawn",
  protect_config: "🛡 Protection settings", close: "✅ Loan closed", protected: "🛡 Guardian protected your loan", send: "📤 Sent", received: "📥 Received",
  pay_request: "💸 Paid a request", pay_split: "🧾 Paid your share", create_claim: "🎁 Claim link created", claim_claimed: "🎁 Your claim link was claimed", claim_received: "🎁 Claimed from a link", claim_refunded: "↩️ Claim link refunded",
}

const when = (at: number) => {
  const d = new Date(at * 1000)
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]
  return `${mon} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

/** One history row for chat: what, how much, with whom, when, and the explorer link. */
export function historyLine(i: HistoryItem, explorerTx: (tx: string) => string): string {
  let label = HISTORY_LABEL[i.type]
  if (i.type === "protect_config") label = i.params.enabled === "false" ? "🛡 Protection turned off" : `🛡 Protection on (acts below ${fmtIcr(BigInt(i.params.minIcr ?? "0"))})`
  const amt = i.amount && BigInt(i.amount) > 0n ? (i.type === "protected" ? fmtBtc(BigInt(i.amount), 5) : i.asset === "BTC" ? fmtBtc(BigInt(i.amount), 5) : fmtMusd(BigInt(i.amount), 2)) : ""
  const who = i.counterparty ? (i.type === "received" ? ` from ${esc(i.counterparty)}` : i.type === "claim_claimed" ? ` by ${esc(i.counterparty)}` : i.type === "send" || i.type === "pay_split" ? ` to ${esc(i.counterparty)}` : i.type === "create_claim" ? ` for ${esc(i.counterparty)}` : "") : ""
  const extra = i.type === "protected" && i.params.icrBefore ? ` · ${fmtIcr(BigInt(i.params.icrBefore))} → ${fmtIcr(BigInt(i.params.icrAfter))}` : ""
  const status = i.status === "pending" ? " ⏳ <i>pending</i>" : i.status === "failed" ? " ❌ <i>reverted</i>" : ""
  const memo = i.memo ? ` “${esc(i.memo)}”` : ""
  const link = i.tx ? ` · <a href="${explorerTx(i.tx)}">tx</a>` : ""
  return `${label}${who}${amt ? ` <b>${amt}</b>` : ""}${extra}${memo}${status}\n   <i>${when(i.at)}</i>${link}`
}
