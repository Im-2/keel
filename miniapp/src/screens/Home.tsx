import { useState } from "react"
import { tg } from "../lib/api"
import { go, useActivity, useMarket, usePosition } from "../lib/data"
import { big, compact, fmtBtc, fmtIcr, fmtMusd, fmtUsd, icrPct, num, toneOf, E18 } from "../lib/units"
import { Header } from "../ui/shell"
import { Button, Gauge, Glass, MezoBadge, Skeleton, Sparkline, StateView } from "../ui/kit"
import { ActivityRow, explorerFor } from "../ui/activity"
import { IconAlert, IconCheck, IconQueue, IconShield, IconDrop } from "../ui/icons"
import { shortError } from "../components"
import type { AppCtx } from "../App"

export function Home({ ctx }: { ctx: AppCtx }) {
  const pos = usePosition()
  const market = useMarket()
  const act = useActivity()
  const [flipped, setFlipped] = useState(false)
  const name = pos.data?.user.firstName ?? tg?.initDataUnsafe.user?.first_name ?? "there"

  if (pos.error) {
    return (
      <>
        <Header title="Keel" greeting={`Hi, ${name}`} />
        <StateView kind="error" title="Can't load your account" body={`${shortError(pos.error)}. Open Keel from the bot in Telegram.`} action={<Button variant="ghost" onClick={() => pos.refetch()}>Try again</Button>} />
      </>
    )
  }
  const p = pos.data
  const prices = market.data?.prices.map(([, v]) => v) ?? []
  const t = p?.trove
  const g = p?.guardian
  const sys = p?.system
  const price = big(sys?.price)
  const icr = t ? icrPct(big(t.icr)) : 0
  const tone = toneOf(icr)
  // ratio the current loan would have had at each recent price: shows how BTC moves hit you
  const icrSeries = t && prices.length ? prices.map((pr) => (num(big(t.coll)) * pr) / num(big(t.debt)) * 100) : []
  const change = prices.length > 1 ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : 0

  return (
    <>
      <Header title="Dashboard" greeting={`Hi, ${name}`} />

      {!p ? (
        <Glass className="hero"><Skeleton h={22} w="60%" /><Skeleton h={120} style={{ marginTop: 16 }} /></Glass>
      ) : t ? (
        <div className={`flip ${flipped ? "flipped" : ""}`} onClick={() => setFlipped((f) => !f)} role="button" aria-label="Flip card for loan details">
          <div className="flip-inner">
            <Glass className="hero flip-face" orb="gold">
              <div className="hero-head">
                <h2>Your Bitcoin is working</h2>
                <span className={`pill pill-${tone}`}>{tone === "safe" ? <IconCheck size={12} /> : <IconAlert size={12} />}{tone === "safe" ? "Safe" : tone === "warn" ? "Watch" : "At risk"}</span>
              </div>
              <div className="hero-grid">
                <div>
                  <span className="label">Collateral</span>
                  <strong className="big">{fmtBtc(big(t.coll), 4)}</strong>
                  <small className="muted">≈ {fmtUsd((big(t.coll) * price) / E18, 0)}</small>
                  <span className="label" style={{ marginTop: 14 }}>Borrowed</span>
                  <strong className="big">{fmtMusd(big(t.debt), 0)}</strong>
                </div>
                <Gauge icr={icr} size={150} />
              </div>
              <span className="hint">Tap for details</span>
            </Glass>
            <Glass className="hero flip-face flip-back" orb="amber">
              <h2>Loan details</h2>
              <dl className="rows compact">
                <div><dt>Interest</dt><dd>{(t.interestRateBps / 100).toFixed(2)}% APR fixed</dd></div>
                <div><dt>Liquidation price</dt><dd>{fmtUsd(big(t.liqPrice), 0)}</dd></div>
                <div><dt>BTC can fall</dt><dd>{(t.bufferBps / 100).toFixed(1)}%</dd></div>
                <div><dt>Guardian</dt><dd>{g?.enabled ? `On · below ${fmtIcr(big(g.minIcr))}` : "Off"}</dd></div>
                <div><dt>System</dt><dd>{sys?.recoveryMode ? "Recovery Mode" : `Normal · ${fmtIcr(big(sys?.tcr))}`}</dd></div>
              </dl>
              <span className="hint">Tap to flip back</span>
            </Glass>
          </div>
        </div>
      ) : (
        <Glass className="hero" orb="gold">
          <h2>Put your Bitcoin to work</h2>
          <p className="muted">Borrow dollars (MUSD) against your BTC without selling it. A guardian keeps the loan safe.</p>
          <Button onClick={() => go("/borrow")}>Start a loan</Button>
        </Glass>
      )}

      {sys?.recoveryMode && <p className="notice notice-danger">Recovery Mode is active: loans under 150% are easier to liquidate.</p>}

      <Glass className="balance">
        <div>
          <span className="label">Wallet balance</span>
          {p ? <strong className="big">{fmtBtc(big(p.wallet?.btc), 5)}</strong> : <Skeleton h={26} w={140} />}
          <small className="muted">
            BTC {sys ? fmtUsd(price, 0) : "…"}
            {prices.length > 1 && <span className={change >= 0 ? "up" : "down"}> {change >= 0 ? "+" : ""}{change.toFixed(1)}% 7d</span>}
          </small>
        </div>
        <Sparkline values={prices} tone={change >= 0 ? "green" : "red"} width={110} height={44} />
      </Glass>

      <div className="tiles">
        <Glass className="tile" onClick={() => setFlipped(true)}>
          <span className="tile-icon"><IconDrop size={18} /></span>
          <span className="label">Liquidation</span>
          {p ? <strong>{t ? fmtUsd(big(t.liqPrice), 0) : "—"}</strong> : <Skeleton h={20} w={70} />}
          <Sparkline values={icrSeries} tone={tone === "safe" ? "green" : "red"} width={86} height={26} />
          <small className="muted">{t ? `ratio ${fmtIcr(big(t.icr))}` : "no loan"}</small>
        </Glass>
        <Glass className="tile" onClick={() => go("/protect")}>
          <span className="tile-icon"><IconShield size={18} /></span>
          <span className="label">Protection</span>
          {p ? <strong className={g?.enabled ? "up" : ""}>{g?.enabled ? "On" : "Off"}</strong> : <Skeleton h={20} w={50} />}
          <small className="muted">{g ? `reserve ${fmtBtc(big(g.reserveBTC), 5)}` : "no guardian yet"}</small>
        </Glass>
        <Glass className="tile">
          <span className="tile-icon"><IconQueue size={18} /></span>
          <span className="label">Redemption</span>
          {p ? <strong>{p.redemption ? `#${p.redemption.rank + 1}` : "—"}</strong> : <Skeleton h={20} w={50} />}
          <small className="muted">{p?.redemption ? `${compact(num(big(p.redemption.ahead)))} MUSD ahead` : "not in queue"}</small>
        </Glass>
      </div>

      <Glass className="activity">
        <div className="section-head">
          <h3>Recent activity</h3>
          <button className="link-btn" onClick={() => go("/activity")}>See all</button>
        </div>
        {act.isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} h={44} style={{ margin: "8px 0" }} />)
        ) : act.data?.items.length ? (
          act.data.items.slice(0, 4).map((it, i) => <ActivityRow key={it.id} item={it} explorer={explorerFor(ctx.cfg.network)} index={i} />)
        ) : (
          <p className="muted small">Nothing yet. Your loans, protections and payments show up here.</p>
        )}
      </Glass>

      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}
