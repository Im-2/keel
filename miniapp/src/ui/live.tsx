import { useLiveStatus, useToasts } from "../lib/useLive"

/** "Live" with a small dot while the stream is open; "Reconnecting…" while it is down (polling meanwhile). */
export function LiveDot() {
  const s = useLiveStatus()
  const live = s === "live"
  return (
    <span className={`live-dot ${live ? "on" : "off"}`} role="status" aria-live="polite">
      <i aria-hidden />
      <span className="live-label">{live ? "Live" : s === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
    </span>
  )
}

export function Toaster() {
  const list = useToasts()
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">{t.text}</div>
      ))}
    </div>
  )
}
