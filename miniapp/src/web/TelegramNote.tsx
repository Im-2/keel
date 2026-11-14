import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"
import { isDemo, isWeb } from "../lib/web"
import { Button, Glass, Notice } from "../ui/kit"
import { shortError } from "../components"

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000, enabled: isWeb() })

/**
 * Alerts, protection notices and payment notices are Telegram messages. A web-only account sees this card with a
 * one-time link that attaches a Telegram account to the same wallet (and keeps its history).
 */
export function TelegramNote({ compact = false }: { compact?: boolean }) {
  const me = useMe()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  if (!isWeb() || !me.data || me.data.telegram) return null
  async function connect() {
    setBusy(true)
    setErr("")
    try {
      const r = await api.webTelegram()
      if (r.url) window.open(r.url, "_blank", "noopener")
    } catch (e) {
      setErr(shortError(e))
    }
    setBusy(false)
  }
  return (
    <Glass>
      <div className="section-head"><h3>Connect Telegram to get alerts</h3></div>
      {!compact && (
        <p className="muted small">
          Liquidation and redemption warnings, “your guardian protected your loan” notices and payment notices arrive as Telegram messages.
          Connect a Telegram account to this wallet: everything you did here comes with it.
        </p>
      )}
      {isDemo() && <Notice tone="info">In the demo this opens the bot without linking anything.</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Button variant="ghost" busy={busy} onClick={connect}>Connect Telegram</Button>
    </Glass>
  )
}
