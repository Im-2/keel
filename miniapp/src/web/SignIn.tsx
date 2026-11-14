import { useState } from "react"
import { useAccount, useWalletClient } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { enterDemo, saveWebSession } from "../lib/web"
import { short } from "../lib/units"
import { Button, Glass, KeelMark, MezoBadge, Notice } from "../ui/kit"
import { SigningWith, shortError } from "../components"

/** Web mode: connect a wallet (MetaMask or any injected wallet, or WalletConnect), then sign a server nonce. */
export function SignIn() {
  const { address } = useAccount()
  const { data: wallet } = useWalletClient()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  async function signIn() {
    if (!address || !wallet) return
    setBusy(true)
    setErr("")
    try {
      const { nonce, message } = await api.webNonce(address)
      const signature = await wallet.signMessage({ account: address, message })
      const s = await api.webSession({ address, nonce, signature })
      qc.removeQueries()
      saveWebSession({ token: s.token, address: s.address, expires: s.expires, telegram: s.telegram })
      if (!location.hash || location.hash === "#/app" || location.hash === "#/about") location.hash = "#/"
    } catch (e) {
      setErr(shortError(e))
    }
    setBusy(false)
  }

  return (
    <div className="app">
      <div className="bg-orbs" aria-hidden><span className="bg-orb a" /><span className="bg-orb b" /></div>
      <main className="screen enter-up">
        <div className="connect-hero">
          <KeelMark size={56} />
          <h1>Keel</h1>
          <p className="muted">Your BTC-backed dollar account.<br />Sign in with the wallet that holds your BTC.</p>
        </div>
        <Glass orb="gold" className="connect">
          {!address ? (
            <>
              <h2>Connect your wallet</h2>
              <p className="muted small center-text">MetaMask, any browser wallet, or WalletConnect from your phone. Keel never sees your keys.</p>
              <div className="center"><ConnectButton showBalance={false} chainStatus="none" label="Connect wallet" /></div>
            </>
          ) : (
            <>
              <h2>Sign in</h2>
              <p className="muted small center-text">
                Sign one message to prove <b className="mono">{short(address)}</b> is yours. It's free and moves no funds. The session lasts 12 hours.
              </p>
              {err && <Notice tone="danger">{err}</Notice>}
              <Button busy={busy} disabled={!wallet} onClick={signIn}>{busy ? "Waiting for signature…" : "Sign in with wallet"}</Button>
              {busy && <SigningWith />}
              <div className="center"><ConnectButton showBalance={false} chainStatus="none" accountStatus="address" /></div>
            </>
          )}
          <div className="center"><MezoBadge /></div>
        </Glass>
        <Glass>
          <p className="muted small center-text">No testnet BTC? See every screen with sample data first.</p>
          <Button variant="ghost" onClick={enterDemo}>Try the demo</Button>
          <Button variant="quiet" onClick={() => { location.hash = "#/about" }}>About Keel</Button>
        </Glass>
      </main>
    </div>
  )
}
