import { useQuery } from "@tanstack/react-query"
import { api, type AppConfig } from "../lib/api"
import { LINKS, enterDemo, webSession } from "../lib/web"
import { btcFmt, musdFmt } from "./format"
import "./web.css"

const PILLARS = [
  {
    n: "01",
    title: "Borrow, with guardrails",
    body: "Borrow MUSD against your BTC. Before you sign you see the 0.1% fee, the fixed interest, your ratio and your liquidation price. Loans Mezo would reject are blocked, not just flagged.",
    img: "/shots/borrow-review.jpg",
  },
  {
    n: "02",
    title: "Guardian protection",
    body: "Your loan lives in your own guardian contract. When the ratio falls below your trigger, a permissionless keeper tops it up from a reserve you funded. It can do nothing else.",
    img: "/shots/guardian-topup.jpg",
  },
  {
    n: "03",
    title: "Risk alerts",
    body: "Liquidation distance, your place in Mezo's redemption queue, and Recovery Mode. Every alert comes with a one-tap fix that opens ready to sign.",
    img: "/shots/protection-review.jpg",
  },
  {
    n: "04",
    title: "Payments",
    body: "Send MUSD to any @username, split bills, and send claim links to people without a wallet. They claim in one step and Keel pays the gas.",
    img: "/shots/claim-link.jpg",
  },
]

function embedUrl(u: string) {
  const yt = /(?:youtu\.be\/|v=)([\w-]{11})/.exec(u)
  return yt ? `https://www.youtube-nocookie.com/embed/${yt[1]}` : null
}

export function Landing({ cfg }: { cfg: AppConfig }) {
  const stats = useQuery({ queryKey: ["stats", false], queryFn: () => api.stats(false), staleTime: 60_000, retry: 0 })
  const signedIn = !!webSession()
  const s = stats.data
  const video = LINKS.video
  const embed = video ? embedUrl(video) : null
  const explorer = cfg.network === "mainnet" ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org"

  return (
    <div className="lp">
      <nav className="lp-nav">
        <a className="lp-brand" href="#/about"><img src="/keel-mark-red.svg" width={30} height={30} alt="" /> Keel</a>
        <div className="lp-links">
          <a href="/stats">Live stats</a>
          <a href={LINKS.deck} target="_blank" rel="noopener">Deck</a>
          <a href={LINKS.github} target="_blank" rel="noopener">GitHub</a>
          <a className="lp-btn lp-btn-sm" href="#/app">{signedIn ? "Open app" : "Sign in"}</a>
        </div>
      </nav>

      <header className="lp-hero">
        <div>
          <span className="lp-kicker">Built on Mezo · live on testnet</span>
          <h1>Your BTC-backed<br />dollar account.</h1>
          <p className="lp-lead">
            Borrow MUSD against Bitcoin on Mezo, get protected from liquidation automatically, and send, split and claim payments with anyone.
            In Telegram, or right here in your browser. Non-custodial: you sign everything in your own wallet.
          </p>
          <div className="lp-cta">
            <a className="lp-btn" href="#/app">Open app</a>
            <button className="lp-btn lp-btn-ghost" onClick={enterDemo}>Try the demo, no wallet needed</button>
            <a className="lp-btn lp-btn-quiet" href={LINKS.miniapp} target="_blank" rel="noopener">Open in Telegram ↗</a>
          </div>
        </div>
        <div className="lp-phones" aria-hidden>
          <img src="/shots/dashboard.jpg" alt="" />
          <img src="/shots/chat-send.jpg" alt="" />
        </div>
      </header>

      <section className="lp-stats" aria-label="Live on-chain numbers">
        {s ? (
          <>
            <Stat label="Guardian accounts" value={String(s.guardians)} />
            <Stat label="Unique wallets" value={String(s.wallets)} />
            <Stat label="MUSD borrowed" value={musdFmt(s.musdBorrowed)} />
            <Stat label="BTC collateral" value={btcFmt(s.btcCollateral)} />
            <Stat label="Protections executed" value={String(s.protections.filter((p) => p.kind !== "insufficient").length)} />
          </>
        ) : (
          <p className="lp-muted">{stats.isLoading ? "Reading the chain…" : "Live stats are loading from Mezo testnet."}</p>
        )}
        <a className="lp-more" href="/stats">All stats, protections and transactions →</a>
        {s && <p className="lp-fine">Read from Mezo {s.network} contracts; team and test wallets excluded.</p>}
      </section>

      <section className="lp-section">
        <h2>Four pillars</h2>
        <div className="lp-pillars">
          {PILLARS.map((p) => (
            <article key={p.n} className="lp-pillar">
              <img src={p.img} alt={p.title} loading="lazy" />
              <div>
                <span className="lp-num">{p.n}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-video">
        <h2>See it in two minutes</h2>
        {embed ? (
          <div className="lp-frame"><iframe src={embed} title="Keel demo" allow="encrypted-media; picture-in-picture" allowFullScreen /></div>
        ) : video ? (
          <a className="lp-btn" href={video} target="_blank" rel="noopener">Watch the demo video ↗</a>
        ) : (
          <p className="lp-muted">The demo video link is coming soon. Meanwhile, <button className="lp-link" onClick={enterDemo}>try the demo</button> or read the <a href={LINKS.deck} target="_blank" rel="noopener">deck</a>.</p>
        )}
      </section>

      <section className="lp-section">
        <h2>How it works</h2>
        <ol className="lp-steps">
          <li><b>Ask.</b> In chat or here: “borrow 1800 at 160%”, “protect me at 170”, “send 20 to @ada”.</li>
          <li><b>Review.</b> Keel shows exactly what will happen: fee, interest, ratio, liquidation price, recipient.</li>
          <li><b>Sign.</b> You approve in your own wallet. Keel never holds your keys or your funds.</li>
        </ol>
      </section>

      <section className="lp-section">
        <h2>On-chain, verifiable</h2>
        <p className="lp-muted">Keel's contracts call Mezo's <code>BorrowerOperations</code> directly and hold MUSD and BTC only for the user who owns them.</p>
        <ul className="lp-contracts">
          {(s?.contracts ?? (cfg.deployment.keel ? [{ name: "KeelGuardianFactory", address: cfg.deployment.keel.guardianFactory, version: "", verified: false }, { name: "KeelPay", address: cfg.deployment.keel.pay, version: "", verified: false }] : [])).map((c) => (
            <li key={c.address}>
              <span>{c.name}{c.version ? ` ${c.version}` : ""}</span>
              <a href={`${explorer}/address/${c.address}${c.verified ? "?tab=contract" : ""}`} target="_blank" rel="noopener"><code>{c.address.slice(0, 10)}…{c.address.slice(-8)}</code>{c.verified ? " ✓ verified" : ""} ↗</a>
            </li>
          ))}
        </ul>
      </section>

      <footer className="lp-foot">
        <img src="/mezo-logo.jpg" width={22} height={22} alt="" /> Built on Mezo for the Mezo Buildathon ·
        <a href={LINKS.github} target="_blank" rel="noopener">GitHub</a> · <a href={LINKS.deck} target="_blank" rel="noopener">Deck (PDF)</a> · <a href={LINKS.bot} target="_blank" rel="noopener">@KeelMezoBot</a> · Testnet software, not audited.
      </footer>
    </div>
  )
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="lp-stat"><b>{value}</b><span>{label}</span></div>
)
