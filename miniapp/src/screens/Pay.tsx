import { useState } from "react"
import { parseUnits18 } from "@keel/shared"
import { ApiError } from "../lib/api"
import { startIntent } from "../lib/data"
import { Header } from "../ui/shell"
import { AmountInput, Button, Glass, MezoBadge, Notice, Segmented } from "../ui/kit"
import { IconGift, IconSend } from "../ui/icons"
import { shortError } from "../components"
import type { AppCtx } from "../App"

type Mode = "send" | "link"

export function Pay(_: { ctx: AppCtx }) {
  const [mode, setMode] = useState<Mode>("send")
  const [to, setTo] = useState("")
  const [amount, setAmount] = useState("")
  const [memo, setMemo] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [notOnKeel, setNotOnKeel] = useState(false)

  let wei: bigint | null = null
  try {
    wei = amount ? parseUnits18(amount) : null
  } catch {
    wei = null
  }

  async function submit(kind: Mode) {
    if (!wei || wei <= 0n) return setErr("Enter an amount.")
    setBusy(true)
    setErr("")
    setNotOnKeel(false)
    try {
      if (kind === "send") await startIntent({ type: "send", to: to.trim(), amount: wei.toString(), memo })
      else {
        const name = to.trim().replace(/^@/, "")
        await startIntent({ type: "create_claim", amount: wei.toString(), forName: /^[A-Za-z0-9_]{3,32}$/.test(name) ? "@" + name : undefined })
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotOnKeel(true)
      setErr(shortError(e))
      setBusy(false)
    }
  }

  return (
    <>
      <Header title={mode === "send" ? "Send MUSD" : "Claim link"} greeting="Pay" />
      <Segmented<Mode> value={mode} onChange={(m) => { setMode(m); setErr(""); setNotOnKeel(false) }} options={[["send", "Send"], ["link", "Claim link"]]} />
      <Glass orb={mode === "send" ? "gold" : "amber"} className="pay">
        <div className="pay-icon">{mode === "send" ? <IconSend size={26} /> : <IconGift size={26} />}</div>
        <p className="muted small center-text">
          {mode === "send" ? "Pay a Keel user by @username, or any 0x address." : "Escrow MUSD behind a link. Anyone you share it with can claim, even without a wallet. Unclaimed links refund after 72h."}
        </p>
        <AmountInput value={amount} onChange={setAmount} unit="MUSD" />
        {mode === "send" ? (
          <>
            <label className="field">To<input placeholder="@friend or 0x…" value={to} onChange={(e) => setTo(e.target.value)} autoCapitalize="off" autoCorrect="off" /></label>
            <label className="field">Note (optional)<input placeholder="Dinner" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={120} /></label>
          </>
        ) : (
          <label className="field">For (optional)<input placeholder="@friend" value={to} onChange={(e) => setTo(e.target.value)} autoCapitalize="off" /></label>
        )}
        {err && <Notice tone={notOnKeel ? "info" : "danger"}>{err}</Notice>}
        {notOnKeel ? (
          <Button busy={busy} onClick={() => { setMode("link"); void submit("link") }}>Create claim link</Button>
        ) : (
          <Button busy={busy} disabled={!wei || (mode === "send" && !to.trim())} onClick={() => submit(mode)}>Review & sign</Button>
        )}
        <p className="muted small center-text">No fee. Gas is paid in BTC.</p>
      </Glass>
      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}
