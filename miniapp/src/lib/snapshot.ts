import type { AppConfig, StatsDto } from "./api"

/** A copy of the public stats and app config baked into the static build (public/stats-snapshot.json). */
export interface Snapshot {
  at: number
  config: AppConfig
  all: StatsDto
  outside: StatsDto
}

let cached: Promise<Snapshot | null> | null = null

/** Static file served by the CDN: available even when the backend is asleep. Never throws. */
export function loadSnapshot(): Promise<Snapshot | null> {
  cached ??= fetch("/stats-snapshot.json", { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
    .then((j) => (j && j.all && j.config && typeof j.at === "number" ? j : null))
    .catch(() => null)
  return cached
}

export const snapshotAge = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - at) / 60))
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
