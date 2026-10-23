import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { GAS_BUFFER, SUGGESTED_RESERVE, closeCost, maxPartialRepay, computeIcr, liquidationPrice, musdAbi, pct, quoteBorrow } from "@keel/shared"
import { startIntent, usePosition } from "../lib/data"
import { big, fmtBtc, fmtIcr, fmtMusd, fmtUsd, num, toBig, E18 } from "../lib/units"
import { Header } from "../ui/shell"
import { Button, Glass, Gauge, Notice, Rows, Segmented, Skeleton, Slider } from "../ui/kit"
import { shortError } from "../components"
import type { AppCtx } from "../App"

type Mode = "borrow" | "repay" | "collateral"

export function Borrow({ ctx }: { ctx: AppCtx }) {
  const pos = usePosition()
  const hasLoan = !!pos.data?.trove
  const [mode, setMode] = useState<Mode>("borrow")
  useEffect(() => {
    if (hasLoan && mode === "borrow") setMode("repay")
  }, [hasLoan])
  return (
    <>
      <Header title={mode === "borrow" ? "Borrow" : mode === "repay" ? "Repay" : "Add collateral"} greeting="Your loan" />
      <Segmented<Mode> value={mode} onChange={setMode} options={[["borrow", "Borrow"], ["repay", "Repay"], ["collateral", "Collateral"]]} />
      {!pos.data ? (
        <Glass><Skeleton h={120} /></Glass>
      ) : mode === "borrow" ? (
        hasLoan ? <Glass><p className="muted">You already have a loan open. Repay or add collateral to manage it.</p></Glass> : <BorrowForm />
      ) : !hasLoan ? (
        <Glass><p className="muted">No open loan yet. Start one on the Borrow tab.</p><Button variant="ghost" onClick={() => setMode("borrow")}>Borrow</Button></Glass>
      ) : mode === "repay" ? (
        <RepayForm ctx={ctx} />
      ) : (
        <CollateralForm />
      )}
    </>
  )
}

function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const submit = async (body: Record<string, unknown>) => {
    setBusy(true)
    setErr("")
    try {
      await startIntent(body)
    } catch (e) {
      setErr(shortError(e))
      setBusy(false)
    }
  }
  return { busy, err, submit }
}

