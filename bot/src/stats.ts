import { decodeEventLog, parseAbi, type Address, type Hex } from "viem"
import { keelGuardianFactoryAbi, priceFeedAbi, troveManagerAbi } from "@keel/shared"
import type { LiveChain } from "./chain"
import type { Store } from "./db"
import type { Config } from "./config"

/**
 * Public, on-chain numbers for the /stats page and the landing page. Everything is read from Mezo: guardians from
 * every Keel factory, their troves from TroveManager, protections from the guardians' own events, and the BTC price
 * from PriceFeed at the block of each protection. Nothing here comes from Keel's database.
 *
 * Events are scanned by topic (not by address) in 10k-block chunks (the RPC's limit) from the first Keel deployment,
 * with the cursor and the events kept in the store, so a restart resumes instead of rescanning.
 */

const EVENTS = parseAbi([
  "event Protected(address indexed keeper, uint8 action, uint256 btcAdded, uint256 musdRepaid, uint256 icrBefore, uint256 icrAfter, uint256 tipBTC, uint256 tipMUSD)",
  "event PartialRescue(address indexed keeper, uint256 btcAdded, uint256 musdRepaid, uint256 icrBefore, uint256 icrAfter, uint256 btcShortfall)",
  "event InsufficientReserve(address indexed keeper, uint256 icr, uint256 btcShortfallToMCR, uint256 btcShortfallToTarget, bool recoveryMode)",
  "event ProtocolFeePaid(address indexed treasury, uint256 btc, uint256 musd)",
  // the owner's own changes to the loan (used to tell a price-driven protection from one the owner caused)
  "event TroveOpened(uint256 collateral, uint256 debt, address recipient)",
  "event CollateralAdded(uint256 amount)",
  "event CollateralWithdrawn(uint256 amount, address to)",
  "event Borrowed(uint256 amount, address to)",
  "event Repaid(uint256 amount)",
  "event ConfigUpdated(bool enabled, uint16 tipBps, uint32 cooldown, uint64 minICR, uint64 targetICR)",
])
const OWNER_ACTIONS = new Set(["TroveOpened", "CollateralAdded", "CollateralWithdrawn", "Borrowed", "Repaid", "ConfigUpdated"])
const CHUNK = 9_999n
const SCAN_KEY = "stats:scan:v1"

interface RawEvent {
  name: string
  address: string // lowercase emitter
  block: number
  tx: string
  logIndex: number
  args: Record<string, string>
}

export interface ProtectionRow {
  tx: string
  block: number
  at: number
  guardian: string
  kind: "full" | "partial" | "insufficient"
  btcAdded: string
  musdRepaid: string
  icrBefore: string
  icrAfter: string
  price: string | null
  trigger: "price" | "owner" | "unknown"
  team: boolean
}

export interface StatsDto {
  network: string
  updatedAt: number
  excludedTeam: boolean
  guardians: number
  wallets: number
  activeLoans: number
  musdBorrowed: string
  btcCollateral: string
  protections: ProtectionRow[]
  revenue: { protocolFeesBTC: string; protocolFeesMUSD: string; tipsBTC: string; tipsMUSD: string; treasury: string | null; feeBps: number | null }
  contracts: Array<{ name: string; address: string; version: string; verified: boolean }>
}

interface GuardianRow {
  address: string
  owner: string
  version: number
  coll: bigint
  debt: bigint
  active: boolean
  team: boolean
}

const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v))

export class StatsService {
  private cache: { at: number; all: StatsDto; ext: StatsDto } | null = null
  private inflight: Promise<void> | null = null
  private verified: { at: number; map: Map<string, boolean> } | null = null

  constructor(private d: { chain: LiveChain; store: Store; config: Config; keeperAddress?: string; explorerApi?: string | null; ttlMs?: number }) {}

  /** Cached for a minute; a stale cache is served immediately while it refreshes in the background. */
  async get(includeTeam: boolean): Promise<StatsDto> {
    const ttl = this.d.ttlMs ?? 60_000
    if (!this.cache) await this.refresh()
    else if (Date.now() - this.cache.at > ttl) void this.refresh().catch((e) => console.warn("stats refresh:", (e as Error).message))
    return includeTeam ? this.cache!.all : this.cache!.ext
  }

  private refresh() {
    this.inflight ??= this.compute().finally(() => (this.inflight = null))
    return this.inflight
  }

  private teamSet() {
    const dep = this.d.chain.deployment
    return new Set([...(dep.teamWallets ?? []), this.d.keeperAddress, dep.keel?.treasury].filter(Boolean).map((a) => a!.toLowerCase()))
  }

