import type { ReactNode } from "react"
import type { ActivityItem } from "../lib/api"
import { big, fmtBtc, fmtIcr, fmtMusd, timeAgo } from "../lib/units"
import { parseUnits18 } from "@keel/shared"
import { IconBorrow, IconCheck, IconCoin, IconDrop, IconGift, IconMinus, IconPlus, IconSend, IconShield } from "./icons"

interface Described {
  icon: ReactNode
  title: string
  sub: string
  amount: string
  sign: "in" | "out" | "neutral"
}

/** Bot intents store 18-decimal integers, except pay_request which stores a decimal string. */
const amt = (p: Record<string, string>, type: string) => (type === "pay_request" ? parseUnits18(p.amount ?? "0") : big(p.amount))

export function describe(i: ActivityItem): Described {
  const p = i.params
  switch (i.type) {
    case "borrow": return { icon: <IconBorrow />, title: "Borrowed MUSD", sub: "Loan opened", amount: `+${fmtMusd(amt(p, i.type), 0)}`, sign: "in" }
    case "close": return { icon: <IconCheck />, title: "Loan closed", sub: "Collateral returned", amount: "", sign: "neutral" }
    case "repay": return { icon: <IconMinus />, title: "Repaid", sub: "Loan payment", amount: `−${fmtMusd(amt(p, i.type), 2)}`, sign: "out" }
    case "add_collateral": return { icon: <IconPlus />, title: "Added collateral", sub: "Ratio raised", amount: fmtBtc(amt(p, i.type), 5), sign: "neutral" }
    case "fund_reserve": return { icon: <IconDrop />, title: "Funded reserve", sub: "Guardian top-up fuel", amount: fmtBtc(amt(p, i.type), 5), sign: "neutral" }
    case "protect_config": return { icon: <IconShield />, title: String(p.enabled) === "false" ? "Protection off" : "Protection on", sub: String(p.enabled) === "false" ? "Guardian paused" : `Acts below ${fmtIcr(big(p.minIcr))}`, amount: "", sign: "neutral" }
    case "send": return { icon: <IconSend />, title: `Sent${p.label ? " to " + p.label : ""}`, sub: p.memo || "Payment", amount: `−${fmtMusd(amt(p, i.type), 2)}`, sign: "out" }
    case "pay_request": return { icon: <IconCoin />, title: "Paid a request", sub: p.memo || "Group payment", amount: `−${fmtMusd(amt(p, i.type), 2)}`, sign: "out" }
    case "create_claim": return { icon: <IconGift />, title: "Claim link", sub: p.forName ? `For ${p.forName}` : "Escrowed in KeelPay", amount: `−${fmtMusd(amt(p, i.type), 2)}`, sign: "out" }
    case "protected": {
      const did = big(p.btcAdded) > 0n ? `+${fmtBtc(big(p.btcAdded), 5)}` : `−${fmtMusd(big(p.musdRepaid), 2)} debt`
      return { icon: <IconShield />, title: "Guardian top-up", sub: `${fmtIcr(big(p.icrBefore))} → ${fmtIcr(big(p.icrAfter))}`, amount: did, sign: "in" }
    }
    default: return { icon: <IconCoin />, title: i.type, sub: "", amount: "", sign: "neutral" }
  }
}

export function ActivityRow({ item, explorer, index = 0 }: { item: ActivityItem; explorer: string; index?: number }) {
  const d = describe(item)
  const body = (
    <>
      <span className={`act-icon act-${item.type}`}>{d.icon}</span>
      <span className="act-text">
        <strong>{d.title}</strong>
        <small>{d.sub}</small>
      </span>
      <span className="act-right">
        <strong className={`amt-${d.sign}`}>{d.amount}</strong>
        <small>{timeAgo(item.at)}</small>
      </span>
    </>
  )
  return item.tx ? (
    <a className="act-row" href={`${explorer}/tx/${item.tx}`} target="_blank" rel="noreferrer" style={{ animationDelay: `${index * 40}ms` }}>{body}</a>
  ) : (
    <div className="act-row" style={{ animationDelay: `${index * 40}ms` }}>{body}</div>
  )
}

export const explorerFor = (network: string) => (network === "mainnet" ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org")
