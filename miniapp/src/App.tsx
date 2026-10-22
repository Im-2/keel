import { useEffect, useMemo, useState } from "react"
import { usePublicClient } from "wagmi"
import type { PublicClient } from "viem"
import { type Deployment } from "@keel/shared"
import { tg, type AppConfig } from "./lib/api"
import { Home } from "./screens/Home"
import { Link } from "./screens/Link"
import { Intent } from "./screens/Intent"
import { Claim } from "./screens/Claim"
import { Premium } from "./screens/Premium"

export interface AppCtx {
  cfg: AppConfig
  deployment: Deployment
  pub: PublicClient
}

/** Hash routing: Telegram opens `<url>/#/i/<id>`, `#/link`, `#/claim/<key>`. */
function parseRoute(): string[] {
  const start = tg?.initDataUnsafe.start_param
  if (!location.hash && start?.startsWith("claim_")) return ["claim", start.slice(6)]
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)
}

export function App({ cfg }: { cfg: AppConfig }) {
  const [route, setRoute] = useState(parseRoute)
  const pub = usePublicClient() as PublicClient
  useEffect(() => {
    const on = () => setRoute(parseRoute())
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  const deployment = useMemo(
    () => ({ network: cfg.network, chainId: cfg.chainId, musd: cfg.deployment.musd, keel: cfg.deployment.keel }) as unknown as Deployment,
    [cfg],
  )
  const ctx: AppCtx = { cfg, deployment, pub }
  const [head, ...rest] = route
  return (
    <main className="app">
      <header className="brand">
        <span className="logo">⚓</span> Keel
        <span className="net">{cfg.network === "mainnet" ? "Mezo" : `Mezo ${cfg.network}`}</span>
      </header>
      {head === "link" ? <Link ctx={ctx} /> : head === "i" ? <Intent ctx={ctx} id={rest[0]} /> : head === "premium" ? <Premium ctx={ctx} /> : head === "claim" ? <Claim ctx={ctx} keyHex={rest[0]} /> : <Home ctx={ctx} />}
    </main>
  )
}
