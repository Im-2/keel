import testnet from "../../../shared/deployments/testnet.json"
import keelConfig from "../../../keel.config.json"

export const LINKS = {
  telegram: "https://t.me/KeelMezoBot/app",
  bot: "https://t.me/KeelMezoBot",
  webApp: "/#/app",
  demo: "/?demo=1#/",
  stats: "/stats",
  github: "https://github.com/Im-2/keel",
  readme: "https://github.com/Im-2/keel#readme",
  status: "https://github.com/Im-2/keel/blob/main/docs/STATUS.md",
  business: "/docs/business",
  docs: "/docs",
  contracts: "/docs/contracts",
  deck: "/keel-deck.pdf",
  deckPptx: "/keel-deck.pptx",
  // one value for every video link (keel.config.json, or VITE_DEMO_VIDEO_URL at build time); empty hides them
  video: ((import.meta.env.VITE_DEMO_VIDEO_URL as string | undefined) || keelConfig.demoVideoUrl || null) as string | null,
  mezo: "https://mezo.org",
  musd: "https://github.com/mezo-org/musd",
  explorer: "https://explorer.test.mezo.org",
}

export const API = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/$/, "")

/** Addresses come from shared/deployments/testnet.json; `verified` is set once the explorer shows the source. */
// verified on explorer.test.mezo.org with contracts/scripts/verify-blockscout.py
const VERIFIED = new Set<string>([
  "0x85579bee60dc659e014610e57935379f8a9b79e1", "0xccf76173d1f312b3b5c3e55a6ddbd8046f30e8ef", "0x3777b89a32cd85ffa0a49b062cdb80e66e66740d",
  "0x59b1ceb919378c59fb5f3d735f81c353aa1d8654", "0x44aa5cbb78ea506fd91fa7942d9326de29bf2e49", "0xa0c53049202a655f5ca5fe3131971c1b79cbee29",
  "0x07f411f2ee6ac7ba758ab234fc20eb6f5f13445d",
])
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
  const j = (await r.json().catch(() => null)) as Stats | null
  // anything but the real shape (a sleeping host's error page, a proxy) is treated as "not available yet"
  if (!j || typeof j.guardians !== "number" || !Array.isArray(j.protections)) throw new Error("stats: unexpected response")
  return j
}

export const num = (v: string | undefined) => (v ? Number(BigInt(v) / 10n ** 12n) / 1e6 : 0)
