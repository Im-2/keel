import { useQuery } from "@tanstack/react-query"
import { E18, findGuardian, fmtBtc, fmtIcr, fmtMusd, fmtUsd, readGuardian, readSystem, readTrove } from "@keel/shared"
import type { Client } from "@keel/shared"
import { api } from "../lib/api"
import { Card, Gauge, Rows, shortError } from "../components"
import type { AppCtx } from "../App"

/** Read-only dashboard. All actions are started from the bot so every transaction goes through the same review screen. */
export function Home({ ctx }: { ctx: AppCtx }) {
  const q = useQuery({
    queryKey: ["home"],
    refetchInterval: 20_000,
    queryFn: async () => {
      const me = await api.me()
      if (!me.address) return { me, sys: null, trove: null, guardian: null }
      const pub = ctx.pub as Client
      const sys = await readSystem(pub, ctx.deployment.musd)
      const g = await findGuardian(pub, ctx.deployment.keel!, me.address)
      const trove = g ? await readTrove(pub, ctx.deployment.musd, g, sys.price) : null
      const guardian = g ? await readGuardian(pub, g) : null
      return { me, sys, trove, guardian }
    },
  })
  if (q.isLoading) return <Card><p>Loading…</p></Card>
  if (q.error) return <Card><p className="warn">{shortError(q.error)}</p><p className="muted">Open Keel from the bot in Telegram.</p></Card>
  const { me, sys, trove, guardian } = q.data!
  if (!me.address) return <Card><h2>Welcome to Keel</h2><p>Link your wallet first.</p><a className="btn" href="#/link">Connect wallet</a></Card>
  if (!trove?.active || !sys) {
    return (
      <Card>
        <h2>No loan yet</h2>
        <p>BTC is {sys ? fmtUsd(sys.price, 0) : "…"}. In the chat, type <b>/borrow 5000</b> to see a quote.</p>
      </Card>
    )
  }
  return (
    <>
      <Card>
        <h2>Your position</h2>
        <p className="big">{fmtIcr(trove.icr)}</p>
        <Gauge icr={trove.icr} />
        <Rows
          rows={[
            ["Collateral", `${fmtBtc(trove.coll, 5)} (≈ ${fmtUsd((trove.coll * sys.price) / E18, 0)})`],
            ["Debt", `${fmtMusd(trove.debt, 2)} · ${(trove.interestRateBps / 100).toFixed(2)}% APR`],
            ["Liquidation price", `${fmtUsd(trove.liqPrice, 0)} · ${(trove.bufferBps / 100).toFixed(1)}% buffer`],
            ["Guardian", guardian?.enabled ? `ON · acts below ${fmtIcr(guardian.minIcr)}` : "OFF"],
            ["Reserve", guardian ? fmtBtc(guardian.reserveBTC, 5) : "—"],
          ]}
        />
        {sys.recoveryMode && <p className="warn">🚨 Recovery Mode is active.</p>}
      </Card>
      <p className="muted small">Use the bot to add collateral (/addcollateral), repay (/repay) or change protection (/protect).</p>
    </>
  )
}
