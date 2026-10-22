import { useState } from "react"
import { useAccount } from "wagmi"
import { api } from "../lib/api"
import { Card, WalletGate, closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

export function Link({ ctx }: { ctx: AppCtx }) {
  const { address } = useAccount()
  const [state, setState] = useState<"idle" | "signing" | "done">("idle")
  const [err, setErr] = useState("")
  if (state === "done") {
    return (
      <Card>
        <h2>Wallet linked ✅</h2>
        <p className="mono">{address}</p>
        <p>Back in the chat, try <b>/position</b> or <b>/borrow 5000</b>.</p>
        <button className="btn" onClick={closeApp}>Back to Telegram</button>
      </Card>
    )
  }
  return (
    <>
      <h2>Connect your wallet</h2>
      <p className="muted">One free signature proves the wallet is yours. Keel never holds your keys.</p>
      <WalletGate ctx={ctx}>
        {({ account, wallet }) => (
          <Card>
            <p className="mono">{account}</p>
            <button
              className="btn"
              disabled={state === "signing"}
              onClick={async () => {
                setState("signing")
                setErr("")
                try {
                  const { nonce, message } = await api.nonce()
                  const signature = await wallet.signMessage({ account, message })
                  await api.bind({ nonce, address: account, signature })
                  haptic("success")
                  setState("done")
                } catch (e) {
                  setErr(shortError(e))
                  setState("idle")
                }
              }}
            >
              {state === "signing" ? "Waiting for signature…" : "Sign & link (free)"}
            </button>
            {err && <p className="warn">{err}</p>}
          </Card>
        )}
      </WalletGate>
    </>
  )
}
