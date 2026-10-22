import { KeelMark } from "../ui/kit"

/** First paint while the session and position load. */
export const Splash = () => (
  <div className="splash" role="status" aria-label="Loading Keel">
    <div className="splash-mark">
      <span className="splash-glow" aria-hidden />
      <KeelMark size={72} />
    </div>
    <p className="muted">Loading your account…</p>
  </div>
)