  private async compute() {
    const { chain } = this.d
    const client = chain.client
    const dep = chain.deployment
    const team = this.teamSet()
    const tm = dep.musd.troveManager

    // ---- guardians on every factory, with owner and trove
    const factories = [
      ...(dep.keel ? [{ address: dep.keel.guardianFactory, version: dep.keel.version ?? 2 }] : []),
      ...(dep.legacy ?? []).map((l) => ({ address: l.guardianFactory, version: l.version ?? 1 })),
    ]
    const guardians: GuardianRow[] = []
    for (const f of factories) {
      const list = (await client.readContract({ address: f.address, abi: keelGuardianFactoryAbi, functionName: "guardians", args: [0n, 1000n] })) as Address[]
      const rows = await Promise.all(
        list.map(async (g) => {
          const [owner, status, dc] = await Promise.all([
            client.readContract({ address: g, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" }),
            client.readContract({ address: tm, abi: troveManagerAbi, functionName: "getTroveStatus", args: [g] }),
            client.readContract({ address: tm, abi: troveManagerAbi, functionName: "getEntireDebtAndColl", args: [g] }),
          ])
          const [c, p, i, pc, pp, pi] = dc as readonly bigint[]
          const active = Number(status) === 1
          return { address: g.toLowerCase(), owner: owner.toLowerCase(), version: f.version, coll: active ? c + pc : 0n, debt: active ? p + i + pp + pi : 0n, active, team: team.has(owner.toLowerCase()) }
        }),
      )
      guardians.push(...rows)
    }

    // ---- events (incremental scan), then protections with price and trigger
    const events = await this.scan()
    const byGuardian = new Map(guardians.map((g) => [g.address, g]))
    const mine = events.filter((e) => byGuardian.has(e.address))
    const partialTx = new Set(mine.filter((e) => e.name === "PartialRescue").map((e) => `${e.tx}:${e.address}`))
    const protections: ProtectionRow[] = []
    for (const e of mine) {
      if (e.name !== "Protected" && e.name !== "InsufficientReserve") continue
      const g = byGuardian.get(e.address)!
      const price = await this.priceAt(e.block)
      const lastOwner = mine.filter((x) => x.address === e.address && OWNER_ACTIONS.has(x.name) && (x.block < e.block || (x.block === e.block && x.logIndex < e.logIndex))).at(-1)
      let trigger: ProtectionRow["trigger"] = "unknown"
      if (lastOwner && price) {
        const before = await this.priceAt(lastOwner.block)
        // the market moved the ratio if BTC is clearly lower than at the owner's last change to the loan
        if (before) trigger = BigInt(price) * 1000n < BigInt(before) * 995n ? "price" : "owner"
      }
      const insufficient = e.name === "InsufficientReserve"
      // v1 guardians have no PartialRescue event: a rescue that stopped short of the owner's target was partial
      const cfg = mine.filter((x) => x.address === e.address && x.name === "ConfigUpdated" && x.block <= e.block).at(-1)
      const target = cfg ? BigInt(cfg.args.targetICR) : 1_500_000_000_000_000_000n // the guardian default when never configured
      const shortOfTarget = !insufficient && BigInt(e.args.icrAfter) * 1000n < target * 995n
      protections.push({
        tx: e.tx, block: e.block, at: await chain.blockTime(BigInt(e.block)), guardian: e.address,
        kind: insufficient ? "insufficient" : partialTx.has(`${e.tx}:${e.address}`) || shortOfTarget ? "partial" : "full",
        btcAdded: insufficient ? "0" : e.args.btcAdded, musdRepaid: insufficient ? "0" : e.args.musdRepaid,
        icrBefore: insufficient ? e.args.icr : e.args.icrBefore, icrAfter: insufficient ? e.args.icr : e.args.icrAfter,
        price, trigger, team: g.team,
      })
    }
    protections.sort((a, b) => b.block - a.block)

    // ---- revenue: the protocol share of tips (v2) and the tips keepers were paid
    const sum = (rows: RawEvent[], k: string) => rows.reduce((a, e) => a + BigInt(e.args[k] ?? "0"), 0n)
    const fees = mine.filter((e) => e.name === "ProtocolFeePaid")
    const tips = mine.filter((e) => e.name === "Protected")
    const feeInfo = dep.keel?.version === 2
      ? await client.readContract({ address: dep.keel.guardianFactory, abi: parseAbi(["function feeInfo() view returns (address, uint16)"]), functionName: "feeInfo" }).catch(() => null)
      : null
    const revenue = {
      protocolFeesBTC: sum(fees, "btc").toString(), protocolFeesMUSD: sum(fees, "musd").toString(),
      tipsBTC: sum(tips, "tipBTC").toString(), tipsMUSD: sum(tips, "tipMUSD").toString(),
      treasury: feeInfo ? feeInfo[0] : dep.keel?.treasury ?? null,
      // the share of the tip; the guardian's tip (max 1% of what's applied) is set per guardian by its owner
      feeBps: feeInfo ? Number(feeInfo[1]) : null,
    }

    const contracts = await this.contracts()
    const build = (includeTeam: boolean): StatsDto => {
      const gs = guardians.filter((g) => includeTeam || !g.team)
      const active = gs.filter((g) => g.active)
      return {
        network: this.d.config.network,
        updatedAt: Math.floor(Date.now() / 1000),
        excludedTeam: !includeTeam,
        guardians: gs.length,
        wallets: new Set(gs.map((g) => g.owner)).size,
        activeLoans: active.length,
        musdBorrowed: active.reduce((a, g) => a + g.debt, 0n).toString(),
        btcCollateral: active.reduce((a, g) => a + g.coll, 0n).toString(),
        protections: protections.filter((p) => includeTeam || !p.team),
        revenue,
        contracts,
      }
    }
    this.cache = { at: Date.now(), all: build(true), ext: build(false) }
  }

  /** Every Keel-shaped event since the first deployment; resumes from the stored cursor. */
  private async scan(): Promise<RawEvent[]> {
    const client = this.d.chain.client
    const saved = JSON.parse(this.d.store.getKv(SCAN_KEY) ?? "null") as { next: number; events: RawEvent[] } | null
    const head = await client.getBlockNumber()
    let from = BigInt(saved?.next ?? this.d.chain.deployment.deployBlock ?? Number(head - 200_000n))
    const events = saved?.events ?? []
    const seen = new Set(events.map((e) => `${e.tx}:${e.logIndex}`))
    while (from <= head) {
      const to = from + CHUNK > head ? head : from + CHUNK
      const logs = await client.getLogs({ events: EVENTS, fromBlock: from, toBlock: to })
      for (const l of logs) {
        const k = `${l.transactionHash}:${l.logIndex}`
        if (seen.has(k)) continue
        seen.add(k)
        let decoded: { eventName: string; args: Record<string, unknown> }
        try {
          decoded = decodeEventLog({ abi: EVENTS, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }) as never
        } catch {
          continue // another contract's event with a clashing signature but a different layout
        }
        events.push({
          name: decoded.eventName, address: l.address.toLowerCase(), block: Number(l.blockNumber), tx: l.transactionHash!, logIndex: l.logIndex!,
          args: Object.fromEntries(Object.entries(decoded.args ?? {}).map(([k2, v]) => [k2, str(v)])),
        })
      }
      from = to + 1n
      // checkpoint as we go, so a restart in the middle of the first scan doesn't start over
      this.d.store.setKv(SCAN_KEY, JSON.stringify({ next: Number(from), events }))
    }
    return events
  }

  private async priceAt(block: number): Promise<string | null> {
    const key = `stats:price:${block}`
    const hit = this.d.store.getKv(key)
    if (hit) return hit
    const p = await this.d.chain.client
      .readContract({ address: this.d.chain.deployment.musd.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice", blockNumber: BigInt(block) })
      .catch(() => null)
    if (p === null) return null
    this.d.store.setKv(key, p.toString())
    return p.toString()
  }

  /** Keel's contracts with their verification status on the Mezo explorer (Blockscout), cached for 10 minutes. */
  private async contracts(): Promise<StatsDto["contracts"]> {
    const dep = this.d.chain.deployment
    const list: Array<{ name: string; address?: string; version: string }> = [
      { name: "KeelGuardianFactory", address: dep.keel?.guardianFactory, version: `v${dep.keel?.version ?? 1}` },
      { name: "KeelGuardian implementation", address: dep.keel?.guardianImplementation, version: `v${dep.keel?.version ?? 1}` },
      { name: "KeelPay", address: dep.keel?.pay, version: `v${dep.keel?.version ?? 1}` },
      { name: "KeelPro", address: dep.keel?.pro, version: "v1" },
      ...(dep.legacy ?? []).flatMap((l) => [
        { name: "KeelGuardianFactory", address: l.guardianFactory, version: `v${l.version ?? 1}` },
        { name: "KeelGuardian implementation", address: l.guardianImplementation, version: `v${l.version ?? 1}` },
        { name: "KeelPay", address: l.pay, version: `v${l.version ?? 1}` },
      ]),
    ]
    const rows = list.filter((c): c is { name: string; address: string; version: string } => !!c.address)
    const api = this.d.explorerApi === undefined ? (this.d.config.network === "mainnet" ? "https://api.explorer.mezo.org" : "https://api.explorer.test.mezo.org") : this.d.explorerApi
    if (api && (!this.verified || Date.now() - this.verified.at > 600_000)) {
      const map = new Map<string, boolean>()
      await Promise.all(
        rows.map(async (c) => {
          const r = await fetch(`${api}/api/v2/addresses/${c.address}`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
          const j = r?.ok ? ((await r.json().catch(() => null)) as { is_verified?: boolean } | null) : null
          map.set(c.address.toLowerCase(), !!j?.is_verified)
        }),
      )
      this.verified = { at: Date.now(), map }
    }
    return rows.map((c) => ({ ...c, verified: this.verified?.map.get(c.address.toLowerCase()) ?? false }))
  }
}
