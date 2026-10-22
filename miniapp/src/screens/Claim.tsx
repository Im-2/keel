import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import type { Address, Hex } from "viem"
import { fmtMusd } from "@keel/shared"
import { api, ApiError } from "../lib/api"
import { short } from "../lib/units"
import { Button, Glass, KeelMark, MezoBadge, Notice, Skeleton, StateView } from "../ui/kit"
import { IconGift, IconWallet } from "../ui/icons"
import { explorerFor } from "../ui/activity"
import { closeApp, haptic, shortError } from "../components"
import type { AppCtx } from "../App"

const NEW_WALLET_KEY = "keel:claim-wallet"

/**
 * The claim key lives in the URL fragment / start param only. The recipient signs `Claim(link, to)` with it
 * (the signature binds the destination, so the relayer cannot redirect funds) and the bot relays it gaslessly.
 */
export function Claim({ ctx, keyHex }: { ctx: AppCtx; keyHex?: string }) {
  const { address } = useAccount()
  const [info, setInfo] = useState<{ amount: bigint; settled: boolean; expiry: number } | null>(null)
  const [err, setErr] = useState("")
  const [tx, setTx] = useState("")
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<{ address: Address; key: Hex } | null>(null)
  const [saved, setSaved] = useState(false)

  const linkKey = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? (`0x${keyHex}` as Hex) : null
  const linkAccount = linkKey ? privateKeyToAccount(linkKey) : null

  useEffect(() => {
    if (!linkAccount) return
    api.claimInfo(linkAccount.address).then((i) => setInfo({ amount: BigInt(i.amount), settled: i.settled, expiry: i.expiry })).catch((e) => setErr(e instanceof ApiError ? e.message : shortError(e)))
  }, [linkKey])

  if (!linkAccount) return <StateView kind="error" title="Incomplete link" body="This claim link is missing its key. Ask the sender to share it again." />

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
      setTx(r.txHash)
      haptic("success")
    } catch (e) {
      setErr(shortError(e))
    }
    setBusy(false)
  }

  if (tx) {
    return (
      <div className="claim">
        <StateView kind="success" title="Claimed" body={`${info ? fmtMusd(info.amount, 2) : "Your MUSD"} is in your wallet. Keel paid the gas.`} />
        {fresh && (
          <Glass orb="amber">
            <h3>Save your new wallet</h3>
            <Notice tone="danger">This key is the only way to reach the funds. Copy it now and import it into any wallet app.</Notice>
            <p className="mono tiny keybox">{fresh.key}</p>
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(fresh.key).then(() => setSaved(true))}>{saved ? "Copied" : "Copy key"}</Button>
          </Glass>
        )}
        <a className="tx-link center-text" href={`${explorerFor(ctx.cfg.network)}/tx/${tx}`} target="_blank" rel="noreferrer">View transaction</a>
        <Button variant="quiet" onClick={closeApp}>Done</Button>
      </div>
    )
  }

  const expired = info ? info.expiry * 1000 < Date.now() : false
  return (
    <div className="claim">
      <div className="share-card">
        <span className="orb orb-gold" aria-hidden />
        <div className="share-top"><KeelMark size={30} /><MezoBadge label="Mezo" /></div>
        <span className="claim-gift"><IconGift size={28} /></span>
        <span className="label">Someone sent you</span>
        {info ? <strong className="huge">{fmtMusd(info.amount, 2)}</strong> : err ? <strong className="huge">MUSD</strong> : <Skeleton h={38} w={180} />}
        <p className="muted small">MUSD is a dollar stablecoin on Mezo, backed by Bitcoin. Claiming is free.</p>
      </div>
      {err && !info && <Notice tone="danger">{err}</Notice>}
      {info?.settled && <StateView kind="empty" title="Already claimed" body="This link was claimed or cancelled by the sender." />}
      {expired && !info?.settled && <StateView kind="error" title="Link expired" body="The funds went back to the sender. Ask them for a new link." />}
      {info && !info.settled && !expired && (
        <>
          <Glass>
            <div className="opt-head"><IconWallet /><h3>I have a wallet</h3></div>
            {address ? (
              <Button busy={busy} onClick={() => claim(address)}>Claim to {short(address)}</Button>
            ) : (
              <div className="center"><ConnectButton showBalance={false} chainStatus="none" label="Connect wallet" /></div>
            )}
          </Glass>
          <Glass>
            <div className="opt-head"><IconGift /><h3>I don't have one yet</h3></div>
            <p className="muted small">We'll create a wallet on this device and show its key once, so you can save it.</p>
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
          {err && <Notice tone="danger">{err}</Notice>}
        </>
      )}
    </div>
  )
}
