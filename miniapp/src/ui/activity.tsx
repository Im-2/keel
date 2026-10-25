import { useEffect, useState, type ReactNode } from "react"
import { claimKeyForLink } from "../lib/claimkeys"
import { go, startIntent } from "../lib/data"
import type { ActivityItem } from "../lib/api"
import { big, fmtBtc, fmtIcr, fmtMusd, timeAgo } from "../lib/units"
import { IconBorrow, IconCheck, IconCoin, IconDrop, IconGift, IconMinus, IconPlus, IconSend, IconShield } from "./icons"

interface Described {
  icon: ReactNode
  title: string
  sub: string
  amount: string
  sign: "in" | "out" | "neutral"
}

const who = (i: ActivityItem, pre: string) => (i.counterparty ? `${pre} ${i.counterparty}` : "")

export function describe(i: ActivityItem): Described {
  const p = i.params
  const a = big(i.amount)
  const musd = (d = 2) => fmtMusd(a, d)
  switch (i.type) {
    case "borrow": return { icon: <IconBorrow />, title: "Borrowed MUSD", sub: "Loan proceeds", amount: `+${musd(0)}`, sign: "in" }
    case "close": return { icon: <IconCheck />, title: "Loan closed", sub: "Collateral returned", amount: "", sign: "neutral" }
    case "repay": return { icon: <IconMinus />, title: "Repaid", sub: "Loan payment", amount: a ? `−${musd()}` : "", sign: "out" }
    case "add_collateral": return { icon: <IconPlus />, title: "Added collateral", sub: "Ratio raised", amount: fmtBtc(a, 5), sign: "neutral" }
    case "fund_reserve": return { icon: <IconDrop />, title: "Funded reserve", sub: "Guardian top-up fuel", amount: fmtBtc(a, 5), sign: "neutral" }
    case "withdraw_reserve": return { icon: <IconDrop />, title: "Reserve withdrawn", sub: "Back to your wallet", amount: fmtBtc(a, 5), sign: "neutral" }
    case "protect_config": return { icon: <IconShield />, title: String(p.enabled) === "false" ? "Protection off" : "Protection on", sub: String(p.enabled) === "false" ? "Guardian paused" : `Acts below ${fmtIcr(big(p.minIcr))}`, amount: "", sign: "neutral" }
    case "send": return { icon: <IconSend />, title: `Sent${who(i, " to")}`, sub: i.memo || "Payment", amount: `−${musd()}`, sign: "out" }
    case "received": return { icon: <IconCoin />, title: `Received${who(i, " from")}`, sub: i.memo || "Payment", amount: `+${musd()}`, sign: "in" }
    case "pay_request": return { icon: <IconCoin />, title: "Paid a request", sub: i.memo || "Group payment", amount: `−${musd()}`, sign: "out" }
    case "create_claim": {
      const st = p.linkStatus === "claimed" ? `Claimed by ${p.claimedBy ?? "someone"}` : p.linkStatus === "cancelled" ? "Cancelled, refunded" : p.linkStatus === "open" ? "Not claimed yet" : "Escrowed in KeelPay"
      return { icon: <IconGift />, title: `Claim link${i.counterparty ? ` for ${i.counterparty}` : ""}`, sub: st, amount: `−${musd()}`, sign: "out" }
    }
    case "pay_split": return { icon: <IconCoin />, title: `Paid ${i.counterparty ?? "a split"}`, sub: i.memo ? `${i.memo} · split` : "Your share", amount: `−${musd()}`, sign: "out" }
    case "claim_claimed": return { icon: <IconGift />, title: "Your link was claimed", sub: i.counterparty ? `By ${i.counterparty}` : "Claimed", amount: musd(), sign: "neutral" }
    case "claim_received": return { icon: <IconGift />, title: "Claimed a link", sub: "Gift received", amount: `+${musd()}`, sign: "in" }
    case "claim_refunded": return { icon: <IconGift />, title: "Claim link refunded", sub: "Back in your wallet", amount: `+${musd()}`, sign: "in" }
    case "protected": {
      const did = big(p.btcAdded) > 0n ? `+${fmtBtc(big(p.btcAdded), 5)}` : `−${fmtMusd(big(p.musdRepaid), 2)} debt`
      return { icon: <IconShield />, title: "Guardian top-up", sub: p.icrBefore ? `${fmtIcr(big(p.icrBefore))} → ${fmtIcr(big(p.icrAfter))}` : "Protected", amount: did, sign: "in" }
    }
    default: return { icon: <IconCoin />, title: i.type, sub: "", amount: "", sign: "neutral" }
  }
}

export function ActivityRow({ item, explorer, index = 0, fresh = false }: { item: ActivityItem; explorer: string; index?: number; fresh?: boolean }) {
  const d = describe(item)
  const cls = `act-row${fresh ? " act-new" : ""}${item.status !== "confirmed" ? ` act-${item.status}` : ""}`
  const body = (
    <>
      <span className={`act-icon act-${item.type}`}>{d.icon}</span>
      <span className="act-text">
        <strong>{d.title}</strong>
        <small>{item.status === "pending" ? <><span className="spinner tiny-spin" aria-hidden /> Confirming on Mezo…</> : item.status === "failed" ? "Failed: reverted on-chain" : d.sub}</small>
      </span>
      <span className="act-right">
        <strong className={`amt-${item.status === "failed" ? "neutral struck" : d.sign}`}>{d.amount}</strong>
        <small>{timeAgo(item.at)}</small>
      </span>
    </>
  )
  const row = item.tx ? (
    <a className={cls} href={`${explorer}/tx/${item.tx}`} target="_blank" rel="noreferrer" style={{ animationDelay: `${index * 40}ms` }}>{body}</a>
  ) : (
    <div className={cls} style={{ animationDelay: `${index * 40}ms` }}>{body}</div>
  )
  // an unclaimed link: share it again (if this phone made it) or take the money back
  if (item.type === "create_claim" && item.params.linkStatus === "open" && item.status === "confirmed") {
    return (
      <>
        {row}
        <div className="act-actions">
          {claimKeyForLink(item.params.link) && <button className="link-btn" onClick={() => go(`/i/${item.id}`)}>Share again</button>}
          <button className="link-btn danger" onClick={() => void startIntent({ type: "cancel_claim", link: item.params.link })}>Cancel & refund</button>
        </div>
      </>
    )
  }
  return row
}

// rows already on screen (any screen), so a refetch only highlights what's actually new or changed state
const seen = new Map<string, string>()
let primed = false

/** Ids to highlight: rows that just appeared (a received transfer, a protection) or changed state (pending → confirmed). */
export function useNewRows(items: ActivityItem[] | undefined): Set<string> {
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!items) return
    const changed = items.filter((i) => seen.get(i.id) !== i.status && !(i.tx && seen.get(i.tx) === i.status)).map((i) => i.id)
    for (const i of items) {
      seen.set(i.id, i.status)
      if (i.tx) seen.set(i.tx, i.status)
    }
    if (!primed) {
      primed = true
      return
    }
    if (!changed.length) return
    setFresh(new Set(changed))
    const t = setTimeout(() => setFresh(new Set()), 2600)
    return () => clearTimeout(t)
  }, [items])
  return fresh
}

export const explorerFor = (network: string) => (network === "mainnet" ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org")
