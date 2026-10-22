import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { x402Client } from "@x402/core/client"
import { wrapFetchWithPayment } from "@x402/fetch"
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm"
import type { PublicClient, WalletClient } from "viem"
import { apiUrl, tg } from "../lib/api"
import { Card, WalletGate, closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

interface Status {
  active: boolean
  until: number
  priceMusd: string
  days: number
}

const authed = (path: string, init: RequestInit = {}) =>
  fetch(apiUrl(path), { ...init, headers: { ...(init.headers ?? {}), "content-type": "application/json", "x-telegram-init-data": tg?.initData ?? "" } })

/** x402: the server answers 402 with MUSD payment requirements, the wallet signs a gasless Permit2 payment, the facilitator settles. */
export function Premium({ ctx }: { ctx: AppCtx }) {
  const status = useQuery({ queryKey: ["premium"], queryFn: async () => (await authed("/api/premium")).json() as Promise<Status> })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [done, setDone] = useState(false)

  async function pay(account: `0x${string}`, wallet: WalletClient) {
    setBusy(true)
    setErr("")
    try {
      const signer = toClientEvmSigner({ address: account, signTypedData: (m: never) => wallet.signTypedData({ account, ...(m as object) } as never) } as never, ctx.pub as PublicClient)
      const client = new x402Client().register(`eip155:${ctx.cfg.chainId}`, new ExactEvmScheme(signer))
      const res = await wrapFetchWithPayment((u: RequestInfo | URL, i?: RequestInit) => authed(String(u), i), client)("/api/premium/subscribe", { method: "POST", body: "{}" })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Payment failed (${res.status})`)
      haptic("success")
      setDone(true)
      void status.refetch()
    } catch (e) {
      setErr(shortError(e))
    }
    setBusy(false)
  }

  if (status.isLoading) return <Card><p>Loading…</p></Card>
  if (status.error || !status.data || (status.data as { error?: string }).error) return <Card><p className="warn">Premium isn't available right now.</p></Card>
  const s = status.data
  if (done) return <Card><h2>Premium is on ⭐</h2><p>You'll get alerts within seconds. Back to the chat.</p><button className="btn" onClick={closeApp}>Done</button></Card>
  return (
    <>
      <h2>⭐ Keel Premium</h2>
      <Card>
        <p>Free alerts check your loan every few minutes. Premium checks it every few seconds.</p>
        <p><b>{s.priceMusd} MUSD</b> for {s.days} days. No subscription, no card: you pay once, per use, in MUSD, with a signature (x402). {s.active && <>Active until {new Date(s.until * 1000).toLocaleDateString()}.</>}</p>
      </Card>
      <WalletGate ctx={ctx}>
        {({ account, wallet }) => (
          <>
            <button className="btn" disabled={busy} onClick={() => pay(account, wallet)}>{busy ? "Waiting for your wallet…" : s.active ? "Extend" : "Pay with MUSD"}</button>
            {err && <p className="warn">{err}</p>}
          </>
        )}
      </WalletGate>
    </>
  )
}
