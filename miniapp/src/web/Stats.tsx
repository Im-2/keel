import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api, type AppConfig, type ProtectionDto } from "../lib/api"
import { LINKS } from "../lib/web"
import { btcFine, btcFmt, musdFmt, pctFmt, toNum, usdFmt } from "./format"
import "./web.css"

const KIND: Record<ProtectionDto["kind"], [string, string]> = {
  full: ["Full rescue", "black"],
  partial: ["Partial rescue", "red"],
  insufficient: ["Reserve too small", ""],
}
const TRIGGER: Record<ProtectionDto["trigger"], string> = {
  price: "BTC price move",
  owner: "Owner's own change",
  unknown: "—",
}

/** Public, read-only numbers straight from Mezo: no account needed. */
export function Stats({ cfg }: { cfg: AppConfig }) {
  const [all, setAll] = useState(false)
  const q = useQuery({ queryKey: ["stats", all], queryFn: () => api.stats(all), refetchInterval: 60_000, retry: 1 })
  const s = q.data
  const explorer = cfg.network === "mainnet" ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org"
  const done = s?.protections.filter((p) => p.kind !== "insufficient") ?? []
  const fees = s?.revenue

  return (
    <div className="lp">
      <nav className="lp-nav">
        <a className="lp-brand" href="/#/about"><img src="/keel-mark-red.svg" width={30} height={30} alt="" /> Keel</a>
        <div className="lp-links">
          <a href="/#/about">About</a>
          <a href={LINKS.deck} target="_blank" rel="noopener">Deck</a>
          <a href={LINKS.github} target="_blank" rel="noopener">GitHub</a>
          <a className="lp-btn lp-btn-sm" href="/#/app">Open app</a>
        </div>
      </nav>

      <section className="lp-section" style={{ paddingTop: 12 }}>
        <h2>Live stats</h2>
        <p className="lp-muted">
          Every number is read from Keel's contracts on Mezo {cfg.network} (chain {cfg.chainId}) and Mezo's own TroveManager and PriceFeed.
          Nothing is typed in by hand. {s && <>Updated {new Date(s.updatedAt * 1000).toLocaleTimeString()}.</>}
        </p>
        <label className="st-toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include the Keel team's own and test wallets
        </label>
      </section>

      {q.isLoading && <p className="lp-muted">Reading the chain… (the first load scans every guardian, so it can take a few seconds)</p>}
      {q.error && <p className="lp-muted">Couldn't load stats right now: {(q.error as Error).message}</p>}

      {s && (
        <>
          <div className="st-grid">
            <Card dark label="Guardian accounts" value={String(s.guardians)} />
            <Card label="Unique wallets" value={String(s.wallets)} />
            <Card label="Open loans" value={String(s.activeLoans)} />
            <Card label="MUSD borrowed (open loans)" value={musdFmt(s.musdBorrowed)} />
            <Card label="BTC collateral" value={btcFmt(s.btcCollateral)} />
            <Card dark label="Protections executed" value={String(done.length)} />
          </div>
          <p className="lp-fine lp-muted">{s.excludedTeam ? "Excludes the deployer, keeper and the team's own test wallets." : "Includes the team's own and test wallets."}</p>

          <section className="lp-section">
            <h2>Protections</h2>
            <p className="lp-muted">Every <code>protect()</code> call that moved funds, read from the guardians' events. The BTC price is Mezo's oracle price at that block. “BTC price move” means the price had fallen since the owner's last change to the loan, so the market (not the owner) pushed the ratio under the trigger.</p>
            {s.protections.length === 0 ? (
              <p className="lp-muted">No protections yet{s.excludedTeam ? " from wallets outside the team. Tick the box above to include the team's own test runs" : ""}.</p>
            ) : (
              <div className="st-table-wrap">
                <table className="st-table">
                  <thead>
                    <tr><th>When</th><th>Result</th><th>Ratio</th><th>Added</th><th>BTC price</th><th>Trigger</th><th>Transaction</th></tr>
                  </thead>
                  <tbody>
                    {s.protections.map((p) => (
                      <tr key={p.tx + p.guardian}>
                        <td>{new Date(p.at * 1000).toLocaleString()}</td>
                        <td><span className={`st-tag ${KIND[p.kind][1]}`}>{KIND[p.kind][0]}</span>{p.team && <span className="st-tag" style={{ marginLeft: 6 }}>team</span>}</td>
                        <td>{pctFmt(p.icrBefore)} → {pctFmt(p.icrAfter)}</td>
                        <td>{toNum(p.btcAdded) > 0 ? `${btcFmt(p.btcAdded)} BTC` : ""}{toNum(p.btcAdded) > 0 && toNum(p.musdRepaid) > 0 ? " + " : ""}{toNum(p.musdRepaid) > 0 ? `${musdFmt(p.musdRepaid)} MUSD repaid` : ""}{toNum(p.btcAdded) === 0 && toNum(p.musdRepaid) === 0 ? "—" : ""}</td>
                        <td>{usdFmt(p.price)}</td>
                        <td>{TRIGGER[p.trigger]}</td>
                        <td><a href={`${explorer}/tx/${p.tx}`} target="_blank" rel="noopener">{p.tx.slice(0, 10)}… ↗</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {fees && (
            <section className="lp-section">
              <h2>Keel revenue</h2>
              <p className="lp-muted">
                Guardian v2 sends a protocol share of each keeper tip to Keel's treasury, on-chain, with a hard cap in the contract
                {fees.feeBps !== null ? ` (currently ${(fees.feeBps / 100).toFixed(2)}% of the amount applied)` : ""}. These are the real totals so far, on testnet.
              </p>
              <div className="st-grid">
                <Card dark label="Protocol fees, BTC" value={btcFine(fees.protocolFeesBTC)} />
                <Card label="Protocol fees, MUSD" value={musdFmt(fees.protocolFeesMUSD)} />
                <Card label="Keeper tips paid, BTC" value={btcFine(fees.tipsBTC)} />
                <Card label="Keeper tips paid, MUSD" value={musdFmt(fees.tipsMUSD)} />
              </div>
              {fees.treasury && <p className="lp-fine lp-muted">Treasury: <a href={`${explorer}/address/${fees.treasury}`} target="_blank" rel="noopener"><code>{fees.treasury}</code></a> · Business model: <a href={`${LINKS.github}/blob/main/docs/BUSINESS.md`} target="_blank" rel="noopener">docs/BUSINESS.md</a></p>}
            </section>
          )}

          <section className="lp-section">
            <h2>Contracts</h2>
            <ul className="lp-contracts">
              {s.contracts.map((c) => (
                <li key={c.address}>
                  <span>{c.name} {c.version}</span>
                  <a href={`${explorer}/address/${c.address}${c.verified ? "?tab=contract" : ""}`} target="_blank" rel="noopener"><code>{c.address}</code>{c.verified ? " ✓ verified source" : ""} ↗</a>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <footer className="lp-foot">Testnet software, not audited. <a href={LINKS.github} target="_blank" rel="noopener">Source on GitHub</a></footer>
    </div>
  )
}

const Card = ({ label, value, dark }: { label: string; value: string; dark?: boolean }) => (
  <div className={`st-card ${dark ? "st-dark" : ""}`}><b>{value}</b><span>{label}</span></div>
)
