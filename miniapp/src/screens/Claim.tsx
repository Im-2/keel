import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import type { Address, Hex } from "viem"
import { fmtMusd } from "@keel/shared"
import { api, ApiError } from "../lib/api"
import { Card, closeApp, haptic, shortError } from "../components"
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

  const linkKey = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? (`0x${keyHex}` as Hex) : null
  const linkAccount = linkKey ? privateKeyToAccount(linkKey) : null

  useEffect(() => {
    if (!linkAccount) return
    api.claimInfo(linkAccount.address).then((i) => setInfo({ amount: BigInt(i.amount), settled: i.settled, expiry: i.expiry })).catch((e) => setErr(e instanceof ApiError ? e.message : shortError(e)))
  }, [linkKey])

  if (!linkAccount) return <Card><p className="warn">This claim link is incomplete. Ask the sender to share it again.</p></Card>

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
      <Card>
        <h2>Claimed 🎉</h2>
        <p>{info ? fmtMusd(info.amount, 2) : "Your MUSD"} is on its way to your wallet.</p>
        {fresh && (
          <>
            <p className="warn">Save your new wallet's private key now. Import it into any wallet app to use the funds:</p>
            <p className="mono small">{fresh.key}</p>
          </>
        )}
        <button className="btn secondary" onClick={closeApp}>Done</button>
      </Card>
    )
  }

  const expired = info ? info.expiry * 1000 < Date.now() : false
  return (
    <>
      <h2>🎁 You received {info ? fmtMusd(info.amount, 2) : "MUSD"}</h2>
      <p className="muted">MUSD is a dollar stablecoin on Mezo. Choose where to receive it. It's free: Keel pays the gas.</p>
      {info?.settled && <Card><p className="warn">This link was already claimed or cancelled.</p></Card>}
      {expired && !info?.settled && <Card><p className="warn">This link has expired.</p></Card>}
      {!info?.settled && !expired && (
        <>
          <Card>
            <h3>I have a wallet</h3>
            {address ? (
              <button className="btn" disabled={busy} onClick={() => claim(address)}>{busy ? "Claiming…" : `Claim to ${address.slice(0, 6)}…${address.slice(-4)}`}</button>
            ) : (
              <div className="center"><ConnectButton showBalance={false} chainStatus="none" /></div>
            )}
          </Card>
          <Card>
            <h3>I don't have one yet</h3>
            <p className="muted small">We'll create a wallet on this device. You'll see its recovery key once, so save it.</p>
            <button
              className="btn secondary"
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
            </button>
          </Card>
        </>
      )}
      {err && <p className="warn">{err}</p>}
    </>
  )
}
