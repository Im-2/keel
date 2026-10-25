import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { SplitError, fmtMusd, parseUnits18, percentShares, requestedShares, equalShares } from "@keel/shared"
import { ApiError, api, tg, type SplitDto } from "../lib/api"
import { go } from "../lib/data"
import { short } from "../lib/units"
import { Header } from "../ui/shell"
import { AmountInput, Button, Glass, MezoBadge, Notice, Segmented, Skeleton, StateView, Toggle } from "../ui/kit"
import { IconCheck, IconExternal } from "../ui/icons"
import { explorerFor } from "../ui/activity"
import { haptic, shortError } from "../components"
import type { AppCtx } from "../App"

const m2 = (wei: string | bigint) => fmtMusd(BigInt(wei), 2)
const wei = (s: string): bigint | null => {
  try {
    const v = parseUnits18(s)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

type Mode = "equal" | "amounts" | "percent"
interface Person {
  raw: string
  value: string
}

/** Who still gets a "send them their link" nudge after creating (people Keel couldn't message). */
let lastNotReached: { id: string; names: string[] } | null = null

/**
 * The shares exactly as the server will compute them (bot/src/splits.ts), for the preview: every row adds up to the
 * total. Returns an error message instead when the input doesn't work.
 */
export function previewShares(total: bigint | null, people: Person[], mode: Mode, includeMe: boolean): { mine: bigint; theirs: bigint[] } | string {
  if (!total) return "Enter the total."
  if (!people.length) return "Add at least one person."
  try {
    if (mode === "equal") return requestedShares(total, people.length, { kind: "equal" }, includeMe)
    if (mode === "amounts") {
      const given = people.map((p) => wei(p.value))
      const fixed = given.reduce<bigint>((a, b) => a + (b ?? 0n), 0n)
      if (given.some((g) => g === null)) {
        const rest = given.filter((g) => g === null).length + (includeMe ? 1 : 0)
        if (fixed >= total) return "The amounts you gave already reach the total."
        const eq = equalShares(total - fixed, rest)
        let k = includeMe ? 1 : 0
        return { mine: includeMe ? eq[0] : 0n, theirs: given.map((g) => g ?? eq[k++]) }
      }
      if (fixed > total) return `The shares add up to ${m2(fixed)}, more than the total.`
      if (!includeMe && fixed !== total) return `The shares add up to ${m2(fixed)}, not ${m2(total)}.`
      return { mine: total - fixed, theirs: given as bigint[] }
    }
    const bps = people.map((p) => Math.round(Number(p.value) * 100))
    if (bps.some((b) => !Number.isFinite(b) || b <= 0)) return "Give each person a percentage."
    const theirs = bps.reduce((a, b) => a + b, 0)
    const mineBps = 10_000 - theirs
    if (mineBps < 0) return `The percentages add up to ${theirs / 100}%, more than 100%.`
    if (!includeMe && mineBps !== 0) return `The percentages add up to ${theirs / 100}%, not 100%.`
    const all = percentShares(total, mineBps > 0 ? [mineBps, ...bps] : bps)
    return mineBps > 0 ? { mine: all[0], theirs: all.slice(1) } : { mine: 0n, theirs: all }
  } catch (e) {
    return e instanceof SplitError ? e.message : String(e)
  }
}

/** Pay tab → Split: total, people, how to share, preview, create. */
export function SplitForm() {
  const [total, setTotal] = useState("")
  const [title, setTitle] = useState("")
  const [people, setPeople] = useState<Person[]>([])
  const [draft, setDraft] = useState("")
  const [mode, setMode] = useState<Mode>("equal")
  const [includeMe, setIncludeMe] = useState(true)
  const [due, setDue] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const contacts = useQuery({ queryKey: ["splits"], queryFn: api.splits, staleTime: 60_000 }).data?.contacts ?? []

  const add = (raw: string) => {
    const r = raw.trim().replace(/[,;]$/, "")
    if (!r) return
    const ok = /^@?[A-Za-z0-9_]{3,32}$/.test(r) || /^0x[0-9a-fA-F]{40}$/.test(r)
    if (!ok) return setErr(`"${r}" isn't a @username or a 0x address.`)
    const norm = r.startsWith("0x") ? r : "@" + r.replace(/^@/, "")
    if (people.some((p) => p.raw.toLowerCase() === norm.toLowerCase())) return
    setPeople([...people, { raw: norm, value: "" }])
    setDraft("")
    setErr("")
  }
  const t = wei(total)
  const preview = useMemo(() => previewShares(t, people, mode, includeMe), [t, people, mode, includeMe])

  async function create() {
    if (typeof preview === "string") return setErr(preview)
    setBusy(true)
    setErr("")
    try {
      const r = await api.createSplit({
        total: t!.toString(), title, includeMe,
        people: people.map((p) => ({ raw: p.raw, ...(mode === "amounts" && wei(p.value) ? { amount: wei(p.value)!.toString() } : {}), ...(mode === "percent" ? { bps: Math.round(Number(p.value) * 100) } : {}) })),
        dueAt: due ? Math.floor(new Date(`${due}T23:59:59Z`).getTime() / 1000) : null,
      })
      haptic("success")
      lastNotReached = { id: r.id, names: r.notReached }
      go(`/split/${r.id}`)
    } catch (e) {
      setErr(shortError(e))
      setBusy(false)
    }
  }

  return (
    <Glass orb="gold" className="pay split-form">
      <p className="muted small center-text">Everyone gets their share in Telegram with a Pay button. Payments land in your wallet and tick off live.</p>
      <AmountInput value={total} onChange={setTotal} unit="MUSD" />
      <label className="field">What's it for<input placeholder="Dinner" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} /></label>

      <label className="field">People
        <div className="chip-input">
          {people.map((p) => <span key={p.raw} className="chip">{p.raw.startsWith("0x") ? short(p.raw) : p.raw}<button aria-label={`Remove ${p.raw}`} onClick={() => setPeople(people.filter((x) => x !== p))}>×</button></span>)}
          <input placeholder={people.length ? "Add another" : "@ada, @bob or 0x…"} value={draft} autoCapitalize="off" autoCorrect="off"
            onChange={(e) => (/[\s,;]$/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && add(draft)} onBlur={() => add(draft)} />
        </div>
      </label>
      {contacts.filter((c) => !people.some((p) => p.raw.toLowerCase() === c.toLowerCase())).length > 0 && (
        <div className="chips-suggest">{contacts.filter((c) => !people.some((p) => p.raw.toLowerCase() === c.toLowerCase())).slice(0, 8).map((c) => <button key={c} className="chip ghost" onClick={() => add(c)}>+ {c}</button>)}</div>
      )}

      <Segmented<Mode> value={mode} onChange={setMode} options={[["equal", "Equal"], ["amounts", "Amounts"], ["percent", "Percent"]]} />
      <div className="row-between toggle-row"><span>Include me <small className="muted">(I pay a share too)</small></span><Toggle on={includeMe} onChange={setIncludeMe} label="Include me" /></div>
      <label className="field">Due (optional)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>

      {people.length > 0 && (
        <div className="share-preview">
          {includeMe && typeof preview !== "string" && <div className="share-line me"><span>You</span><b>{m2(preview.mine)}</b></div>}
          {people.map((p, i) => (
            <div key={p.raw} className="share-line">
              <span>{p.raw.startsWith("0x") ? short(p.raw) : p.raw}</span>
              {mode !== "equal" && (
                <input className="share-input" inputMode="decimal" placeholder={mode === "percent" ? "%" : "auto"} value={p.value}
                  onChange={(e) => setPeople(people.map((x, k) => (k === i ? { ...x, value: e.target.value.replace(",", ".").replace(/[^0-9.]/g, "") } : x)))} />
              )}
              <b>{typeof preview === "string" ? "—" : m2(preview.theirs[i])}</b>
            </div>
          ))}
          {typeof preview !== "string" && <div className="share-line sum"><span>Total</span><b>{m2(preview.mine + preview.theirs.reduce((a, b) => a + b, 0n))}</b></div>}
        </div>
      )}
      {typeof preview === "string" && people.length > 0 && t !== null && <Notice>{preview}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Button busy={busy} disabled={typeof preview === "string"} onClick={create}>Create split</Button>
    </Glass>
  )
}

/** One split: who has paid, what's left, and the one action that matters for whoever is looking. */
export function SplitScreen({ ctx, id, idx }: { ctx: AppCtx; id?: string; idx: number | null }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["split", id], queryFn: () => api.split(id!), enabled: !!id, refetchInterval: 60_000, retryOnMount: false })
  const [busy, setBusy] = useState("")
  const [msg, setMsg] = useState<{ tone: "info" | "danger"; text: string } | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const nr = lastNotReached
  const notReached = nr && nr.id === id ? nr.names : []
  useEffect(() => () => {
    if (lastNotReached?.id === id) lastNotReached = null
  }, [id])

  if (!id) return <StateView kind="error" title="Missing split" body="Open it from the Keel chat." />
  if (q.isLoading) return (<><Header title="Split" back /><Glass><Skeleton h={22} w="50%" /><Skeleton h={140} style={{ marginTop: 14 }} /></Glass></>)
  if (q.error || !q.data) {
    const notMine = q.error instanceof ApiError && q.error.status === 404
    return (<><Header title="Split" back /><StateView kind="error" title={notMine ? "Not your split" : "Can't load this split"} body={notMine ? "This split doesn't exist, or it's for someone else. Shares are tied to the @username they were sent to." : shortError(q.error)} action={<Button variant="ghost" onClick={() => q.refetch()}>Try again</Button>} /></>)
  }
  const s: SplitDto = q.data
  const requested = s.shares.reduce((a, x) => a + BigInt(x.amount), 0n)
  const collected = BigInt(s.collected)
  const pct = requested > 0n ? Number((collected * 1000n) / requested) / 10 : 0
  const mineIdx = idx !== null && s.shares.some((x) => x.idx === idx && x.isMe) ? idx : s.myShare
  const myShare = mineIdx === null ? null : s.shares.find((x) => x.idx === mineIdx) ?? null
  const someoneElse = idx !== null && !s.shares.some((x) => x.idx === idx && x.isMe) && !s.creator.isMe

  async function pay() {
    setBusy("pay")
    setMsg(null)
    try {
      const intent = await api.payShare(s.id, mineIdx)
      go(`/i/${intent.id}`)
    } catch (e) {
      if (e instanceof ApiError && e.code === "need_wallet") return go("/link")
      setMsg({ tone: "danger", text: shortError(e) })
      setBusy("")
    }
  }
  async function remind() {
    setBusy("remind")
    setMsg(null)
    try {
      const r = await api.remindSplit(s.id)
      const parts = [
        r.reminded.length ? `Reminded ${r.reminded.join(", ")} in Telegram.` : "",
        r.queued.length ? `${r.queued.join(", ")} will get it when they open Keel.` : "",
        r.skipped.length ? `${r.skipped.join(", ")} was reminded less than an hour ago.` : "",
        r.links.length ? `${r.links.map((l) => l.label).join(", ")} isn't on Keel yet: send them their link below.` : "",
      ].filter(Boolean)
      setMsg({ tone: "info", text: parts.join(" ") || "Nobody to remind." })
      haptic("success")
    } catch (e) {
      setMsg({ tone: "danger", text: shortError(e) })
    }
    setBusy("")
  }
  async function cancel() {
    setBusy("cancel")
    try {
      await api.cancelSplit(s.id)
      await qc.invalidateQueries({ queryKey: ["split", s.id] })
      void qc.invalidateQueries({ queryKey: ["splits"] })
    } catch (e) {
      setMsg({ tone: "danger", text: shortError(e) })
    }
    setBusy("")
    setConfirmCancel(false)
  }
  const shareLink = (label: string, link: string, amount: string) => {
    const text = `${label}: your share of ${s.title} is ${m2(amount)}. Tap to pay with Keel:`
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`
    if (tg?.openTelegramLink) tg.openTelegramLink(url)
    else void navigator.clipboard?.writeText(`${text} ${link}`)
  }
  const status = { collecting: "Collecting people", open: "Open", settled: "Settled", cancelled: "Cancelled" }[s.status]

  return (
    <>
      <Header title={s.title} greeting={s.creator.isMe ? "Your split" : `From ${s.creator.name}`} back />
      <Glass orb="gold" className="split-hero">
        <div className="hero-head">
          <span className="label">Total {m2(s.total)}{s.dueAt ? ` · due ${new Date(s.dueAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>
          <span className={`pill ${s.status === "settled" ? "pill-safe" : s.status === "cancelled" ? "pill-off" : "pill-warn"}`}>{s.status === "settled" && <IconCheck size={12} />}{status}</span>
        </div>
        <strong className="huge">{m2(collected)}</strong>
        <small className="muted">collected of {m2(requested)} · {m2(s.remaining)} to go</small>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
      </Glass>

      {s.status === "settled" && <Notice tone="info">🎉 Settled: everyone has paid{s.creator.isMe ? " and the MUSD is in your wallet" : ""}.</Notice>}
      {s.status === "collecting" && <Notice tone="info">People join from the group card with “I'm in”. {s.creator.isMe ? "Tap Lock there when everyone's in." : "Shares are set when the organiser locks it."}</Notice>}
      {notReached.length > 0 && <Notice>{notReached.join(", ")} {notReached.length > 1 ? "aren't" : "isn't"} on Keel yet, so I couldn't message them. Send their link with 📤 below.</Notice>}

      {!s.creator.isMe && myShare && s.status === "open" && (
        <Glass className="pay-share">
          <span className="label">{s.creator.name} asked you for</span>
          <strong className="huge">{m2(myShare.amount)}</strong>
          <small className="muted">for {s.title}</small>
          {myShare.status === "paid" ? (
            <Notice tone="info">You've paid your share — thanks! ✅</Notice>
          ) : (
            <Button busy={busy === "pay"} onClick={pay}>Review & pay {m2(myShare.amount)}</Button>
          )}
        </Glass>
      )}
      {someoneElse && <Notice>This pay link is for someone else's share.</Notice>}

      <Glass className="activity">
        <div className="section-head"><h3>People</h3><span className="muted tiny">{s.shares.filter((x) => x.status === "paid").length}/{s.shares.length} paid</span></div>
        {s.includeMe && BigInt(s.mine) > 0n && (
          <div className="share-row"><span className="share-dot me" aria-hidden>👤</span><span className="share-name">{s.creator.isMe ? "You" : s.creator.name}<small>own share</small></span><b>{m2(s.mine)}</b></div>
        )}
        {s.shares.map((x) => (
          <div key={x.idx} className={`share-row ${x.status}`}>
            <span className={`share-dot ${x.status}`} aria-hidden>{x.status === "paid" ? <IconCheck size={13} /> : "⏳"}</span>
            <span className="share-name">{x.isMe ? "You" : x.label}<small>{x.status === "paid" ? "paid" : "pending"}</small></span>
            <b>{m2(x.amount)}</b>
            {x.tx && <a className="share-tx" href={`${explorerFor(ctx.cfg.network)}/tx/${x.tx}`} target="_blank" rel="noreferrer" aria-label="View payment"><IconExternal size={14} /></a>}
            {x.link && <button className="link-btn share-send" onClick={() => shareLink(x.label, x.link!, x.amount)}>📤 Link</button>}
          </div>
        ))}
      </Glass>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {s.creator.isMe && s.status === "open" && (
        <Glass>
          <Button variant="ghost" busy={busy === "remind"} onClick={remind}>🔔 Remind pending</Button>
          {!confirmCancel ? (
            <Button variant="quiet" onClick={() => setConfirmCancel(true)}>Cancel split</Button>
          ) : (
            <>
              <p className="muted small">Cancel it? Payments already made stay with you; nobody else will be asked.</p>
              <Button busy={busy === "cancel"} onClick={cancel}>Yes, cancel</Button>
              <Button variant="quiet" onClick={() => setConfirmCancel(false)}>Keep it</Button>
            </>
          )}
        </Glass>
      )}
      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}

/** Splits I asked for and splits I owe, for the Activity tab. */
export function SplitsSection() {
  const q = useQuery({ queryKey: ["splits"], queryFn: api.splits, refetchInterval: 90_000, retryOnMount: false })
  const created = q.data?.created ?? []
  const owed = q.data?.owed ?? []
  if (!created.length && !owed.length) return null
  const row = (s: SplitDto, kind: "created" | "owed") => {
    const mine = kind === "owed" ? s.shares.find((x) => x.isMe) : null
    const sub = kind === "created"
      ? s.status === "settled" ? "Settled" : s.status === "cancelled" ? "Cancelled" : s.status === "collecting" ? "Collecting people" : `${m2(s.collected)} of ${m2(BigInt(s.collected) + BigInt(s.remaining))} collected`
      : mine?.status === "paid" ? "You paid ✅" : s.status === "open" ? `You owe ${m2(mine?.amount ?? "0")}` : s.status
    return (
      <button key={`${kind}${s.id}`} className="act-row split-item" onClick={() => go(`/split/${s.id}`)}>
        <span className="act-icon">🧾</span>
        <span className="act-text"><strong>{s.title}</strong><small>{kind === "owed" ? `From ${s.creator.name} · ` : ""}{sub}</small></span>
        <span className="act-right"><strong className={kind === "owed" && mine?.status === "pending" && s.status === "open" ? "amt-out" : "amt-neutral"}>{m2(kind === "owed" ? mine?.amount ?? "0" : s.total)}</strong><small>{s.status === "open" ? "open" : s.status}</small></span>
      </button>
    )
  }
  return (
    <Glass className="activity">
      {owed.some((s) => s.status === "open" && s.shares.some((x) => x.isMe && x.status === "pending")) && <div className="section-head"><h3>You owe</h3></div>}
      {owed.filter((s) => s.status === "open" && s.shares.some((x) => x.isMe && x.status === "pending")).map((s) => row(s, "owed"))}
      {created.length > 0 && <div className="section-head"><h3>Your splits</h3></div>}
      {created.slice(0, 6).map((s) => row(s, "created"))}
      {owed.filter((s) => !(s.status === "open" && s.shares.some((x) => x.isMe && x.status === "pending"))).slice(0, 4).map((s) => row(s, "owed"))}
    </Glass>
  )
}

/** pay_<id> links (a /request in a group): straight to review & sign. */
export function PayRequest({ id }: { id?: string }) {
  const [err, setErr] = useState("")
  useEffect(() => {
    if (!id) return
    api.payRequest(id).then((i) => go(`/i/${i.id}`)).catch((e) => {
      if (e instanceof ApiError && e.code === "need_wallet") return go("/link")
      setErr(shortError(e))
    })
  }, [id])
  return err ? <StateView kind="error" title="Can't pay this request" body={err} action={<Button onClick={() => go("/")}>Open dashboard</Button>} /> : (<><Header title="Pay" back /><Glass><Skeleton h={120} /></Glass></>)
}

