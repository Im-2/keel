import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ApiError, api } from "../lib/api"
import { go } from "../lib/data"
import { handoffToken, inTelegram } from "../lib/telegram"
import { short } from "../lib/units"
import { Button, Glass, KeelMark, MezoBadge, Notice, StateView } from "../ui/kit"
import { SigningWith, WalletGate, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

export function Link({ ctx }: { ctx: AppCtx }) {
  const qc = useQueryClient()
  const [state, setState] = useState<"idle" | "signing" | "done">("idle")
  const [err, setErr] = useState("")
  const [inUse, setInUse] = useState(false)
  if (state === "done") {
    return (
      <StateView
        kind="success"
        title="Wallet linked"
        body="You're set. Borrow against your BTC, turn on protection, or pay a friend."
        action={handoffToken() && !inTelegram() ? <a className="btn btn-primary" href={`https://t.me/${ctx.cfg.botUsername}`}>Return to Telegram</a> : <Button onClick={() => go("/")}>Open dashboard</Button>}
      />
    )
  }
  return (
    <div className="connect-screen">
      <div className="connect-hero">
        <KeelMark size={56} />
        <h1>Keel</h1>
        <p className="muted">Dollars against your Bitcoin, inside Telegram.<br />Non-custodial, protected by a guardian.</p>
      </div>
      <WalletGate ctx={ctx} showMark={false} handoff={{ purpose: "link" }}>
        {({ account, wallet }) => (
          <Glass orb="gold" className="connect">
            <h2>One signature to link</h2>
            <p className="muted small center-text">Proves <b className="mono">{short(account)}</b> is yours. It's free and moves no funds.</p>
            {inUse ? (
              <Notice tone="warn">This wallet is linked to a different Telegram account. Linking it here unlinks it there (that account is told). Sign once more to confirm.</Notice>
            ) : err ? (
              <Notice tone="danger">{err}</Notice>
            ) : null}
            <Button
              busy={state === "signing"}
              onClick={async () => {
                setState("signing")
                setErr("")
                try {
                  // a fresh nonce and signature every time, including the takeover confirmation
                  const { nonce, message } = await api.nonce()
                  const signature = await wallet.signMessage({ account, message })
                  await api.bind({ nonce, address: account, signature, ...(inUse ? { takeover: true } : {}) })
                  haptic("success")
                  setInUse(false)
                  void qc.invalidateQueries({ queryKey: ["position"] })
                  setState("done")
                } catch (e) {
                  if (e instanceof ApiError && e.code === "wallet_in_use") setInUse(true)
                  else setErr(shortError(e))
                  setState("idle")
                }
              }}
            >
              {state === "signing" ? "Waiting for signature…" : inUse ? "Sign again & link here" : "Sign & link"}
            </Button>
            {state === "signing" && <SigningWith />}
            <div className="center"><MezoBadge /></div>
          </Glass>
        )}
      </WalletGate>
    </div>
  )
}
