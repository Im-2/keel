import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAccount, useConfig } from "wagmi"
import { disconnect as wagmiDisconnect } from "wagmi/actions"
import { api, tg } from "../lib/api"
import { usePosition } from "../lib/data"
import { clearWalletSession } from "../lib/session"
import { short } from "../lib/units"
import { Header } from "../ui/shell"
import { Button, Glass, MezoBadge, Notice, Rows, Skeleton, StateView } from "../ui/kit"
import { IconCheck, IconWallet } from "../ui/icons"
import { haptic, shortError } from "../components"
import type { AppCtx } from "../App"

export function Profile({ ctx }: { ctx: AppCtx }) {
  const pos = usePosition()
  const qc = useQueryClient()
  const wagmiConfig = useConfig()
  const { address: sessionAddress, connector } = useAccount()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [done, setDone] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const u = tg?.initDataUnsafe.user
  const linked = pos.data?.address ?? null

  // every connector, not just the active one: a stale WalletConnect pairing would reconnect silently otherwise
  const disconnectAll = async () => {
    await Promise.all(wagmiConfig.connectors.map((c) => wagmiDisconnect(wagmiConfig, { connector: c }).catch(() => undefined)))
  }

  async function disconnect() {
    setBusy(true)
    setErr("")
    try {
      const r = linked ? await api.disconnect() : { disconnected: null }
      await clearWalletSession(disconnectAll)
      qc.removeQueries()
      haptic("success")
      setDone(r.disconnected ?? sessionAddress ?? "")
    } catch (e) {
      setErr(shortError(e))
    }
    setBusy(false)
  }

  if (done !== null) {
    return (
      <StateView
        kind="success"
        title="Wallet disconnected"
        body={`${done ? short(done) + " is no longer linked. " : ""}Your loan and funds stay on-chain, untouched. Connect the same wallet to pick up where you left off, or a different one to start fresh.`}
        // a full reload drops any in-memory WalletConnect client, so the connect screen really starts clean
        action={<Button onClick={() => { location.hash = "#/link"; location.reload() }}>Connect a wallet</Button>}
      />
    )
  }

  return (
    <>
      <Header title="Profile" greeting={u?.first_name ? `Hi, ${u.first_name}` : "Settings"} back />
      <Glass orb="gold">
        <div className="section-head"><h3>Linked wallet</h3><IconWallet size={20} /></div>
        {pos.isLoading ? (
          <Skeleton h={20} w="60%" />
        ) : linked ? (
          <div className="addr-row">
            <code title={linked}>{short(linked)}</code>
            <button className="copy-btn" onClick={() => void navigator.clipboard?.writeText(linked).then(() => setCopied(true))}>{copied ? <><IconCheck size={12} /> Copied</> : "Copy"}</button>
          </div>
        ) : (
          <p className="muted small">No wallet is linked to your Telegram account.</p>
        )}
        <Rows rows={[
          ["Network", ctx.cfg.network === "mainnet" ? "Mezo" : `Mezo ${ctx.cfg.network} (chain ${ctx.cfg.chainId})`],
          ["Telegram", u?.username ? `@${u.username}` : u?.first_name ?? "—"],
          ...(sessionAddress ? ([["Wallet app session", `${short(sessionAddress)}${connector?.name ? ` · ${connector.name}` : ""}`]] as Array<[string, string]>) : []),
        ]} />
      </Glass>

      <Glass>
        {!confirming ? (
          <>
            <p className="muted small">Disconnecting unlinks this wallet from Keel and clears the wallet session on this device. Nothing on-chain changes.</p>
            {linked || sessionAddress ? (
              <Button variant="ghost" onClick={() => setConfirming(true)}>Disconnect wallet</Button>
            ) : (
              <Button onClick={() => { location.hash = "#/link" }}>Connect a wallet</Button>
            )}
          </>
        ) : (
          <>
            <h3>Disconnect {linked ? short(linked) : "this wallet"}?</h3>
            <p className="muted small">Your loan and funds stay on-chain and untouched; you can reconnect any time. Unsigned requests and alerts for this wallet are cleared.</p>
            {err && <Notice tone="danger">{err}</Notice>}
            <Button busy={busy} onClick={disconnect}>Yes, disconnect</Button>
            <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        )}
      </Glass>
      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}
