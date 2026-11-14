import { useEffect, useState } from "react"
import type { AppConfig } from "../lib/api"
import { exitDemo, isDemo, webSession } from "../lib/web"
import { App } from "../App"
import { Landing } from "./Landing"
import { SignIn } from "./SignIn"
import { Stats } from "./Stats"
import "./web.css"

const headOf = () => location.hash.replace(/^#\/?/, "").split("/")[0] ?? ""

/**
 * Keel in a normal browser. `/` (or `#/about`) is the landing page, `/stats` the public stats, and the app's own
 * routes need a wallet session (claim links work without one: the link key is the credential). Demo mode shows the
 * whole app with sample data and a banner that says so.
 */
export function WebRoot({ cfg }: { cfg: AppConfig }) {
  const [head, setHead] = useState(headOf)
  const [session, setSession] = useState(webSession)
  useEffect(() => {
    const onHash = () => setHead(headOf())
    const onSession = () => setSession(webSession())
    addEventListener("hashchange", onHash)
    addEventListener("keel:session", onSession)
    return () => {
      removeEventListener("hashchange", onHash)
      removeEventListener("keel:session", onSession)
    }
  }, [])
  useEffect(() => {
    // a signed-in visitor who opens "Open app" lands on the dashboard
    if (head === "app" && (session || isDemo())) location.hash = "#/"
  }, [head, session])

  if (location.pathname.replace(/\/$/, "") === "/stats" || head === "stats") return <Stats cfg={cfg} />
  if (head === "about") return <Landing cfg={cfg} />
  if (isDemo()) {
    return <DemoApp cfg={cfg} />
  }
  if (head === "claim") return <App cfg={cfg} />
  if (!session) return head === "" ? <Landing cfg={cfg} /> : <SignIn />
  return <App cfg={cfg} />
}

function DemoApp({ cfg }: { cfg: AppConfig }) {
  return (
    <>
      <div className="demo-banner" role="status">
        <span>Demo mode: sample data, nothing is signed or sent.</span>
        <button onClick={exitDemo}>Exit demo</button>
      </div>
      <App cfg={cfg} />
    </>
  )
}
