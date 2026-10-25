import { useEffect, useRef, useState } from "react"
import { useConnect, useAccount, useDisconnect } from "wagmi"
import qrcode from "qrcode-generator"
import { api } from "../lib/api"
import { ALL_WALLETS, WALLETS, chosenWallet, openExternal, rememberWallet, type WalletApp } from "../lib/telegram"
import { Button, Glass, KeelMark, MezoBadge, Notice, WalletIcon } from "./kit"
import { IconExternal, IconLink, IconWallet } from "./icons"
import { shortError } from "../components"

export type HandoffTarget = { purpose: "link" } | { purpose: "intent"; intentId: string }

function Qr({ text }: { text: string }) {
  const qr = qrcode(0, "M")
  qr.addData(text)
  qr.make()
  return <div className="qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
}

/**
 * WalletConnect inside Telegram. We start the pairing as soon as the sheet opens, so the URI is ready
 * when the user taps a wallet and the universal link opens inside that tap (Telegram blocks popups and
 * custom schemes; tg.openLink hands https links to the OS, which opens the wallet app).
 */
export function TelegramConnect({ title, handoff, showMark = true }: { title: string; handoff?: HandoffTarget; showMark?: boolean }) {
  const { connectors, connectAsync } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const { status } = useAccount()
  const wc = connectors.find((c) => c.id === "walletConnect")
  const [uri, setUri] = useState<string | null>(null)
  const [picked, setPicked] = useState<WalletApp | null>(chosenWallet() ?? null)
  const [phase, setPhase] = useState<"pairing" | "ready" | "waiting" | "stalled" | "error">("pairing")
  const [err, setErr] = useState("")
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const attempt = useRef(0)

  async function pair() {
    if (!wc) return
    const n = ++attempt.current
    setUri(null)
    setErr("")
    setPhase("pairing")
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type === "display_uri" && n === attempt.current) {
        setUri(String(data))
        setPhase((p) => (p === "pairing" ? "ready" : p))
      }
    }
    wc.emitter.on("message", onMessage)
    try {
      await connectAsync({ connector: wc })
      // success: wagmi's account status flips to connected and the parent re-renders past this sheet
    } catch (e) {
      if (n !== attempt.current) return
      const m = shortError(e)
      // a fresh pairing replaces an expired/rejected one; only surface real errors
      setErr(/reset|closed|expired/i.test(m) ? "" : m)
      setPhase("error")
    } finally {
      wc.emitter.off("message", onMessage)
    }
  }

  useEffect(() => {
    if (status !== "connected") void pair()
    // returning from the wallet app: WalletConnect reconnects its relay on its own; if nothing happened, offer a retry
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      setTimeout(() => setPhase((p) => (p === "waiting" ? "stalled" : p)), 6000)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  function openWallet(w: WalletApp) {
    if (!uri || !w.wc) return
    rememberWallet(w.id)
    setPicked(w)
    setPhase("waiting")
    openExternal(w.wc(uri))
  }

  async function retry() {
    setShowQr(false)
    await disconnectAsync().catch(() => undefined)
    void pair()
  }

  async function walletBrowser(w: WalletApp) {
    if (!handoff || !w.dapp) return
    setHandoffBusy(true)
    try {
      const h = await api.handoff(handoff)
      openExternal(w.dapp(h.url))
    } catch (e) {
      setErr(shortError(e))
    }
    setHandoffBusy(false)
  }

  if (!wc) return <Notice tone="danger">WalletConnect is not configured.</Notice>

  if (phase === "waiting" || phase === "stalled") {
    return (
      <Glass orb="gold" className="connect">
        <div className="wait-ring"><span />{picked ? <WalletIcon wallet={picked} size={48} /> : <KeelMark size={40} />}</div>
        <h2>Waiting for {picked?.name ?? "your wallet"}…</h2>
        <p className="muted small center-text">Approve the connection in {picked?.name ?? "your wallet"}, then come back to Telegram. This screen continues on its own.</p>
        {phase === "stalled" && <Notice tone="info">Didn't connect? Open the wallet again, or start over with a fresh link.</Notice>}
        {picked && uri && <Button onClick={() => openWallet(picked)}>Open {picked.name} again</Button>}
        <Button variant="ghost" onClick={retry}>Start over</Button>
        <Fallbacks uri={uri} copied={copied} setCopied={setCopied} showQr={showQr} setShowQr={setShowQr} />
      </Glass>
    )
  }

  return (
    <Glass orb="gold" className="connect">
      {showMark && <div className="connect-mark"><span className="splash-glow" aria-hidden /><KeelMark size={56} /></div>}
      <h2>{title}</h2>
      <p className="muted small center-text">Pick the wallet that holds your BTC. It opens outside Telegram; approve there and come back.</p>
      <div className="wallets">
        {WALLETS.map((w) => (
          <button key={w.id} className="wallet-btn" disabled={!uri} onClick={() => openWallet(w)}>
            <WalletIcon wallet={w} />
            <span>{w.name}</span>
            {!uri ? <span className="spinner small-spin" aria-hidden /> : <IconExternal size={16} />}
          </button>
        ))}
      </div>
      {phase === "error" && (
        <>
          {err && <Notice tone="danger">{err}</Notice>}
          <Button variant="ghost" onClick={retry}>Try again</Button>
        </>
      )}
      <Fallbacks uri={uri} copied={copied} setCopied={setCopied} showQr={showQr} setShowQr={setShowQr} />
      {handoff && (
        <details className="more">
          <summary>Still not working? Open in your wallet's browser</summary>
          <p className="muted small">Opens this step inside the wallet app's own browser with a one-time link (valid 10 minutes, only for this step).</p>
          {ALL_WALLETS.filter((w) => w.dapp).map((w) => (
            <button key={w.id} className="browser-btn" disabled={handoffBusy} onClick={() => walletBrowser(w)}>
              <WalletIcon wallet={w} size={32} />
              <span className="grow">Open in {w.name} browser</span>
              {handoffBusy ? <span className="spinner small-spin" aria-hidden /> : <IconExternal size={16} />}
            </button>
          ))}
        </details>
      )}
      <div className="center"><MezoBadge /></div>
    </Glass>
  )
}

function Fallbacks({ uri, copied, setCopied, showQr, setShowQr }: { uri: string | null; copied: boolean; setCopied: (v: boolean) => void; showQr: boolean; setShowQr: (v: boolean) => void }) {
  if (!uri) return null
  return (
    <div className="fallbacks">
      <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(uri).then(() => setCopied(true))}><IconLink size={15} /> {copied ? "Copied" : "Copy connection link"}</button>
      <button className="link-btn" onClick={() => setShowQr(!showQr)}><IconWallet size={15} /> {showQr ? "Hide QR" : "Show QR"}</button>
      {showQr && <Qr text={uri} />}
      {showQr && <p className="muted tiny center-text">Scan with a wallet on another device, or paste the copied link into your wallet's WalletConnect screen.</p>}
    </div>
  )
}
