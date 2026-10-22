import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Hex, WalletClient } from "viem"
import { api, tg, type IntentDto } from "../lib/api"
import { buildPlan, type Plan } from "../lib/plan"
import { Card, Rows, Warn, WalletGate, closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

const NEEDS_AMOUNT = new Set(["repay", "add_collateral", "fund_reserve"])
const unit = (t: string) => (t === "repay" ? "MUSD" : "BTC")

export function Intent({ ctx, id }: { ctx: AppCtx; id?: string }) {
  const q = useQuery({ queryKey: ["intent", id], queryFn: () => api.intent(id!), enabled: !!id })
  if (!id) return <Card><p>Missing link.</p></Card>
  if (q.isLoading) return <Card><p>Loading…</p></Card>
  if (q.error) return <Card><p className="warn">{shortError(q.error)}</p><p className="muted">Open this from the Keel chat in Telegram.</p></Card>
  const intent = q.data!
  if (intent.status !== "pending") return <Card><h2>Already done ✅</h2><button className="btn" onClick={closeApp}>Back to Telegram</button></Card>
  return (
    <WalletGate ctx={ctx}>{({ account, wallet }) => <Review ctx={ctx} intent={intent} account={account} wallet={wallet} />}</WalletGate>
  )
}

function Review({ ctx, intent, account, wallet }: { ctx: AppCtx; intent: IntentDto; account: `0x${string}`; wallet: WalletClient }) {
  const needsInput = NEEDS_AMOUNT.has(intent.type) && !intent.params.amount
  const [typed, setTyped] = useState("")
  const [plan, setPlan] = useState<Plan | null>(null)
  const [err, setErr] = useState("")
  const [stepIdx, setStepIdx] = useState(-1)
  const [done, setDone] = useState<{ tx: Hex; claimKey?: Hex } | null>(null)

  useEffect(() => {
    let live = true
    setPlan(null)
    setErr("")
    if (needsInput && !typed) return
    buildPlan(intent, { pub: ctx.pub, deployment: ctx.deployment, account }, { amount: needsInput ? typed : undefined })
      .then((p) => live && setPlan(p))
      .catch((e) => live && setErr(shortError(e)))
    return () => {
      live = false
    }
  }, [intent, typed, account])

  async function run() {
    if (!plan) return
    setErr("")
    try {
      let last: Hex = "0x"
      for (let i = 0; i < plan.steps.length; i++) {
        setStepIdx(i)
        last = await plan.steps[i].run(wallet, { pub: ctx.pub, deployment: ctx.deployment, account })
        await ctx.pub.waitForTransactionReceipt({ hash: last })
      }
      setStepIdx(-1)
      await api.complete(intent.id, { status: "done", txHash: last }).catch(() => undefined)
      haptic("success")
      setDone({ tx: last, claimKey: plan.claimKey })
    } catch (e) {
      setStepIdx(-1)
      haptic("error")
      setErr(shortError(e))
    }
  }

  if (done) return <Done ctx={ctx} intent={intent} done={done} />

  return (
    <>
      <h2>{plan?.title ?? "Review"}</h2>
      {needsInput && (
        <Card>
          <label className="field">
            Amount ({unit(intent.type)})
            <input inputMode="decimal" placeholder="0.0" value={typed} onChange={(e) => setTyped(e.target.value.replace(",", "."))} />
          </label>
        </Card>
      )}
      {plan ? (
        <Card>
          <Rows rows={plan.rows} />
          <Warn items={plan.warnings} />
        </Card>
      ) : !needsInput || typed ? (
        <Card><p className="muted">{err || "Reading the latest on-chain numbers…"}</p></Card>
      ) : null}
      {plan && plan.steps.length > 0 && (
        <>
          <ol className="steps">
            {plan.steps.map((s, i) => (
              <li key={s.label} className={i === stepIdx ? "on" : i < stepIdx ? "ok" : ""}>{s.label}</li>
            ))}
          </ol>
          <button className="btn" disabled={plan.blocked || stepIdx >= 0} onClick={run}>
            {stepIdx >= 0 ? `Confirm in your wallet (${stepIdx + 1}/${plan.steps.length})…` : plan.steps.length > 1 ? `Confirm ${plan.steps.length} steps` : "Confirm"}
          </button>
        </>
      )}
      {err && plan && <p className="warn">{err}</p>}
      <p className="muted small">You sign in your own wallet. Keel never has access to your funds.</p>
    </>
  )
}

function Done({ ctx, intent, done }: { ctx: AppCtx; intent: IntentDto; done: { tx: Hex; claimKey?: Hex } }) {
  const explorer = ctx.cfg.network === "mainnet" ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org"
  const key = done.claimKey?.slice(2)
  const link = key
    ? ctx.cfg.miniappShortName
      ? `https://t.me/${ctx.cfg.botUsername}/${ctx.cfg.miniappShortName}?startapp=claim_${key}`
      : `https://t.me/${ctx.cfg.botUsername}?start=claim_${key}`
    : null
  const [copied, setCopied] = useState(false)
  return (
    <Card>
      <h2>Done ✅</h2>
      {link ? (
        <>
          <p>Share this link with the person you're paying. <b>Anyone with the link can claim</b>, so send it privately.</p>
          <p className="mono small">{link}</p>
          <button
            className="btn"
            onClick={() => {
              const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("I sent you MUSD 🎁 Tap to claim:")}`
              if (tg?.openTelegramLink) tg.openTelegramLink(share)
              else void navigator.clipboard.writeText(link).then(() => setCopied(true))
            }}
          >
            {tg ? "Share in Telegram" : copied ? "Copied ✓" : "Copy link"}
          </button>
          <p className="muted small">Lose the link? You can cancel and get a refund any time; unclaimed links also refund after expiry.</p>
        </>
      ) : (
        <p>{intent.type === "borrow" ? "Your loan is open and the MUSD is in your wallet." : "Transaction confirmed."}</p>
      )}
      <p><a href={`${explorer}/tx/${done.tx}`} target="_blank" rel="noreferrer">View transaction ↗</a></p>
      <button className="btn secondary" onClick={closeApp}>Back to Telegram</button>
    </Card>
  )
}

