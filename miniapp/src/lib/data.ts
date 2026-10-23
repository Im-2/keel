import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type IntentDto } from "./api"

// retryOnMount: false — a failed query must stay failed when the error screen mounts. Otherwise mounting resets it
// to "pending", the app swaps back to the splash, the retry fails, the error screen mounts again: an endless loop.
// The error screens have their own "Try again" button and the intervals keep refreshing.
export const usePosition = () => useQuery({ queryKey: ["position"], queryFn: api.position, refetchInterval: 20_000, retryOnMount: false })
export const useMarket = () => useQuery({ queryKey: ["market"], queryFn: api.market, staleTime: 5 * 60_000, retryOnMount: false })
export const useActivity = () => useQuery({ queryKey: ["activity"], queryFn: api.activity, refetchInterval: 30_000, retryOnMount: false })

export const go = (hash: string) => {
  location.hash = hash.startsWith("#") ? hash : `#${hash}`
}

/** Create an intent server-side, then open the shared review-and-sign screen for it. */
export async function startIntent(body: Record<string, unknown>): Promise<IntentDto> {
  const i = await api.createIntent(body)
  go(`/i/${i.id}`)
  return i
}

export function useRefreshAll() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ["position"] })
    void qc.invalidateQueries({ queryKey: ["activity"] })
  }
}
