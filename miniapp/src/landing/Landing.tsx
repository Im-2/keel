import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { CONTRACTS, LINKS, fetchStats, num, type Stats } from "./data"

// ------------------------------------------------------------------ building blocks

/** A red glass sphere. `depth` 0 (sharp, near) to 3 (soft, far); `speed` drives scroll parallax in motion.ts. */
export function Sphere({ size, depth = 0, speed = 0, style, className = "" }: { size: number; depth?: number; speed?: number; style?: CSSProperties; className?: string }) {
  return <span aria-hidden className={`sph d${depth} ${className}`} data-speed={speed || undefined} style={{ width: size, height: size, ...style }} />
}

function Phone({ src, alt, className = "", eager = false }: { src: string; alt: string; className?: string; eager?: boolean }) {
  return (
    <div className={`phone ${className}`}>
      <div className="phone-screen">
        <img src={src} alt={alt} width={540} height={1107} loading={eager ? "eager" : "lazy"} decoding="async" fetchPriority={eager ? "high" : undefined} />
      </div>
    </div>
  )
}

function Float({ children, className = "", speed = 0, style }: { children: ReactNode; className?: string; speed?: number; style?: CSSProperties }) {
  return <div className={`float ${className}`} data-speed={speed || undefined} style={style}>{children}</div>
}

/** New tab for other sites and documents (PDF/PPTX); same tab for Keel's own pages. */
export const ext = (href: string) =>
  /^https?:\/\//.test(href) || /\.(pdf|pptx)$/.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {}

const Arrow = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const TgIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M21.9 4.3 18.8 19c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.8 8.8-8c.4-.3-.1-.5-.6-.2L6.7 12.8 2 11.3c-1-.3-1-1 .2-1.5L20.6 2.9c.9-.3 1.6.2 1.3 1.4Z" /></svg>

function Btn({ href, children, kind = "primary", external = false }: { href: string; children: ReactNode; kind?: "primary" | "ghost" | "light" | "dark"; external?: boolean }) {
  return (
    <a className={`btn btn-${kind}`} data-magnetic href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      <span>{children}</span>
    </a>
  )
}

/** Words that sharpen from blur as the paragraph scrolls through the viewport (motion.ts scrubs them). */
function Words({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p className={`words ${className}`}>
      <span className="sr-only">{text}</span>
      {text.split(" ").map((w, i) => (
        <span key={i} aria-hidden className="w">{w} </span>
      ))}
    </p>
  )
}

// ------------------------------------------------------------------ sections

function Nav() {
  const [open, setOpen] = useState(false)
  return (
    <header className={`nav ${open ? "open" : ""}`}>
      <div className="nav-inner">
        <a className="brand" href="#top" aria-label="Keel home">
          <img src="/keel-mark-red.svg" width={30} height={30} alt="" />
          <span>Keel</span>
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#product">Product</a>
          <a href="#guardian">Guardian</a>
          <a href="#payments">Payments</a>
          <a href="#developers">Developers</a>
          <a href={LINKS.docs}>Docs</a>
          <a href={LINKS.stats}>Stats</a>
        </nav>
        <div className="nav-cta">
          <a className="btn btn-ghost btn-sm" href={LINKS.telegram} target="_blank" rel="noopener noreferrer"><TgIcon /> <span>Open in Telegram</span></a>
          <a className="btn btn-primary btn-sm" href={LINKS.webApp}><span>Open web app</span></a>
        </div>
        <button className="nav-toggle" aria-expanded={open} aria-controls="mobile-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen(!open)}>
          <span /><span />
        </button>
      </div>
      <div id="mobile-menu" className="nav-sheet" hidden={!open}>
        {[["#product", "Product"], ["#guardian", "Guardian"], ["#payments", "Payments"], ["#developers", "Developers"], [LINKS.docs, "Docs"], [LINKS.stats, "Stats"]].map(([h, l]) => (
          <a key={h} href={h} onClick={() => setOpen(false)}>{l}</a>
        ))}
        <a className="btn btn-primary" href={LINKS.webApp}>Open web app</a>
        <a className="btn btn-ghost" href={LINKS.telegram} target="_blank" rel="noopener noreferrer"><TgIcon /> Open in Telegram</a>
      </div>
    </header>
  )
}

