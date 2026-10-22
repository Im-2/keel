import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import type { ReactNode } from "react"
import type { WalletClient } from "viem"
import { MCR, E18 } from "@keel/shared"
import { tg } from "./lib/api"
import type { AppCtx } from "./App"

export const Card = ({ children }: { children: ReactNode }) => <section className="card">{children}</section>

export function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export const Warn = ({ items }: { items: string[] }) => (
  <>
    {items.map((w) => (
      <p key={w} className="warn">⚠️ {w}</p>
    ))}
  </>
)

export function Gauge({ icr }: { icr: bigint }) {
  const hi = (25n * E18) / 10n
  const c = icr < MCR ? MCR : icr > hi ? hi : icr
  const frac = Number(((c - MCR) * 1000n) / (hi - MCR)) / 10
  const tone = icr < (13n * E18) / 10n ? "bad" : icr < (15n * E18) / 10n ? "mid" : "ok"
  return (
    <div className="gauge" aria-label="collateral ratio">
      <div className={`fill ${tone}`} style={{ width: `${Math.max(3, frac)}%` }} />
      <i style={{ left: `${(Number(((15n * E18) / 10n - MCR) * 1000n / (hi - MCR)) / 10)}%` }} title="150%" />
    </div>
  )
}

/** Requires a connected wallet on the right chain; renders `children(account, wallet)` once ready. */
export function WalletGate({ ctx, children }: { ctx: AppCtx; children: (a: { account: `0x${string}`; wallet: WalletClient }) => ReactNode }) {
  const { address, chainId } = useAccount()
  const { data: wallet } = useWalletClient()
  const { switchChain } = useSwitchChain()
  if (!address) {
    return (
      <Card>
        <p>Connect the wallet that holds your BTC.</p>
        <div className="center"><ConnectButton showBalance={false} chainStatus="none" /></div>
      </Card>
    )
  }
  if (chainId !== ctx.cfg.chainId) {
    return (
      <Card>
        <p>Switch to Mezo {ctx.cfg.network} to continue.</p>
        <button className="btn" onClick={() => switchChain({ chainId: ctx.cfg.chainId })}>Switch network</button>
      </Card>
    )
  }
  if (!wallet) return <Card><p>Preparing your wallet…</p></Card>
  return <>{children({ account: address, wallet: wallet as WalletClient })}</>
}

export const haptic = (t: "success" | "error" | "warning") => tg?.HapticFeedback?.notificationOccurred(t)

export const closeApp = () => (tg ? tg.close() : history.back())

export function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong"
  if (/user rejected|denied|rejected the request/i.test(m)) return "You cancelled the request in your wallet."
  return m.split("\n")[0].slice(0, 200)
}
