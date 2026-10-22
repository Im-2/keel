import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Hex, WalletClient } from "viem"
import { api, tg, type IntentDto } from "../lib/api"
import { buildPlan, type Plan } from "../lib/plan"
import { go, useRefreshAll } from "../lib/data"
import { big, fmtMusd } from "../lib/units"
import { AmountInput, Button, Glass, KeelMark, MezoBadge, Notice, Rows, Skeleton, StateView } from "../ui/kit"
import { Header } from "../ui/shell"
import { IconCheck, IconExternal } from "../ui/icons"
import { explorerFor } from "../ui/activity"
import { WalletGate, closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

const NEEDS_AMOUNT = new Set(["repay", "add_collateral", "fund_reserve"])
const unit = (t: string) => (t === "repay" ? "MUSD" : "BTC")

/** Review and sign: the one place every transaction goes through, whether it started in the bot or the app. */
export function Intent({ ctx, id }: { ctx: AppCtx; id?: string }) {
  const q = useQuery({ queryKey: ["intent", id], queryFn: () => api.intent(id!), enabled: !!id })
  if (!id) return <StateView kind="error" title="Missing link" body="Open this from the Keel chat in Telegram." />
  if (q.isLoading) return (<><Header title="Review" back /><Glass><Skeleton h={22} w="50%" /><Skeleton h={160} style={{ marginTop: 14 }} /></Glass></>)
  if (q.error) return <StateView kind="error" title="Can't open this request" body={`${shortError(q.error)}. Open it from the Keel chat in Telegram.`} />
  const intent = q.data!
  if (intent.status !== "pending") return <StateView kind="success" title="Already done" body="This request was completed." action={<Button onClick={() => go("/")}>Open dashboard</Button>} />
  return (
    <>
      <Header title="Review & sign" greeting="Confirm" back />
      <WalletGate ctx={ctx} title="Connect to sign">{({ account, wallet }) => <Review ctx={ctx} intent={intent} account={account} wallet={wallet} />}</WalletGate>
    </>
  )
}

function Review({ ctx, intent, account, wallet }: { ctx: AppCtx; intent: IntentDto; account: `0x${string}`; wallet: WalletClient }) {
  const needsInput = NEEDS_AMOUNT.has(intent.type) && !intent.params.amount
  const [typed, setTyped] = useState("")
  const [plan, setPlan] = useState<Plan | null>(null)
  const [err, setErr] = useState("")
  const [stepIdx, setStepIdx] = useState(-1)
  const [done, setDone] = useState<{ tx: Hex; claimKey?: Hex } | null>(null)
  const refresh = useRefreshAll()

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
      refresh()
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
      {needsInput && (
        <Glass>
          <span className="label">Amount</span>
          <AmountInput value={typed} onChange={setTyped} unit={unit(intent.type)} placeholder="0.0" />
        </Glass>
      )}
      {plan ? (
        <Glass orb="gold" className="review">
          <div className="review-head">
            <KeelMark size={34} />
            <h2>{plan.title}</h2>
          </div>
          <Rows rows={plan.rows} />
          {plan.warnings.map((w) => <Notice key={w} tone={plan.blocked ? "danger" : "warn"}>{w}</Notice>)}
        </Glass>
      ) : !needsInput || typed ? (
        <Glass>
          {err ? <Notice tone="danger">{err}</Notice> : (<><Skeleton h={22} w="45%" /><Skeleton h={130} style={{ marginTop: 14 }} /><p className="muted small">Reading the latest on-chain numbers…</p></>)}
        </Glass>
      ) : null}
      {plan && plan.steps.length > 0 && (
        <Glass className="sign">
          <ol className="steps">
            {plan.steps.map((s, i) => (
              <li key={s.label} className={i === stepIdx ? "on" : i < stepIdx ? "ok" : ""}>
                <span className="step-dot">{i < stepIdx ? <IconCheck size={14} /> : i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
          {err && <Notice tone="danger">{err}</Notice>}
          <Button busy={stepIdx >= 0} disabled={plan.blocked} onClick={run}>
            {stepIdx >= 0 ? `Confirm in your wallet (${stepIdx + 1}/${plan.steps.length})` : plan.steps.length > 1 ? `Sign ${plan.steps.length} steps` : "Sign"}
          </Button>
          <p className="muted small center-text">You sign in your own wallet. Keel never has access to your funds.</p>
        </Glass>
      )}
    </>
  )
}

function Done({ ctx, intent, done }: { ctx: AppCtx; intent: IntentDto; done: { tx: Hex; claimKey?: Hex } }) {
  const explorer = explorerFor(ctx.cfg.network)
  const key = done.claimKey?.slice(2)
  const link = key
    ? ctx.cfg.miniappShortName
      ? `https://t.me/${ctx.cfg.botUsername}/${ctx.cfg.miniappShortName}?startapp=claim_${key}`
      : `https://t.me/${ctx.cfg.botUsername}?start=claim_${key}`
    : null
  const [copied, setCopied] = useState(false)
  const txLink = (
    <a className="tx-link" href={`${explorer}/tx/${done.tx}`} target="_blank" rel="noreferrer">View transaction <IconExternal size={14} /></a>
  )
  if (link) {
    return (
      <>
        <div className="share-card">
          <span className="orb orb-gold" aria-hidden />
          <div className="share-top"><KeelMark size={30} /><MezoBadge label="Mezo" /></div>
          <span className="label">You're sending</span>
          <strong className="huge">{fmtMusd(big(intent.params.amount), 2)}</strong>
          <p className="muted small">{intent.params.forName ? `For ${intent.params.forName} · ` : ""}Claim in one tap, no wallet needed. Refunds after 72h if unclaimed.</p>
          <p className="mono tiny">{link}</p>
        </div>
        <Glass>
          <Notice tone="info">Anyone with this link can claim, so share it privately.</Notice>
          <Button
            onClick={() => {
              const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("I sent you MUSD. Tap to claim:")}`
              if (tg?.openTelegramLink) tg.openTelegramLink(share)
              else void navigator.clipboard.writeText(link).then(() => setCopied(true))
            }}
          >
            {tg ? "Share in Telegram" : copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="quiet" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</Button>
          {txLink}
        </Glass>
      </>
    )
  }
  return (
    <StateView
      kind="success"
      title="Confirmed"
      body={intent.type === "borrow" ? "Your loan is open and the MUSD is in your wallet." : intent.type === "protect_config" ? "Protection settings saved." : "Transaction confirmed on Mezo."}
      action={
        <div className="stack">
          <Button onClick={() => go("/")}>Back to dashboard</Button>
          {tg && <Button variant="quiet" onClick={closeApp}>Back to chat</Button>}
          {txLink}
        </div>
      }
    />
  )
}
