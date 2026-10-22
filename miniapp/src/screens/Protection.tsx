import { useEffect, useState } from "react"
import { GAS_BUFFER, SUGGESTED_RESERVE, collateralToTarget, pct } from "@keel/shared"
import { startIntent, usePosition } from "../lib/data"
import { big, fmtBtc, fmtIcr, icrPct, num, toBig } from "../lib/units"
import { Header } from "../ui/shell"
import { Button, Glass, Gauge, MezoBadge, Notice, Rows, Skeleton, Slider, Toggle } from "../ui/kit"
import { IconShield } from "../ui/icons"
import { shortError } from "../components"
import type { AppCtx } from "../App"

export function Protection(_: { ctx: AppCtx }) {
  const pos = usePosition()
  const p = pos.data
  const g = p?.guardian
  const t = p?.trove
  const [enabled, setEnabled] = useState(true)
  const [trigger, setTrigger] = useState(130)
  const [target, setTarget] = useState(150)
  const [fund, setFund] = useState(num(SUGGESTED_RESERVE))
  const [busy, setBusy] = useState<"" | "save" | "fund">("")
  const [err, setErr] = useState("")
  useEffect(() => {
    if (!g) return
    setEnabled(g.enabled)
    if (g.enabled) {
      setTrigger(Math.round(icrPct(big(g.minIcr))))
      setTarget(Math.round(icrPct(big(g.targetIcr))))
    }
  }, [g?.enabled, g?.minIcr, g?.targetIcr])

  if (!p) return (<><Header title="Protection" greeting="Guardian" /><Glass><Skeleton h={160} /></Glass></>)

  const icr = t ? icrPct(big(t.icr)) : 0
  const reserve = big(g?.reserveBTC)
  const topUp = t ? collateralToTarget(big(t.coll), big(t.debt), big(p.system!.price), pct(target)) : 0n
  const btc = big(p.wallet?.btc)
  const fundCap = btc > GAS_BUFFER ? btc - GAS_BUFFER : 0n
  const fundAmt = toBig(Math.min(fund, num(fundCap)))
  const changed = !g || g.enabled !== enabled || Math.round(icrPct(big(g.minIcr))) !== trigger || Math.round(icrPct(big(g.targetIcr))) !== target

  const run = async (kind: "save" | "fund", body: Record<string, unknown>) => {
    setBusy(kind)
    setErr("")
    try {
      await startIntent(body)
    } catch (e) {
      setErr(shortError(e))
      setBusy("")
    }
  }

  return (
    <>
      <Header title="Protection" greeting="Guardian" />
      <Glass orb="gold" className="guard-hero">
        <div className="row-between">
          <div className="guard-title">
            <span className={`shield ${g?.enabled ? "on" : ""}`}><IconShield size={26} /></span>
            <div>
              <h2>Auto-protection</h2>
              <small className="muted">{g?.enabled ? `Acts below ${fmtIcr(big(g.minIcr))}, restores to ${fmtIcr(big(g.targetIcr))}` : "Off"}</small>
            </div>
          </div>
          <Toggle on={enabled} onChange={setEnabled} label="Protection" />
        </div>
        <p className="muted small">If your ratio falls below the trigger, any keeper can top it up from <b>your reserve</b>. It can't touch anything else, and the tip is capped at 1%.</p>
        {t && <div className="center"><Gauge icr={icr} size={170} label="Your ratio now" /></div>}
      </Glass>

      <Glass className={enabled ? "" : "dim"}>
        <span className="label">Trigger · act below {trigger}%</span>
        <Slider value={trigger} min={115} max={250} step={5} onChange={(v) => { setTrigger(v); if (target <= v) setTarget(v + 10) }} marks={[[150, "150%"], [200, "200%"]]} />
        <span className="label" style={{ marginTop: 16 }}>Target · restore to {target}%</span>
        <Slider value={target} min={trigger + 5} max={Math.max(trigger + 10, 300)} step={5} onChange={setTarget} />
        {t && enabled && icr < trigger && (
          <Notice tone="info">Your ratio ({icr.toFixed(1)}%) is already below {trigger}%: the keeper will act within about a minute of saving, using about {fmtBtc(topUp, 4)} from the reserve{reserve < topUp ? ` (the reserve has ${fmtBtc(reserve, 4)}, so it restores you partway)` : ""}.</Notice>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
        <Button busy={busy === "save"} disabled={!changed} onClick={() => run("save", { type: "protect_config", enabled, minIcr: pct(trigger).toString(), targetIcr: pct(target).toString() })}>
          {g ? "Save settings" : "Create guardian & save"}
        </Button>
      </Glass>

      <Glass orb="amber">
        <div className="section-head"><h3>Reserve</h3><strong>{fmtBtc(reserve, 5)}</strong></div>
        <Rows rows={[
          ["Spent only on", "protecting this loan"],
          ["Withdraw", "any time"],
          ...(t ? ([["Needed for a full top-up", fmtBtc(topUp, 4)]] as Array<[string, string]>) : []),
        ]} />
        {reserve === 0n && <Notice>The reserve is empty, so protection has nothing to spend. Add about {fmtBtc(SUGGESTED_RESERVE, 3)}.</Notice>}
        <span className="label" style={{ marginTop: 12 }}>Add {fmtBtc(fundAmt, 4)}</span>
        <Slider value={Math.min(fund, num(fundCap))} min={0} max={Math.max(0.001, num(fundCap))} step={0.0005} onChange={setFund} />
        {fundCap === 0n && <Notice tone="danger">Your wallet needs more than {fmtBtc(GAS_BUFFER, 3)} (kept for fees) to fund the reserve.</Notice>}
        <Button variant="ghost" busy={busy === "fund"} disabled={fundAmt === 0n} onClick={() => run("fund", { type: "fund_reserve", amount: fundAmt.toString() })}>Fund reserve</Button>
      </Glass>
      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}
