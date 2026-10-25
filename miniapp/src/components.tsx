import { useMemo, useState } from "react"
import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import type { ReactNode } from "react"
import { numberToHex, type WalletClient } from "viem"
import { chainFor } from "@keel/shared"
import { tg } from "./lib/api"
import { inTelegram, nudgeWallet } from "./lib/telegram"
import { Button, Glass, KeelMark, MezoBadge, Notice, Skeleton, WalletIcon } from "./ui/kit"
import { useWalletApp } from "./lib/wallet-app"
import { TelegramConnect, type HandoffTarget } from "./ui/TelegramConnect"
import type { AppCtx } from "./App"

/**
 * Wraps the wallet client so every signature request also brings the wallet app forward when we are inside
 * Telegram (a WalletConnect request otherwise sits unseen in the background app).
 */
function withNudge(w: WalletClient): WalletClient {
  if (!inTelegram()) return w
  const wrap = <T extends (...a: never[]) => Promise<unknown>>(fn: T) =>
    ((...a: Parameters<T>) => {
      const p = fn(...a)
      setTimeout(nudgeWallet, 400)
      return p
    }) as T
  return { ...w, writeContract: wrap(w.writeContract), signMessage: wrap(w.signMessage), signTypedData: wrap(w.signTypedData), sendTransaction: wrap(w.sendTransaction) } as WalletClient
}

/** Requires a connected wallet on the right chain; renders `children(account, wallet)` once ready. */
export function WalletGate({ ctx, children, title = "Connect your wallet", showMark = true, handoff }: { ctx: AppCtx; title?: string; showMark?: boolean; handoff?: HandoffTarget; children: (a: { account: `0x${string}`; wallet: WalletClient }) => ReactNode }) {
  const { address, chainId, connector } = useAccount()
  const { data: wallet } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()
  const [switching, setSwitching] = useState(false)
  const [switchErr, setSwitchErr] = useState("")
  const nudged = useMemo(() => (wallet ? withNudge(wallet as WalletClient) : null), [wallet])

  if (!address) {
    if (inTelegram()) return <TelegramConnect title={title} handoff={handoff} showMark={showMark} />
    return (
      <Glass orb="gold" className="connect">
        {showMark && <div className="connect-mark"><span className="splash-glow" aria-hidden /><KeelMark size={64} /></div>}
        <h2>{title}</h2>
        <p className="muted small center-text">Use the wallet that holds your BTC. Keel never sees your keys: you approve every action yourself.</p>
        <div className="center"><ConnectButton showBalance={false} chainStatus="none" label="Connect wallet" /></div>
        <div className="center"><MezoBadge /></div>
      </Glass>
    )
  }
  if (chainId !== ctx.cfg.chainId) {
    // Most wallets don't know Mezo yet: switch, and if the wallet says the chain is unknown, add it first.
    const addAndSwitch = async () => {
      setSwitching(true)
      setSwitchErr("")
      const chain = chainFor(ctx.cfg.network)
      try {
        setTimeout(nudgeWallet, 400)
        await switchChainAsync({ chainId: ctx.cfg.chainId })
      } catch {
        try {
          const provider = (await connector?.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> } | undefined
          setTimeout(nudgeWallet, 400)
          await provider?.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: numberToHex(chain.id),
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [ctx.cfg.rpcUrl ?? chain.rpcUrls.default.http[0]],
              blockExplorerUrls: [chain.blockExplorers!.default.url],
            }],
          })
          await switchChainAsync({ chainId: ctx.cfg.chainId })
        } catch (e) {
          setSwitchErr(shortError(e))
        }
      }
      setSwitching(false)
    }
    return (
      <Glass orb="amber" className="connect">
        <h2>Add the Mezo network</h2>
        <p className="muted small center-text">Your wallet is on another network. Keel runs on Mezo {ctx.cfg.network} (chain {ctx.cfg.chainId}). Approve adding and switching in your wallet.</p>
        {switchErr && <Notice tone="danger">{switchErr}</Notice>}
        <Button busy={switching} onClick={addAndSwitch}>Add & switch to Mezo</Button>
      </Glass>
    )
  }
  if (!nudged) return <Glass><Skeleton h={24} w="50%" /><Skeleton h={48} style={{ marginTop: 14 }} /></Glass>
  return <>{children({ account: address, wallet: nudged })}</>
}

export const haptic = (t: "success" | "error" | "warning") => tg?.HapticFeedback?.notificationOccurred(t)

export const closeApp = () => (tg && inTelegram() ? tg.close() : history.back())

export function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong"
  if (/user rejected|denied|rejected the request/i.test(m)) return "You cancelled the request in your wallet."
  return m.split("\n")[0].slice(0, 200)
}

/** "Waiting for MetaMask…" with the wallet's own logo, shown while a signature is pending in the wallet app. */
export function SigningWith() {
  const w = useWalletApp()
  return (
    <div className="signing-with" role="status">
      <WalletIcon wallet={w} size={28} />
      <span className="muted small">Waiting for {w?.name ?? "your wallet"}…</span>
    </div>
  )
}
