import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { x402Client } from "@x402/core/client"
import { wrapFetchWithPayment } from "@x402/fetch"
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm"
import type { PublicClient, WalletClient } from "viem"
import { apiUrl, authHeaders } from "../lib/api"
import { WalletGate, closeApp, haptic, shortError } from "../components"
import { Button, Glass, Notice, Skeleton, StateView } from "../ui/kit"
import { Header } from "../ui/shell"
import { IconStar } from "../ui/icons"
import type { AppCtx } from "../App"

interface Status {
  active: boolean
  until: number
  priceMusd: string
  days: number
}

const authed = (path: string, init: RequestInit = {}) =>
  fetch(apiUrl(path), { ...init, headers: { ...(init.headers ?? {}), ...authHeaders() } })

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

  if (status.isLoading) return (<><Header title="Premium" back /><Glass><Skeleton h={140} /></Glass></>)
  if (status.error || !status.data || (status.data as { error?: string }).error) return <StateView kind="error" title="Premium unavailable" body="Premium alerts aren't enabled right now." />
  const s = status.data
  if (done) return <StateView kind="success" title="Premium is on" body="Your loan is now checked every few seconds." action={<Button onClick={closeApp}>Done</Button>} />
  return (
    <>
      <Header title="Premium" greeting="Faster alerts" back />
      <Glass orb="gold" className="premium">
        <span className="premium-star"><IconStar size={28} /></span>
        <strong className="huge">{s.priceMusd} MUSD</strong>
        <span className="muted">for {s.days} days</span>
        <p className="muted small center-text">Free alerts check your loan every few minutes. Premium checks it every few seconds. No subscription, no card: you pay once in MUSD with a signature (x402).</p>
        {s.active && <Notice tone="info">Active until {new Date(s.until * 1000).toLocaleDateString()}.</Notice>}
      </Glass>
      <WalletGate ctx={ctx}>
        {({ account, wallet }) => (
          <Glass>
            {err && <Notice tone="danger">{err}</Notice>}
            <Button busy={busy} onClick={() => pay(account, wallet)}>{s.active ? "Extend" : "Pay with MUSD"}</Button>
          </Glass>
        )}
      </WalletGate>
    </>
  )
}
