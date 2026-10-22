import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { go } from "../lib/data"
import { short } from "../lib/units"
import { Button, Glass, KeelMark, MezoBadge, Notice, StateView } from "../ui/kit"
import { WalletGate, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

export function Link({ ctx }: { ctx: AppCtx }) {
  const qc = useQueryClient()
  const [state, setState] = useState<"idle" | "signing" | "done">("idle")
  const [err, setErr] = useState("")
  if (state === "done") {
    return (
      <StateView
        kind="success"
        title="Wallet linked"
        body="You're set. Borrow against your BTC, turn on protection, or pay a friend."
        action={<Button onClick={() => go("/")}>Open dashboard</Button>}
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
      <WalletGate ctx={ctx} showMark={false}>
        {({ account, wallet }) => (
          <Glass orb="gold" className="connect">
            <h2>One signature to link</h2>
            <p className="muted small center-text">Proves <b className="mono">{short(account)}</b> is yours. It's free and moves no funds.</p>
            {err && <Notice tone="danger">{err}</Notice>}
            <Button
              busy={state === "signing"}
              onClick={async () => {
                setState("signing")
                setErr("")
                try {
                  const { nonce, message } = await api.nonce()
                  const signature = await wallet.signMessage({ account, message })
                  await api.bind({ nonce, address: account, signature })
                  haptic("success")
                  void qc.invalidateQueries({ queryKey: ["position"] })
                  setState("done")
                } catch (e) {
                  setErr(shortError(e))
                  setState("idle")
                }
              }}
            >
              {state === "signing" ? "Waiting for signature…" : "Sign & link"}
            </Button>
            <div className="center"><MezoBadge /></div>
          </Glass>
        )}
      </WalletGate>
    </div>
  )
}
