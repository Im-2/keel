import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type IntentDto } from "./api"

export const usePosition = () => useQuery({ queryKey: ["position"], queryFn: api.position, refetchInterval: 20_000 })
export const useMarket = () => useQuery({ queryKey: ["market"], queryFn: api.market, staleTime: 5 * 60_000 })
export const useActivity = () => useQuery({ queryKey: ["activity"], queryFn: api.activity, refetchInterval: 30_000 })

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
