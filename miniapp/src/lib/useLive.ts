import { useEffect, useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, apiUrl, tg } from "./api"
import { LiveClient, invalidationsFor, liveStatus, showToast, toasts, type LiveUpdate } from "./live"
import { haptic } from "../components"

export function applyUpdate(qc: QueryClient, u: LiveUpdate) {
  for (const key of invalidationsFor(u)) void qc.invalidateQueries({ queryKey: key })
  if (u.toast) {
    showToast(u.toast)
    if (u.reason === "received" || u.reason === "protected") haptic("success")
  }
}

/** One stream for the whole app, started once Telegram auth exists; pauses nothing, resyncs on return. */
export function useLive(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const client = new LiveClient({
      streamUrl: async () => {
        const { token, url } = await api.liveToken()
        return apiUrl(`${url}?t=${encodeURIComponent(token)}`)
      },
      onUpdate: (u) => applyUpdate(qc, u),
      onResync: () => {
        void qc.invalidateQueries({ queryKey: ["position"] })
        void qc.invalidateQueries({ queryKey: ["activity"] })
      },
      onStatus: (s) => liveStatus.set(s),
    })
    client.start()
    const wake = () => document.visibilityState === "visible" && client.wake()
    document.addEventListener("visibilitychange", wake)
    addEventListener("online", wake)
    addEventListener("focus", wake)
    return () => {
      client.stop()
      document.removeEventListener("visibilitychange", wake)
      removeEventListener("online", wake)
      removeEventListener("focus", wake)
    }
  }, [enabled, qc])
}

export const useLiveStatus = () => useSyncExternalStore(liveStatus.subscribe, liveStatus.get)
export const useToasts = () => useSyncExternalStore(toasts.subscribe, toasts.get)
/** Live updates need Telegram auth (initData); a wallet-browser handoff session has none. */
export const liveEnabled = () => !!tg?.initData
