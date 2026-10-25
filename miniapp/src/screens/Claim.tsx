import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import type { Address, Hex } from "viem"
import { fmtMusd, musdAbi, paramToKey } from "@keel/shared"
import { api, ApiError, type ClaimInfo } from "../lib/api"
import { go, usePosition } from "../lib/data"
import { short } from "../lib/units"
import { inTelegram } from "../lib/telegram"
import { Button, Glass, KeelMark, MezoBadge, Notice, Skeleton, StateView } from "../ui/kit"
import { IconGift, IconWallet, IconExternal } from "../ui/icons"
import { TelegramConnect } from "../ui/TelegramConnect"
import { explorerFor } from "../ui/activity"
import { closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

const NEW_WALLET_KEY = "keel:claim-wallet"

const expiresIn = (expiry: number) => {
  const s = expiry - Math.floor(Date.now() / 1000)
  if (s <= 0) return "expired"
  if (s < 3600) return `expires in ${Math.max(1, Math.round(s / 60))} min`
  if (s < 2 * 86400) return `expires in ${Math.round(s / 3600)} h`
  return `expires ${new Date(expiry * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}

/**
 * The claim key lives only in the link (start param / URL fragment) and in this screen's memory. The recipient's
 * browser signs `Claim(link, to)` with it, which binds the destination, so the relayer that pays the gas can't send
 * the money anywhere else. Keel's server only ever sees the link's public address and that signature.
 */
export function Claim({ ctx, keyHex }: { ctx: AppCtx; keyHex?: string }) {
  const { address: connected } = useAccount()
  const pos = usePosition()
  const linked = pos.data?.linked ? (pos.data.address as Address) : null
  const [info, setInfo] = useState<ClaimInfo | null>(null)
  const [loadErr, setLoadErr] = useState("")
  const [err, setErr] = useState("")
  const [done, setDone] = useState<{ tx: string; to: Address; balance: bigint | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<{ address: Address; key: Hex } | null>(null)
  const [saved, setSaved] = useState(false)
  const [other, setOther] = useState(false)

  const linkKey = paramToKey(keyHex)
  const linkAccount = linkKey ? privateKeyToAccount(linkKey) : null

  useEffect(() => {
    if (!linkAccount) return
    api.claimInfo(linkAccount.address).then(setInfo).catch((e) => setLoadErr(e instanceof ApiError ? e.message : shortError(e)))
  }, [linkKey])

  if (!linkAccount) return <StateView kind="error" title="This link is incomplete" body="Part of the claim link is missing, which happens when a long link gets cut off. Ask the sender to share it again from Keel." />

  async function claim(to: Address) {
    setBusy(true)
    setErr("")
    try {
      const signature = await linkAccount!.signTypedData({
        domain: { name: "KeelPay", version: "1", chainId: ctx.cfg.chainId, verifyingContract: ctx.deployment.keel!.pay },
        types: { Claim: [{ name: "link", type: "address" }, { name: "to", type: "address" }] },
        primaryType: "Claim",
        message: { link: linkAccount!.address, to },
      })
      const r = await api.claimRelay({ link: linkAccount!.address, to, signature })
      haptic("success")
      const balance = await ctx.pub.readContract({ address: ctx.deployment.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [to] }).catch(() => null)
      setDone({ tx: r.txHash, to, balance })
    } catch (e) {
      haptic("error")
      setErr(e instanceof ApiError ? e.message : shortError(e))
    }
    setBusy(false)
  }

  if (done) {
    return (
      <div className="claim">
        <StateView
          kind="success"
          title={`${info ? fmtMusd(BigInt(info.amount), 2) : "MUSD"} claimed`}
          body={<>It's in <b className="mono">{short(done.to)}</b>{done.balance !== null ? <> — balance now <b>{fmtMusd(done.balance, 2)}</b></> : null}. Keel paid the gas.</>}
        />
        {fresh && (
          <Glass orb="amber">
            <h3>Save your new wallet</h3>
            <Notice tone="danger">This key is the only way to reach the funds. Copy it now and import it into any wallet app (MetaMask: Import account).</Notice>
            <p className="mono tiny keybox">{fresh.key}</p>
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(fresh.key).then(() => setSaved(true))}>{saved ? "Copied ✓" : "Copy key"}</Button>
          </Glass>
        )}
        <a className="tx-link center-text" href={`${explorerFor(ctx.cfg.network)}/tx/${done.tx}`} target="_blank" rel="noreferrer">View transaction <IconExternal size={14} /></a>
        <Glass>
          <h3>What next?</h3>
          <p className="muted small">Keep it as dollars, send it on, or put your Bitcoin to work: borrow MUSD against BTC without selling it.</p>
          <Button onClick={() => go(inTelegram() ? "/borrow" : "/")}>Start a loan</Button>
          <Button variant="quiet" onClick={closeApp}>Done</Button>
        </Glass>
      </div>
    )
  }

  const from = info ? info.senderName ?? short(info.sender) : null
  const amount = info ? fmtMusd(BigInt(info.amount), 2) : null
  const head = (
    <div className="share-card">
      <span className="orb orb-gold" aria-hidden />
      <div className="share-top"><KeelMark size={30} /><MezoBadge label="Mezo" /></div>
      <span className="claim-gift"><IconGift size={28} /></span>
      <span className="label">{from ? <><b>{from}</b> sent you</> : "Someone sent you"}</span>
      {amount ? <strong className="huge">{amount}</strong> : loadErr ? <strong className="huge">MUSD</strong> : <Skeleton h={38} w={180} />}
      <p className="muted small">{info?.status === "open" ? `${expiresIn(info.expiry)} · ` : ""}MUSD is a dollar stablecoin on Mezo, backed by Bitcoin. Claiming is free.</p>
    </div>
  )

  if (loadErr) return <div className="claim">{head}<StateView kind="error" title="Can't open this link" body={loadErr} /></div>
  if (info?.status === "claimed") return <div className="claim">{head}<StateView kind="empty" title="Already claimed" body={info.claimedBy ? `${info.claimedBy} claimed this link.` : "Someone already claimed this link."} /></div>
  if (info?.status === "cancelled") return <div className="claim">{head}<StateView kind="empty" title="Cancelled" body={`${from ?? "The sender"} cancelled this link and got the MUSD back. Ask them for a new one.`} /></div>
  if (info?.status === "expired") return <div className="claim">{head}<StateView kind="error" title="This link expired" body={`It wasn't claimed in time, so the MUSD goes back to ${from ?? "the sender"}. Ask them for a new link.`} /></div>

  const target = linked ?? connected ?? null
  return (
    <div className="claim">
      {head}
      {!info ? (
        <Glass><Skeleton h={48} /></Glass>
      ) : target && !other ? (
        <Glass>
          <Button busy={busy} onClick={() => claim(target)}>Claim {amount} to {short(target)}</Button>
          <p className="muted small center-text">{linked ? "Your Keel wallet" : "Your connected wallet"}. One tap, no gas.</p>
          <button className="link-btn center" onClick={() => setOther(true)}>Claim to a different wallet</button>
        </Glass>
      ) : (
        <>
          <Glass>
            <div className="opt-head"><IconWallet /><h3>I have a wallet</h3></div>
            <p className="muted small">Connect it: you only approve the connection, the claim itself costs you nothing.</p>
            {inTelegram() ? <TelegramConnect title="Connect to claim" showMark={false} /> : <div className="center"><ConnectButton showBalance={false} chainStatus="none" label="Connect wallet" /></div>}
          </Glass>
          <Glass>
            <div className="opt-head"><IconGift /><h3>I don't have one yet</h3></div>
            <p className="muted small">Keel creates a wallet on this phone and shows its key once, so you can save it in any wallet app.</p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                const key = generatePrivateKey()
                const a = privateKeyToAccount(key).address
                try {
                  localStorage.setItem(NEW_WALLET_KEY, a)
                } catch { /* private mode */ }
                setFresh({ address: a, key })
                void claim(a)
              }}
            >
              Create a wallet and claim
            </Button>
          </Glass>
        </>
      )}
      {err && <Notice tone="danger">{err}</Notice>}
      <p className="muted tiny center-text">The link only works once. Keel never sees its key.</p>
    </div>
  )
}
