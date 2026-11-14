import testnet from "../../../shared/deployments/testnet.json"

export const LINKS = {
  telegram: "https://t.me/KeelMezoBot/app",
  bot: "https://t.me/KeelMezoBot",
  webApp: "/#/app",
  demo: "/?demo=1#/",
  stats: "/stats",
  github: "https://github.com/Im-2/keel",
  readme: "https://github.com/Im-2/keel#readme",
  status: "https://github.com/Im-2/keel/blob/main/docs/STATUS.md",
  business: "https://github.com/Im-2/keel/blob/main/docs/BUSINESS.md",
  deck: "/keel-deck.pdf",
  video: (import.meta.env.VITE_DEMO_VIDEO_URL as string | undefined) || null,
  mezo: "https://mezo.org",
  musd: "https://github.com/mezo-org/musd",
  explorer: "https://explorer.test.mezo.org",
}

export const API = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/$/, "")

/** Addresses come from shared/deployments/testnet.json; `verified` is set once the explorer shows the source. */
const VERIFIED = new Set<string>([])
const k = testnet.keel as unknown as Record<string, string>
const legacy = (testnet.legacy ?? []) as unknown as Array<Record<string, string>>
export const CONTRACTS = [
  { name: "KeelGuardianFactory v2", address: k.guardianFactory },
  { name: "KeelGuardian v2 implementation", address: k.guardianImplementation },
  { name: "KeelPay v2", address: k.pay },
  { name: "KeelPro", address: k.pro },
  ...legacy.flatMap((l) => [
    { name: "KeelGuardianFactory v1", address: l.guardianFactory },
    ...(l.guardianImplementation ? [{ name: "KeelGuardian v1 implementation", address: l.guardianImplementation }] : []),
    { name: "KeelPay v1", address: l.pay },
  ]),
]
  .filter((c) => !!c.address)
  .map((c) => ({ ...c, verified: VERIFIED.has(c.address.toLowerCase()), url: `${LINKS.explorer}/address/${c.address}${VERIFIED.has(c.address.toLowerCase()) ? "?tab=contract" : ""}` }))

export interface Stats {
  guardians: number
  wallets: number
  activeLoans: number
  musdBorrowed: string
  btcCollateral: string
  protections: Array<{ tx: string; kind: string; icrBefore: string; icrAfter: string; at: number }>
}

/** Public stats from the bot API. The free host sleeps when idle, so this retries once after it wakes. */
export async function fetchStats(signal?: AbortSignal, includeTeam = false): Promise<Stats> {
  const r = await fetch(`${API}/api/stats${includeTeam ? "?all=1" : ""}`, { signal })
  if (!r.ok) throw new Error(`stats ${r.status}`)
  return (await r.json()) as Stats
}

export const num = (v: string | undefined) => (v ? Number(BigInt(v) / 10n ** 12n) / 1e6 : 0)
