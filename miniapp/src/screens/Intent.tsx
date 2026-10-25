import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Hex, WalletClient } from "viem"
import { ApiError, api, tg, type ActivityItem, type IntentDto } from "../lib/api"
import { claimKeyFor } from "../lib/claimkeys"
import { ShareClaim } from "../ui/share"
import { TxRevertedError, pendingItem, settle, txFailureReason, upsertTop, waitForSuccess } from "../lib/tx"
import { buildPlan, type Plan } from "../lib/plan"
import { go, useRefreshAll } from "../lib/data"
import { handoffToken, inTelegram } from "../lib/telegram"
import { big, fmtMusd } from "../lib/units"
import { AmountInput, Button, Glass, KeelMark, MezoBadge, Notice, Rows, Skeleton, StateView } from "../ui/kit"
import { Header } from "../ui/shell"
import { IconCheck, IconExternal } from "../ui/icons"
import { explorerFor } from "../ui/activity"
import { SigningWith, WalletGate, closeApp, haptic, shortError } from "../components"
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
  if (intent.status !== "pending") {
    const link = intent.tx_hash ? <a className="tx-link" href={`${explorerFor(ctx.cfg.network)}/tx/${intent.tx_hash}`} target="_blank" rel="noreferrer">View transaction <IconExternal size={14} /></a> : null
    return intent.status === "done"
      ? intent.type === "create_claim" && claimKeyFor(intent.id)
        ? <ShareClaim cfg={ctx.cfg} keyHex={claimKeyFor(intent.id)!} amount={big(intent.params.amount)} forName={intent.params.forName} />
        : <StateView kind="success" title="Already done" body={<>This was confirmed on Mezo. {link}</>} action={<Button onClick={() => go("/activity")}>Open activity</Button>} />
      : <StateView kind="error" title="This one failed" body={<>Nothing was sent. Start it again from the chat or the Pay tab. {link}</>} action={<Button onClick={() => go("/")}>Open dashboard</Button>} />
  }
  return (
    <>
      <Header title="Review & sign" greeting="Confirm" back />
      <WalletGate ctx={ctx} title="Connect to sign" handoff={{ purpose: "intent", intentId: intent.id }}>{({ account, wallet }) => <Review ctx={ctx} intent={intent} account={account} wallet={wallet} />}</WalletGate>
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
  const qc = useQueryClient()

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
        if (i === plan.steps.length - 1) {
          // broadcast: tell the server (it settles it even if this screen closes) and show it as pending at once
          void api.complete(intent.id, { status: "submitted", txHash: last }).catch(() => undefined)
          qc.setQueriesData<{ items: ActivityItem[]; more: boolean }>({ queryKey: ["activity"] }, (d) => d && { ...d, items: upsertTop(d.items, pendingItem(intent, last)) })
        }
        // success only on a mined, non-reverted receipt; "not found" from a lagging node is just a retry
        await waitForSuccess((hash) => ctx.pub.getTransactionReceipt({ hash }), last)
        // public RPC nodes lag each other by a few seconds: let the next step see this one (e.g. approve -> create)
        if (i < plan.steps.length - 1) await new Promise((r) => setTimeout(r, 3000))
      }
      setStepIdx(-1)
      qc.setQueriesData<{ items: ActivityItem[]; more: boolean }>({ queryKey: ["activity"] }, (d) => d && { ...d, items: settle(d.items, intent.id, "confirmed") })
      // the chain says success; the server double-checks (retrying past lagging nodes) and notifies both sides
      for (let k = 0; k < 4; k++) {
        const r = await api.complete(intent.id, { status: "done", txHash: last }).catch((e) => (e instanceof ApiError && e.status === 409 ? null : { ok: false }))
        if (r) break
        await new Promise((res) => setTimeout(res, 2500))
      }
      haptic("success")
      refresh()
      setDone({ tx: last, claimKey: plan.claimKey })
    } catch (e) {
      setStepIdx(-1)
      haptic("error")
      if (e instanceof TxRevertedError) {
        void api.complete(intent.id, { status: "done", txHash: e.hash }).catch(() => undefined) // server records it as failed
        qc.setQueriesData<{ items: ActivityItem[]; more: boolean }>({ queryKey: ["activity"] }, (d) => d && { ...d, items: settle(d.items, intent.id, "failed") })
      }
      setErr(txFailureReason(e))
      refresh()
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
          {stepIdx >= 0 && <SigningWith />}
          <p className="muted small center-text">You sign in your own wallet. Keel never has access to your funds.</p>
        </Glass>
      )}
    </>
  )
}

function Done({ ctx, intent, done }: { ctx: AppCtx; intent: IntentDto; done: { tx: Hex; claimKey?: Hex } }) {
  const explorer = explorerFor(ctx.cfg.network)
  const txLink = (
    <a className="tx-link" href={`${explorer}/tx/${done.tx}`} target="_blank" rel="noreferrer">View transaction <IconExternal size={14} /></a>
  )
  const key = done.claimKey ?? (intent.type === "create_claim" ? claimKeyFor(intent.id) : null)
  if (key) {
    return (
      <>
        <ShareClaim cfg={ctx.cfg} keyHex={key} amount={big(intent.params.amount)} forName={intent.params.forName} />
        <div className="center">{txLink}</div>
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
          {handoffToken() && !inTelegram() ? <a className="btn btn-primary" href={`https://t.me/${ctx.cfg.botUsername}`}>Return to Telegram</a> : <Button onClick={() => go("/")}>Back to dashboard</Button>}
          {tg && <Button variant="quiet" onClick={closeApp}>Back to chat</Button>}
          {txLink}
        </div>
      }
    />
  )
}