function Hero() {
  return (
    <section className="hero" id="top">
      <Sphere size={420} depth={2} speed={0.6} className="h-s1" />
      <Sphere size={150} depth={0} speed={1.4} className="h-s2" />
      <Sphere size={64} depth={1} speed={2.2} className="h-s3" />
      <Sphere size={260} depth={3} speed={0.3} className="h-s4" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="kicker" data-hero>Built on Mezo · live on testnet</span>
          <h1 data-hero>
            Borrow against<br />your Bitcoin.<br />
            <em>Spend it in Telegram.</em>
          </h1>
          <p className="lead" data-hero>
            Keel turns your BTC into a dollar account. Borrow MUSD on Mezo without selling, let a guardian protect the loan from liquidation, and pay anyone, even friends without a wallet.
          </p>
          <div className="cta-row" data-hero>
            <Btn href={LINKS.webApp}>Open web app <Arrow /></Btn>
            <Btn href={LINKS.telegram} kind="ghost" external><TgIcon /> Open in Telegram</Btn>
          </div>
          <p className="fine" data-hero>Non-custodial: you sign every action in your own wallet. No testnet BTC? <a href={LINKS.demo}>Try the demo</a>.</p>
        </div>
        <div className="hero-visual">
          <Phone src="/lp/dashboard.webp" alt="Keel dashboard: 0.0447 BTC collateral, 2,001 MUSD borrowed, safety ratio 180%" className="hero-phone" eager />
          <Float className="fc-ratio" speed={1.2}>
            <span className="fc-label">Safety ratio</span>
            <b>180.0%</b>
            <span className="pill">● Safe</span>
          </Float>
          <Float className="fc-guard" speed={2}>
            <span className="fc-ico">🛡</span>
            <span><b>Guardian protected your loan</b><small>160% → 179.9% from your reserve</small></span>
          </Float>
          <Float className="fc-sent" speed={0.8}>
            <span className="fc-ico dark">↗</span>
            <span><b>Sent 20 MUSD</b><small>to @ada · confirmed on Mezo</small></span>
          </Float>
        </div>
      </div>
    </section>
  )
}

function Intro() {
  return (
    <section className="intro" aria-label="What Keel does">
      <Sphere size={120} depth={1} speed={1.5} className="i-s1" />
      <div className="wrap">
        <Words text="Your Bitcoin shouldn't sit idle, and you shouldn't have to sell it to live. Keel lets you borrow dollars against it on Mezo, keeps the loan safe while you sleep, and turns those dollars into payments anyone can receive, right where you already chat." />
      </div>
    </section>
  )
}

const FEATURES = [
  { t: "Borrow", d: "Borrow MUSD against BTC from chat or the app. You see the 0.1% fee, fixed interest, ratio and liquidation price before you sign. Loans Mezo would reject are blocked.", n: "01" },
  { t: "Guardian protection", d: "Your loan lives in your own guardian contract. When the ratio falls below your trigger, a permissionless keeper tops it up from a reserve you funded. Nothing else.", n: "02" },
  { t: "Risk alerts", d: "Liquidation distance, your place in Mezo's redemption queue and Recovery Mode, each with a one-tap fix that opens ready to sign.", n: "03" },
  { t: "Payments", d: "Send MUSD to any @username, split bills with live cards, and send claim links to people without a wallet. They claim in one step; Keel pays the gas.", n: "04" },
]