function BorrowForm() {
  const p = usePosition().data!
  const sys = p.system!
  const price = big(sys.price)
  const btc = big(p.wallet?.btc)
  const minNet = num(big(sys.minNetDebt))
  const [ratio, setRatio] = useState(160)
  // largest loan this wallet can open at `ratio`, keeping a fee buffer
  const maxBorrow = useMemo(() => {
    const coll = btc > GAS_BUFFER ? btc - GAS_BUFFER : 0n
    const total = num((coll * price) / pct(ratio))
    return Math.max(0, Math.floor((total - 200) / (1 + num(big(sys.borrowingRate)))))
  }, [btc, price, ratio])
  const [amount, setAmount] = useState(minNet)
  const sliderMax = Math.max(minNet, Math.min(maxBorrow, 50_000))
  const amt = Math.min(Math.max(amount, minNet), sliderMax)
  const q = quoteBorrow({ borrowAmount: toBig(amt), price, borrowingRate: big(sys.borrowingRate), interestRateBps: sys.interestRateBps, minNetDebt: big(sys.minNetDebt), targetIcr: pct(ratio), recoveryMode: sys.recoveryMode })
  const need = q.collateral + GAS_BUFFER
  const short = btc < need
  const { busy, err, submit } = useSubmit()
  return (
    <>
      <Glass orb="gold" className="quote-hero">
        <span className="label">You receive</span>
        <strong className="huge">{fmtMusd(toBig(amt), 0)}</strong>
        <Slider value={amt} min={minNet} max={sliderMax} step={50} onChange={setAmount} format={(v) => `${v} MUSD`} />
        <div className="row-between"><small className="muted">min {minNet.toLocaleString()}</small><small className="muted">max {sliderMax.toLocaleString()}</small></div>
        <span className="label" style={{ marginTop: 18 }}>Safety ratio · {ratio}%</span>
        <Slider value={ratio} min={120} max={300} step={5} onChange={setRatio} marks={[[150, "150%"], [200, "200%"]]} />
      </Glass>
      <Glass className="quote">
        <div className="quote-top">
          <Gauge icr={ratio} size={130} label="Ratio" />
          <div>
            <span className="label">Liquidation price</span>
            <strong>{fmtUsd(q.liqPrice, 0)}</strong>
            <small className="muted">BTC now {fmtUsd(price, 0)}</small>
          </div>
        </div>
        <Rows rows={[
          ["BTC locked", `${fmtBtc(q.collateral, 5)} (≈ ${fmtUsd((q.collateral * price) / E18, 0)})`],
          ["One-time fee (0.1%)", fmtMusd(q.fee, 2)],
          ["Gas reserve (refunded)", "200 MUSD"],
          ["Interest (fixed)", `${(sys.interestRateBps / 100).toFixed(2)}% APR ≈ ${fmtMusd(q.annualInterest, 0)}/yr`],
          ["Total debt", fmtMusd(q.totalDebt, 2)],
        ]} />
        {q.warnings.map((w) => <Notice key={w}>{w}</Notice>)}
        {short ? (
          <Notice tone="danger">Not enough BTC: you need about {fmtBtc(need, 4)} ({fmtBtc(q.collateral, 4)} collateral + {fmtBtc(GAS_BUFFER, 3)} for fees). Your wallet has {fmtBtc(btc, 4)}. Get testnet BTC from the Mezo faucet, or lower the ratio.</Notice>
        ) : (
          <p className="muted small">After this you'll have about {fmtBtc(btc - q.collateral, 4)} left. Keep ~{fmtBtc(SUGGESTED_RESERVE, 3)} for your guardian reserve.</p>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
        <Button busy={busy} disabled={short || q.blocking} onClick={() => submit({ type: "borrow", amount: toBig(amt).toString(), targetIcr: pct(ratio).toString() })}>Review & sign</Button>
      </Glass>
    </>
  )
}

function RepayForm({ ctx }: { ctx: AppCtx }) {
  const p = usePosition().data!
  const t = p.trove!
  const price = big(p.system!.price)
  const coll = big(t.coll)
  const debt = big(t.debt)
  const musd = useQuery({
    queryKey: ["musd", p.address],
    queryFn: () => ctx.pub.readContract({ address: ctx.deployment.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [p.address!] }),
  })
  // Mezo keeps an open loan at or above the minimum net debt; paying off more means closing it
  const maxRepay = maxPartialRepay(debt, big(p.system!.minNetDebt))
  const cap = musd.data !== undefined && musd.data < maxRepay ? musd.data : maxRepay
  const [v, setV] = useState(0)
  const amount = toBig(Math.min(v, num(cap)))
  const newDebt = debt - amount
  const { busy, err, submit } = useSubmit()
  return (
    <Glass orb="amber" className="quote">
      <span className="label">Repay</span>
      <strong className="huge">{fmtMusd(amount, 2)}</strong>
      <Slider value={Math.min(v, num(cap))} min={0} max={Math.max(1, num(cap))} step={1} onChange={setV} />
      <div className="row-between"><small className="muted">wallet {musd.data !== undefined ? fmtMusd(musd.data, 2) : "…"}</small><button className="link-btn" onClick={() => setV(num(cap))}>Max</button></div>
      <Rows rows={[
        ["Fee", "none"],
        ["Debt", `${fmtMusd(debt, 2)} → ${fmtMusd(newDebt, 2)}`],
        ["Ratio", `${fmtIcr(big(t.icr))} → ${fmtIcr(computeIcr(coll, newDebt, price))}`],
        ["Liquidation price", `${fmtUsd(big(t.liqPrice), 0)} → ${fmtUsd(liquidationPrice(coll, newDebt), 0)}`],
      ]} />
      <p className="muted small">{maxRepay === 0n ? `Your loan is at Mezo's ${fmtMusd(big(p.system!.minNetDebt), 0)} minimum, so it can only be paid off by closing it.` : `You can repay up to ${fmtMusd(maxRepay, 2)} and keep the loan open (Mezo's minimum is ${fmtMusd(big(p.system!.minNetDebt), 0)}).`}</p>
      {musd.data === 0n && <Notice>Your wallet has no MUSD to repay with.</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Button busy={busy} disabled={amount === 0n} onClick={() => submit({ type: "repay", amount: amount.toString() })}>Review & sign</Button>
      <Button variant="ghost" disabled={busy} onClick={() => submit({ type: "close" })}>Close loan · pay {fmtMusd(closeCost(debt), 2)}, get {fmtBtc(coll, 5)} back</Button>
    </Glass>
  )
}

function CollateralForm() {
  const p = usePosition().data!
  const t = p.trove!
  const price = big(p.system!.price)
  const btc = big(p.wallet?.btc)
  const coll = big(t.coll)
  const debt = big(t.debt)
  const cap = btc > GAS_BUFFER ? btc - GAS_BUFFER : 0n
  const [v, setV] = useState(0)
  const amount = toBig(Math.min(v, num(cap)))
  const newColl = coll + amount
  const { busy, err, submit } = useSubmit()
  return (
    <Glass orb="gold" className="quote">
      <span className="label">Add</span>
      <strong className="huge">{fmtBtc(amount, 5)}</strong>
      <Slider value={Math.min(v, num(cap))} min={0} max={Math.max(0.0001, num(cap))} step={0.0005} onChange={setV} />
      <div className="row-between"><small className="muted">wallet {fmtBtc(btc, 5)}</small><button className="link-btn" onClick={() => setV(num(cap))}>Max</button></div>
      <Rows rows={[
        ["Fee", "none"],
        ["Ratio", `${fmtIcr(big(t.icr))} → ${fmtIcr(computeIcr(newColl, debt, price))}`],
        ["Liquidation price", `${fmtUsd(big(t.liqPrice), 0)} → ${fmtUsd(liquidationPrice(newColl, debt), 0)}`],
        ["Interest", `unchanged (${(t.interestRateBps / 100).toFixed(2)}% APR)`],
      ]} />
      {cap === 0n && <Notice tone="danger">Your wallet needs more than {fmtBtc(GAS_BUFFER, 3)} BTC (kept for fees). Get testnet BTC from the Mezo faucet.</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Button busy={busy} disabled={amount === 0n} onClick={() => submit({ type: "add_collateral", amount: amount.toString() })}>Review & sign</Button>
    </Glass>
  )
}
