import { useState } from "react"
import { faucetUrl, pctChange, summarizeBalances } from "@keel/shared"
import type { PositionDto } from "../lib/api"
import { openExternal } from "../lib/telegram"
import { big, num } from "../lib/units"
import { CountUp, Glass, Segmented, Skeleton, SplitBar } from "./kit"

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const btc = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 6, minimumFractionDigits: n ? 4 : 0 })} BTC`
const musd = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MUSD`

/** BTC/USD change over the last day (or the whole series, labelled 7d, when there is no day-old point). */
export function priceChange(prices: Array<[number, number]>, now = Date.now()): { label: string; value: string } | null {
  if (prices.length < 2) return null
  const last = prices[prices.length - 1][1]
  const dayAgo = [...prices].reverse().find(([t]) => t <= now - 86_400_000)
  if (dayAgo && now - dayAgo[0] < 2 * 86_400_000) {
    const v = pctChange(dayAgo[1], last)
    return v ? { label: "24h", value: v } : null
  }
  const v = pctChange(prices[0][1], last)
  return v ? { label: "7d", value: v } : null
}

/**
 * Wallet BTC and MUSD with their USD value, what is locked in the loan and the protection reserve, and the total,
 * all priced with the MUSD oracle (the same price the risk math uses).
 */
export function BalanceCard({ p, prices, network }: { p: PositionDto | undefined; prices: Array<[number, number]>; network: string }) {
  const [seg, setSeg] = useState<"btc" | "musd">("btc")
  if (!p) {
    return (
      <Glass className="balances">
        <Skeleton h={14} w={90} />
        <Skeleton h={34} w="60%" style={{ marginTop: 10 }} />
        <Skeleton h={10} style={{ marginTop: 16 }} />
        <Skeleton h={56} style={{ marginTop: 14 }} />
      </Glass>
    )
  }
  const price = big(p.system?.price)
  const s = summarizeBalances({
    walletBtc: big(p.wallet?.btc), walletMusd: big(p.wallet?.musd), price,
    loanColl: big(p.trove?.coll), loanDebt: big(p.trove?.debt), reserveBtc: big(p.guardian?.reserveBTC), reserveMusd: big(p.guardian?.reserveMUSD),
  })
  const change = priceChange(prices)
  const faucet = faucetUrl(network as never)
  const empty = s.grossUsd === 0n
  return (
    <Glass className="balances" orb="dim">
      <div className="bal-head">
        <span className="label">Total balance</span>
        <span className="muted tiny">BTC {usd(num(price))}{change && <b className={change.value.startsWith("−") ? "down" : "up"}> {change.value} {change.label}</b>}</span>
      </div>
      <strong className="bal-total"><CountUp value={num(s.grossUsd)} format={usd} /></strong>
      {s.debt > 0n && <small className="muted">After loan debt: <CountUp value={num(s.netUsd)} format={usd} /></small>}

      {empty ? (
        <p className="bal-empty">
          0 BTC — get testnet BTC from the{" "}
          {faucet ? <a href={faucet} onClick={(e) => { e.preventDefault(); openExternal(faucet) }}>faucet</a> : "faucet"}.
        </p>
      ) : (
        <SplitBar parts={[
          { label: "BTC", value: num(s.walletBtcUsd), tone: "black" },
          { label: "MUSD", value: num(s.walletMusdUsd), tone: "red" },
          { label: "In loan", value: num(s.loanCollUsd), tone: "grey" },
          { label: "Reserve", value: num(s.reserveUsd), tone: "rose" },
        ]} />
      )}

      <Segmented<"btc" | "musd"> value={seg} onChange={setSeg} options={[["btc", "BTC"], ["musd", "MUSD"]]} />
      <div className="bal-seg" key={seg}>
        {seg === "btc" ? (
          <>
            <strong className="big"><CountUp value={num(big(p.wallet?.btc))} format={btc} /></strong>
            <small className="muted"><CountUp value={num(s.walletBtcUsd)} format={usd} /> in your wallet</small>
          </>
        ) : (
          <>
            <strong className="big"><CountUp value={num(big(p.wallet?.musd))} format={musd} /></strong>
            <small className="muted"><CountUp value={num(s.walletMusdUsd)} format={usd} /> · 1 MUSD = $1</small>
          </>
        )}
      </div>

      <dl className="rows compact bal-rows">
        <div><dt>Wallet</dt><dd><CountUp value={num(s.walletUsd)} format={usd} /></dd></div>
        <div><dt>In your loan</dt><dd>{p.trove ? <><CountUp value={num(big(p.trove.coll))} format={btc} /> · <CountUp value={num(s.loanCollUsd)} format={usd} /></> : "—"}</dd></div>
        <div><dt>In protection reserve</dt><dd>{s.reserveUsd > 0n ? <><CountUp value={num(big(p.guardian?.reserveBTC))} format={btc} /> · <CountUp value={num(s.reserveUsd)} format={usd} /></> : "—"}</dd></div>
        {s.debt > 0n && <div><dt>Loan debt</dt><dd>−<CountUp value={num(s.debt)} format={musd} /></dd></div>}
        <div className="bal-sum"><dt>Total</dt><dd><CountUp value={num(s.grossUsd)} format={usd} /></dd></div>
      </dl>
    </Glass>
  )
}
