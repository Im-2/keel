import { useEffect, useMemo, useRef, useState } from "react"
import { usePublicClient } from "wagmi"
import type { PublicClient } from "viem"
import { parseStartParam, type Deployment } from "@keel/shared"
import { tg, type AppConfig } from "./lib/api"
import { usePosition } from "./lib/data"
import { TABS, TabBar, useTelegramBack } from "./ui/shell"
import { Home } from "./screens/Home"
import { Link } from "./screens/Link"
import { Intent } from "./screens/Intent"
import { Claim } from "./screens/Claim"
import { Premium } from "./screens/Premium"
import { Borrow } from "./screens/Borrow"
import { Pay } from "./screens/Pay"
import { Protection } from "./screens/Protection"
import { Activity } from "./screens/Activity"
import { Splash } from "./screens/Splash"
import { Profile } from "./screens/Profile"
import { SplitScreen, PayRequest } from "./screens/Split"
import { liveEnabled, useLive } from "./lib/useLive"
import { Toaster } from "./ui/live"

export interface AppCtx {
  cfg: AppConfig
  deployment: Deployment
  pub: PublicClient
}

/**
 * Hash routing: Telegram opens `<url>/#/i/<id>`, `#/link`, `#/claim/<key>`, `#/split/<id>/<idx>`; tabs are `#/`,
 * `#/borrow`, `#/pay`, `#/protect`, `#/activity`. A direct Mini App link (t.me/<bot>/app?startapp=…) arrives as
 * start_param instead: it decides the first screen once, so going Home afterwards doesn't reopen it.
 */
const START_USED = "keel:start-used"
function parseRoute(): string[] {
  const hash = location.hash.replace(/^#\/?/, "")
  const start = tg?.initDataUnsafe.start_param
  let used = false
  try {
    used = sessionStorage.getItem(START_USED) === start
  } catch { /* storage blocked */ }
  if (start && !used && (!hash || hash.startsWith("tgWebApp"))) {
    try {
      sessionStorage.setItem(START_USED, start)
    } catch { /* storage blocked */ }
    const t = parseStartParam(start)
    if (t.kind === "claim") return ["claim", start.slice(6)]
    if (t.kind === "split") return t.idx === null ? ["split", t.id] : ["split", t.id, String(t.idx)]
    if (t.kind === "pay") return ["payreq", t.id]
  }
  return hash.startsWith("tgWebApp") ? [] : hash.split("/").filter(Boolean)
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
  const [head = "", ...rest] = route
  const isTab = (TABS as readonly string[]).includes(head)
  useTelegramBack(!isTab)

  // slide direction follows tab order; deeper screens rise from below
  const prev = useRef<string>(head)
  const dir = isTab && (TABS as readonly string[]).includes(prev.current) ? (TABS.indexOf(head as never) >= TABS.indexOf(prev.current as never) ? "right" : "left") : "up"
  useEffect(() => {
    prev.current = head
  }, [head])

  const position = usePosition()
  // one live stream for the whole app once the account is linked (nothing to watch before that)
  useLive(liveEnabled() && !!position.data?.linked)
  const needsLink = isTab && position.data && !position.data.linked

  let screen
  if (head === "claim") screen = <Claim ctx={ctx} keyHex={rest[0]} />
  else if (head === "i") screen = <Intent ctx={ctx} id={rest[0]} />
  else if (head === "link") screen = <Link ctx={ctx} />
  else if (head === "premium") screen = <Premium ctx={ctx} />
  else if (head === "profile") screen = <Profile ctx={ctx} />
  else if (head === "split") screen = <SplitScreen ctx={ctx} id={rest[0]} idx={rest[1] === undefined ? null : Number(rest[1])} />
  else if (head === "payreq") screen = <PayRequest id={rest[0]} />
  else if (position.isLoading && isTab) screen = <Splash />
  else if (position.error && isTab) screen = <Home ctx={ctx} />
  else if (needsLink) screen = <Link ctx={ctx} />
  else if (head === "borrow") screen = <Borrow ctx={ctx} />
  else if (head === "pay") screen = <Pay ctx={ctx} />
  else if (head === "protect") screen = <Protection ctx={ctx} />
  else if (head === "activity") screen = <Activity ctx={ctx} />
  else screen = <Home ctx={ctx} />

  return (
    <div className={`app ${isTab && !needsLink ? "with-tabs" : ""}`}>
      <div className="bg-orbs" aria-hidden>
        <span className="bg-orb a" />
        <span className="bg-orb b" />
      </div>
      <main key={route.join("/")} className={`screen enter-${dir}`}>
        {screen}
      </main>
      {isTab && !needsLink && !position.isLoading && <TabBar active={head} />}
      <Toaster />
    </div>
  )
}