function Features() {
  return (
    <section className="features" id="product">
      <div className="wrap">
        <div className="sec-head" data-reveal>
          <span className="kicker">Product</span>
          <h2>Everything a Bitcoin holder needs, in one account.</h2>
        </div>
        <div className="feat-grid" data-stagger>
          {FEATURES.map((f, i) => (
            <article className="feat" data-tilt key={f.t}>
              <Sphere size={58} depth={0} className={`feat-sph v${i}`} />
              <span className="feat-n">{f.n}</span>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function Expand() {
  return (
    <section className="expand-wrap" aria-label="One app in Telegram and in the browser">
      <div className="expand" data-expand>
        <Sphere size={340} depth={2} speed={0.5} className="e-s1" />
        <Sphere size={90} depth={0} speed={1.6} className="e-s2" />
        <div className="wrap expand-grid">
          <div className="expand-copy" data-reveal>
            <span className="kicker on-red">Ready-made Mini App</span>
            <h2>One account, two doors.</h2>
            <p>Open Keel as a Mini App right inside Telegram, or in any browser with wallet sign-in. Same loan, same guardian, same history.</p>
            <div className="cta-row">
              <Btn href={LINKS.telegram} kind="light" external><TgIcon /> In Telegram</Btn>
              <Btn href={LINKS.webApp} kind="dark">In the browser <Arrow /></Btn>
            </div>
          </div>
          <div className="expand-visual">
            <div className="browser" data-speed="0.5">
              <div className="browser-bar"><i /><i /><i /><span>keel-miniapp.vercel.app</span></div>
              <div className="browser-body">
                <img src="/lp/activity.webp" alt="Keel activity in the browser" loading="lazy" decoding="async" />
                <img src="/lp/dashboard.webp" alt="" loading="lazy" decoding="async" />
              </div>
            </div>
            <Phone src="/lp/chat-send.webp" alt="Keel in a Telegram chat: Send 15 MUSD to @Ethanwizzy, confirmed" className="expand-phone" />
          </div>
        </div>
      </div>
    </section>
  )
}

const G_STEPS = [
  ["BTC falls", "Your loan is healthy at 185%. The price drops and the ratio slides toward your 170% trigger."],
  ["The keeper acts", "Below the trigger, anyone may call protect(). Keel's keeper does, within a minute."],
  ["The reserve tops up", "The guardian moves BTC from your reserve into the loan: back to 180%. It can't move funds anywhere else."],
  ["Too small a reserve?", "Guardian v2 rescues as far as the reserve allows and tells you exactly how much BTC to add."],
]

function GuardianScene() {
  const R = 92
  const C = Math.PI * R // half circle
  return (
    <section className="guardian" id="guardian" data-pin>
      <div className="wrap guardian-grid">
        <div className="g-copy">
          <span className="kicker">Guardian</span>
          <h2>Protection that acts while you sleep.</h2>
          <ol className="g-steps">
            {G_STEPS.map(([t, d], i) => (
              <li key={t} data-gstep={i}><b>{t}</b><span>{d}</span></li>
            ))}
          </ol>
          <p className="fine">On Mezo testnet the keeper took a real loan from 159.9% to 179.9% in about a minute. <a href={LINKS.status} target="_blank" rel="noopener noreferrer">See the transactions</a>.</p>
        </div>
        <div className="g-visual" aria-hidden>
          <Sphere size={200} depth={2} className="g-s1" />
          <div className="g-card">
            <div className="g-top"><span>BTC</span><b data-g="price">$93,000</b></div>
            <svg viewBox="0 0 220 130" className="g-gauge">
              <path d={`M18 112 A${R} ${R} 0 0 1 202 112`} className="g-track" />
              <path d={`M18 112 A${R} ${R} 0 0 1 202 112`} className="g-arc" data-g="arc" style={{ strokeDasharray: C, strokeDashoffset: C * 0.4 }} />
              <line x1="110" y1="112" x2="110" y2="34" className="g-trigger" data-g="trig" />
            </svg>
            <div className="g-value"><b data-g="icr">185.0%</b><span data-g="state">Safe</span></div>
            <div className="g-keeper" data-g="keeper"><span className="dot" /> Keeper called <code>protect()</code></div>
            <div className="g-reserve">
              <div className="g-reserve-top"><span>Reserve</span><b data-g="res">0.0050 BTC</b></div>
              <div className="g-bar"><i data-g="bar" /></div>
            </div>
            <div className="g-done" data-g="done">🛡 Guardian protected your loan</div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Payments() {
  return (
    <section className="payments" id="payments">
      <Sphere size={300} depth={3} speed={0.4} className="p-s1" />
      <Sphere size={110} depth={0} speed={1.8} className="p-s2" />
      <div className="wrap">
        <div className="sec-head center" data-reveal>
          <span className="kicker">Payments</span>
          <h2>Pay anyone. Even without a wallet.</h2>
          <p className="lead">Every payment settles in MUSD on Mezo and shows as sent only once it's confirmed.</p>
        </div>
        <div className="pay-stage">
          <Phone src="/lp/chat-send.webp" alt="Sending MUSD to a username in chat" className="pay-phone l" />
          <Phone src="/lp/claim-link.webp" alt="A claim link for 5 MUSD ready to share" className="pay-phone c" />
          <Phone src="/lp/claim-success.webp" alt="5 MUSD claimed, Keel paid the gas" className="pay-phone r" />
          <Float className="pc pc-send" speed={1.6}><span className="fc-ico dark">↗</span><span><b>Send</b><small>“send 20 to @ada for lunch”</small></span></Float>
          <Float className="pc pc-split" speed={2.4}>
            <span className="fc-label">Split · Dinner</span>
            <b>90 MUSD · 3 people</b>
            <span className="split-bar"><i style={{ width: "33%" }} /></span>
            <small>@bob paid · 2 to go</small>
          </Float>
          <Float className="pc pc-claim" speed={1.1}><span className="fc-ico">🎁</span><span><b>Claim link · 5 MUSD</b><small>No wallet needed · Keel pays the gas</small></span></Float>
        </div>
        <div className="pay-cols" data-stagger>
          <div><h3>Send</h3><p>To any @username on Keel or any 0x address. The recipient gets a Telegram notice.</p></div>
          <div><h3>Split bills</h3><p>Equal, custom or percentage shares. A live card fills in as each payment confirms on-chain.</p></div>
          <div><h3>Claim links</h3><p>Escrowed in KeelPay. Share a link; the recipient claims in one step. Unclaimed links refund after 72 hours.</p></div>
        </div>
      </div>
    </section>
  )
}

function BuiltOnMezo() {
  return (
    <section className="mezo" id="developers">
      <div className="wrap">
        <div className="logos" data-stagger>
          <span className="logo-mezo"><img src="/mezo-logo.jpg" width={34} height={34} alt="" /> Mezo</span>
          <span>MUSD</span>
          <span>Bitcoin</span>
          <span>Telegram</span>
        </div>
        <div className="mezo-grid">
          <div data-reveal>
            <span className="kicker">Built on Mezo</span>
            <h2>Real MUSD, real Bitcoin collateral, contracts you can read.</h2>
            <p className="lead">Guardians call Mezo's <code>BorrowerOperations</code> directly and read <code>TroveManager</code>, <code>PriceFeed</code> and <code>SortedTroves</code>. Every rule (110% MCR, 1,800 MUSD minimum, Recovery Mode) is built into each quote.</p>
          </div>
          <ul className="contracts" data-stagger>
            {CONTRACTS.map((c) => (
              <li key={c.address}>
                <span>{c.name}</span>
                <a href={c.url} target="_blank" rel="noopener noreferrer"><code>{c.address.slice(0, 6)}…{c.address.slice(-4)}</code>{c.verified && <em> ✓ verified</em>} <Arrow /></a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

function StatsBand() {
  const [s, setS] = useState<Stats | null>(null)
  const [outside, setOutside] = useState<Stats | null>(null)
  const [state, setState] = useState<"loading" | "waking" | "ok" | "down">("loading")
  useEffect(() => {
    const ctl = new AbortController()
    let tries = 0
    const sig = () => (AbortSignal.any ? AbortSignal.any([ctl.signal, AbortSignal.timeout(12_000)]) : ctl.signal)
    const load = () =>
      Promise.all([fetchStats(sig(), true), fetchStats(sig(), false)])
        .then(([all, ext]) => {
          setS(all)
          setOutside(ext)
          setState("ok")
        })
        .catch(() => {
          if (ctl.signal.aborted) return
          // the free host sleeps when idle: give it time to wake, then try again
          if (++tries < 4) {
            setState("waking")
            setTimeout(load, 15_000)
          } else setState("down")
        })
    load()
    return () => ctl.abort()
  }, [])
  const items: Array<[string, number, (n: number) => string]> = s
    ? [
        ["Guardian accounts", s.guardians, (n) => String(Math.round(n))],
        ["Unique wallets", s.wallets, (n) => String(Math.round(n))],
        ["MUSD borrowed", num(s.musdBorrowed), (n) => Math.round(n).toLocaleString("en-US")],
        ["Protections executed", s.protections.filter((p) => p.kind !== "insufficient").length, (n) => String(Math.round(n))],
      ]
    : []
  return (
    <section className="stats" aria-label="Live stats">
      <div className="wrap">
        <div className="stats-head" data-reveal>
          <span className="kicker on-dark">Live from Mezo testnet</span>
          <a href={LINKS.stats} className="stats-link">All stats and transactions <Arrow /></a>
        </div>
        {s ? (
          <div className="stats-grid" data-stats>
            {items.map(([label, value, fmt]) => (
              <div key={label} className="stat">
                <b data-count={value} data-fmt={label === "MUSD borrowed" ? "int" : "plain"}>{fmt(value)}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="stats-wait">{state === "down" ? <>Keel's free server is asleep right now. <a href={LINKS.stats}>Open the stats page</a> to wake it.</> : state === "waking" ? "Waking Keel's server (the free host sleeps when idle)…" : "Reading the chain…"}</p>
        )}
        {s && s.protections.length > 0 && (
          <ul className="prot-list">
            {s.protections.slice(0, 3).map((p) => (
              <li key={p.tx}>
                <span>{p.kind === "partial" ? "Partial rescue" : p.kind === "insufficient" ? "Reserve too small" : "Protected"} · {(num(p.icrBefore) * 100).toFixed(1)}% → {(num(p.icrAfter) * 100).toFixed(1)}%</span>
                <a href={`${LINKS.explorer}/tx/${p.tx}`} target="_blank" rel="noopener noreferrer">{p.tx.slice(0, 10)}… <Arrow /></a>
              </li>
            ))}
          </ul>
        )}
        {outside && (
          <p className="stats-note">
            These totals include the Keel team's own testnet runs. From wallets outside the team so far: {outside.guardians} guardian{outside.guardians === 1 ? "" : "s"}, {outside.protections.filter((p) => p.kind !== "insufficient").length} protection{outside.protections.length === 1 ? "" : "s"}. Testnet software, not audited.
          </p>
        )}
      </div>
    </section>
  )
}

function Rail() {
  const cards = [
    { t: "Pitch deck", d: "Problem, product, Mezo integration, business model and roadmap. PDF, opens in a new tab.", href: LINKS.deck, tag: "PDF", tone: "red" },
    ...(LINKS.video ? [{ t: "Demo video", d: "Two minutes: borrow, protection and payments on Mezo testnet.", href: LINKS.video, tag: "Video", tone: "dark" }] : []),
    { t: "Docs", d: "How Keel works: borrowing, the Guardian, payments, security and contracts.", href: LINKS.docs, tag: "Docs", tone: "dark" },
    { t: "Verified contracts", d: "Every Keel contract, v1 and v2, with its verified source on the Mezo explorer.", href: LINKS.contracts, tag: "Contracts", tone: "coral" },
    { t: "Live stats", d: "Guardians, loans and keeper protections, read straight from the chain.", href: LINKS.stats, tag: "Stats", tone: "light" },
    { t: "GitHub", d: "Contracts, bot, Mini App and tests. GPL-3.0.", href: LINKS.github, tag: "Code", tone: "light" },
  ]
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // drag to scroll with a mouse; touch scrolls natively
    const el = ref.current
    if (!el) return
    // A plain click must reach the card's link: nothing changes until the pointer has really moved (> 6px),
    // and only a click that ends such a drag is cancelled. (Previously the drag state switched off the cards'
    // pointer events on every mousedown, so the click landed on the rail and no link ever opened.)
    let down = false
    let startX = 0
    let start = 0
    let moved = false
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return
      down = true
      moved = false
      startX = e.clientX
      start = el.scrollLeft
    }
    const onMove = (e: PointerEvent) => {
      if (!down) return
      const dx = e.clientX - startX
      if (!moved && Math.abs(dx) <= 6) return
      if (!moved) {
        moved = true
        el.classList.add("dragging")
      }
      el.scrollLeft = start - dx
    }
    const onUp = () => {
      down = false
      el.classList.remove("dragging")
    }
    const onClick = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault()
        e.stopPropagation()
        moved = false
      }
    }
    el.addEventListener("pointerdown", onDown)
    addEventListener("pointermove", onMove)
    addEventListener("pointerup", onUp)
    el.addEventListener("click", onClick, true)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      removeEventListener("pointermove", onMove)
      removeEventListener("pointerup", onUp)
      el.removeEventListener("click", onClick, true)
    }
  }, [])
  return (
    <section className="rail-sec" aria-label="Resources">
      <div className="wrap rail-head" data-reveal>
        <h2>Dig deeper</h2>
        <span className="hint">Drag or swipe → · Deck also as <a href={LINKS.deckPptx} download>PPTX</a></span>
      </div>
      <div className="rail" ref={ref} data-stagger>
        {cards.map((c) => (
          <a key={c.t} className={`rcard ${c.tone}`} href={c.href} {...ext(c.href)} draggable={false}>
            <span className="rtag">{c.tag}</span>
            <Sphere size={c.tone === "red" ? 120 : 84} depth={0} className="rsph" />
            <h3>{c.t}</h3>
            <p>{c.d}</p>
            <span className="rgo"><Arrow /></span>
          </a>
        ))}
      </div>
    </section>
  )
}

function Cta() {
  return (
    <section className="cta" aria-label="Try Keel">
      <Sphere size={360} depth={2} speed={0.5} className="c-s1 light" />
      <Sphere size={120} depth={0} speed={1.4} className="c-s2 light" />
      <div className="wrap cta-grid">
        <div data-reveal>
          <h2>Try Keel on Mezo testnet.</h2>
          <p>Free testnet BTC from the Mezo faucet is all you need. Or look around first with sample data.</p>
          <div className="cta-row">
            <Btn href={LINKS.telegram} kind="light" external><TgIcon /> Open in Telegram</Btn>
            <Btn href={LINKS.webApp} kind="dark">Open web app <Arrow /></Btn>
          </div>
          <a className="cta-demo" href={LINKS.demo}>Or try the demo, no wallet needed →</a>
        </div>
        <figure className="qr" data-reveal>
          <img src="/lp/qr-telegram.svg" width={176} height={176} alt="QR code for t.me/KeelMezoBot/app" loading="lazy" />
          <figcaption>Scan to open in Telegram</figcaption>
        </figure>
      </div>
    </section>
  )
}

function Footer() {
  const cols: Array<[string, Array<[string, string]>]> = [
    ["Product", [["Borrow", "#product"], ["Guardian", "#guardian"], ["Payments", "#payments"], ["Live stats", LINKS.stats], ["Try the demo", LINKS.demo]]],
    ["Developers", [["Docs", LINKS.docs], ["Verified contracts", LINKS.contracts], ["Developer guide", "/docs/developers"], ["GitHub", LINKS.github], ["Testnet evidence", LINKS.status]]],
    ["Mezo", [["mezo.org", LINKS.mezo], ["MUSD source", LINKS.musd], ["Testnet explorer", LINKS.explorer]]],
    ["Resources", [["Pitch deck (PDF)", LINKS.deck], ["Business model", LINKS.business], ["Wave 2 checklist", "/docs/wave2"], ["FAQ", "/docs/faq"], ["@KeelMezoBot", LINKS.bot], ...(LINKS.video ? [["Demo video", LINKS.video] as [string, string]] : [])]],
  ]
  return (
    <footer className="foot" data-footer>
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <a className="brand light" href="#top"><img src="/keel-mark-red.svg" width={34} height={34} alt="" /><span>Keel</span></a>
            <p>A BTC-backed dollar account on Mezo: borrow MUSD, stay protected from liquidation, and pay anyone, in Telegram or the browser.</p>
            <div className="social">
              <a href={LINKS.bot} target="_blank" rel="noopener noreferrer" aria-label="Keel on Telegram"><TgIcon /></a>
              <a href={LINKS.github} target="_blank" rel="noopener noreferrer" aria-label="Keel on GitHub">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" /></svg>
              </a>
            </div>
          </div>
          {cols.map(([h, links]) => (
            <nav key={h} className="foot-col" aria-label={h}>
              <h3 className="foot-h">{h}</h3>
              {links.map(([l, href]) => (
                <a key={l} href={href} {...ext(href)}>{l}</a>
              ))}
            </nav>
          ))}
        </div>
        <div className="foot-bottom">
          <span className="built"><img src="/mezo-logo.jpg" width={20} height={20} alt="" /> Built on Mezo</span>
          <span>Open source under GPL-3.0. Includes MUSD by Mezo / Thesis (GPL-3.0).</span>
          <span>Testnet software, not audited.</span>
        </div>
      </div>
    </footer>
  )
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    // Scroll motion (GSAP, Lenis) starts on the visitor's first scroll, touch, pointer move or key, or after a few
    // seconds: the hero's own entrance is CSS, so nothing here delays or blocks the first paint.
    const EVENTS = ["wheel", "scroll", "touchstart", "pointermove", "keydown"] as const
    let ready: Promise<void> | null = null
    const start = () => {
      if (ready) return ready
      EVENTS.forEach((e) => removeEventListener(e, kick))
      clearTimeout(timer)
      ready = import("./motion").then((m) => {
        if (!cancelled && root.current) cleanup = m.initMotion(root.current)
      })
      return ready
    }
    const kick = () => void start()
    EVENTS.forEach((e) => addEventListener(e, kick, { passive: true, once: true }))
    const timer = setTimeout(kick, 8000)
    // In-page links (#product, #payments…): starting the motion pins the Guardian scene, which inserts a tall
    // spacer above the later sections. Start it first, let the layout settle, then scroll, so the link lands on
    // its section. (Once the motion runs, its own handler takes these clicks and this one steps aside.)
    const onAnchor = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#']")
      const id = a?.getAttribute("href")
      if (!a || !id || id === "#" || !root.current?.contains(a)) return
      const target = id === "#top" ? null : document.querySelector<HTMLElement>(id)
      if (id !== "#top" && !target) return
      e.preventDefault()
      void start().then(() =>
        requestAnimationFrame(() => {
          const lenis = (window as unknown as { __lenis?: { scrollTo(t: HTMLElement | number, o?: object): void } }).__lenis
          if (lenis) lenis.scrollTo(target ?? 0, { offset: -72, duration: 1.2 })
          else if (target) target.scrollIntoView({ behavior: "smooth" })
          else window.scrollTo({ top: 0, behavior: "smooth" })
        }),
      )
    }
    document.addEventListener("click", onAnchor)
    return () => {
      cancelled = true
      clearTimeout(timer)
      EVENTS.forEach((e) => removeEventListener(e, kick))
      document.removeEventListener("click", onAnchor)
      cleanup?.()
    }
  }, [])
  return (
    <div className="lp" ref={root}>
      <a className="skip" href="#main">Skip to content</a>
      <Nav />
      <main id="main">
        <Hero />
        <Intro />
        <Features />
        <Expand />
        <GuardianScene />
        <Payments />
        <BuiltOnMezo />
        <StatsBand />
        <Rail />
        <Cta />
      </main>
      <Footer />
    </div>
  )
}
