import { useEffect, useState } from "react"
import { apiUrl } from "../lib/api"
import "./web.css"

interface StatusJson {
  network: string
  uptimeSec: number
  commit?: string
  bot: { ok: boolean; username?: string; mode?: string; error?: string }
  rpc: { ok: boolean; block?: string; ms?: number; error?: string }
  keeper: { configured: boolean; balanceBtc?: string; low?: boolean; minBtc?: string; lastRun: { at: number; ok: boolean; detail?: string } | null }
  alerts: { lastRun: { at: number; ok: boolean } | null }
  watcher: { lastRun: { at: number; ok: boolean } | null }
  database: { rows: Record<string, number>; mirrored: boolean; mirrorBacklog?: number; mirrorError?: string }
}

const ago = (at?: number) => {
  if (!at) return "never"
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

/** Static page: always renders. The live checks are fetched from the backend after first paint. */
export function Status() {
  const [s, setS] = useState<StatusJson | null>(null)
  const [state, setState] = useState<"loading" | "down" | "ok">("loading")
  const [code, setCode] = useState<number | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      const t0 = performance.now()
      try {
        const r = await fetch(apiUrl("/status.json"), { signal: AbortSignal.timeout(10_000), cache: "no-store" })
        if (!r.ok) {
          if (!stop) setCode(r.status)
          throw new Error(String(r.status))
        }
        const j = (await r.json()) as StatusJson
        if (stop) return
        setS(j)
        setMs(Math.round(performance.now() - t0))
        setState("ok")
        setCode(null)
      } catch {
        if (!stop) setState("down")
      }
      if (!stop) timer = setTimeout(load, state === "ok" ? 30_000 : 8_000)
    }
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [])
  const row = (label: string, ok: boolean | null, value: string) => (
    <tr><td><span className={`dot ${ok === null ? "" : ok ? "ok" : "bad"}`}>{ok === null ? "…" : ok ? "✓" : "!"}</span>{label}</td><td>{value}</td></tr>
  )
  const k = s?.keeper
  const pending = state === "loading"
  return (
    <div>
    <div className="lp">
      <nav className="lp-nav"><a className="lp-brand" href="/"><img src="/keel-mark-red.svg" width={30} height={30} alt="" /> Keel</a></nav>
      <section className="lp-section" style={{ paddingTop: 12 }}>
        <h2>Keel status</h2>
        <p className="lp-muted">Checks the website, the server, Mezo, the keeper and the database. Refreshes by itself.</p>
        {state === "down" && (
          <p className="st-note" role="status">
            {code === 503
              ? "The backend is offline right now (its free host answered 503, which usually means the monthly free-hours quota ran out or a restart is in progress). The website, docs, stats snapshot and demo mode still work. Checking again…"
              : "The server is waking up (it sleeps when idle and takes about 30 seconds). The website itself is up. Checking again…"}
          </p>
        )}
        <table className="stt">
          <tbody>
            {row("Website (static, CDN)", true, "up")}
            {row("Server and API", pending ? null : state === "ok", state === "ok" ? `up · ${ms} ms${s?.commit ? ` · build ${s.commit}` : ""}` : pending ? "checking…" : code === 503 ? "offline (503)" : "waking up")}
            {row("Telegram bot", s ? s.bot.ok : null, s ? (s.bot.ok ? `@${s.bot.username} (${s.bot.mode})` : s.bot.error ?? "down") : "—")}
            {row("Mezo RPC", s ? s.rpc.ok : null, s ? (s.rpc.ok ? `block ${s.rpc.block} · ${s.rpc.ms} ms` : s.rpc.error ?? "down") : "—")}
            {row("Keeper wallet", k ? k.configured && !k.low : null, k ? `${k.balanceBtc ? Number(k.balanceBtc).toFixed(4) : "?"} BTC${k.low ? " (LOW)" : ""}` : "—")}
            {row("Last keeper run", k ? !!k.lastRun?.ok : null, k ? `${ago(k.lastRun?.at)}${k.lastRun?.detail ? " · " + k.lastRun.detail : ""}` : "—")}
            {row("Last alerts run", s ? !!s.alerts.lastRun?.ok : null, s ? ago(s.alerts.lastRun?.at) : "—")}
            {row("Database", s ? !s.database.mirrorError : null, s ? (s.database.mirrored ? "Turso mirror on" : "local only") : "—")}
          </tbody>
        </table>
        <p className="lp-fine lp-muted">Network: {s?.network ?? "testnet"}. Source: <a href="https://github.com/Im-2/keel/blob/main/docs/RELIABILITY.md" target="_blank" rel="noopener">docs/RELIABILITY.md</a></p>
      </section>
    </div>
    </div>
  )
}
