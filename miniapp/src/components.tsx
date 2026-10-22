import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import type { ReactNode } from "react"
import type { WalletClient } from "viem"
import { tg } from "./lib/api"
import { Button, Glass, KeelMark, MezoBadge, Skeleton } from "./ui/kit"
import type { AppCtx } from "./App"

/** Requires a connected wallet on the right chain; renders `children(account, wallet)` once ready. */
export function WalletGate({ ctx, children, title = "Connect your wallet", showMark = true }: { ctx: AppCtx; title?: string; showMark?: boolean; children: (a: { account: `0x${string}`; wallet: WalletClient }) => ReactNode }) {
  const { address, chainId } = useAccount()
  const { data: wallet } = useWalletClient()
  const { switchChain } = useSwitchChain()
  if (!address) {
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
    return (
      <Glass orb="amber" className="connect">
        <h2>Switch network</h2>
        <p className="muted small center-text">Keel runs on Mezo {ctx.cfg.network}.</p>
        <Button onClick={() => switchChain({ chainId: ctx.cfg.chainId })}>Switch to Mezo</Button>
      </Glass>
    )
  }
  if (!wallet) return <Glass><Skeleton h={24} w="50%" /><Skeleton h={48} style={{ marginTop: 14 }} /></Glass>
  return <>{children({ account: address, wallet: wallet as WalletClient })}</>
}

export const haptic = (t: "success" | "error" | "warning") => tg?.HapticFeedback?.notificationOccurred(t)

export const closeApp = () => (tg ? tg.close() : history.back())

export function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong"
  if (/user rejected|denied|rejected the request/i.test(m)) return "You cancelled the request in your wallet."
  return m.split("\n")[0].slice(0, 200)
}
