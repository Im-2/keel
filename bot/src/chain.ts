import { erc20Abi, parseAbiItem, type Address } from "viem"
import {
  findGuardian, makeClient, readGuardian, readSystem, readTrove, redemptionAhead, scanTroves,
  keelGuardianFactoryAbi,
  type Client, type Deployment, type GuardianState, type SystemState, type TroveSnapshot, type TroveState,
} from "@keel/shared"

export interface UserView {
  kind: "guardian" | "direct" | "none"
  address: Address // the user's wallet
  troveOwner: Address | null // the guardian (kind=guardian) or the wallet itself (kind=direct)
  trove: TroveState | null
  guardian: GuardianState | null // present when the user has a guardian account (even without an open trove)
  guardianAddress: Address | null
  redemption: { ahead: bigint; rank: number; total: number } | null
}

/** Everything the bot needs from the chain. Faked in tests. */
export interface ChainService {
  readonly deployment: Deployment
  system(force?: boolean): Promise<SystemState>
  view(address: Address): Promise<UserView>
  troves(): Promise<TroveSnapshot[]>
  guardianCount(): Promise<number>
  blockNumber(): Promise<bigint>
  balance(address: Address): Promise<bigint>
  /** MUSD held by the wallet itself (not the loan). */
  musdBalance(address: Address): Promise<bigint>
  /** The wallet's guardian contract, if it has one. */
  guardianOf(address: Address): Promise<Address | null>
  blockTime(block: bigint): Promise<number>
  /**
   * Receipt summary for completion checks; null if no node has it yet. `ok` is true only for a successful
   * (not reverted) transaction. Public RPC nodes lag each other, so a miss is retried before giving up.
   */
  receipt(hash: string): Promise<Receipt | null>
  /** Keeper `Protected` events emitted by the given guardians in [from, to]. */
  protectedEvents(guardians: Address[], from: bigint, to: bigint): Promise<ProtectedEvent[]>
  /** MUSD transfers sent or received by the given addresses in [from, to]. */
  musdTransfers(addresses: Address[], from: bigint, to: bigint): Promise<TransferEvent[]>
  /** KeelPay claim-link events in [from, to]. */
  payEvents(from: bigint, to: bigint): Promise<PayEvent[]>
}

export interface Receipt { ok: boolean; status: "success" | "reverted"; from: Address; block: bigint }
export interface ProtectedEvent { guardian: Address; btcAdded: bigint; musdRepaid: bigint; icrBefore: bigint; icrAfter: bigint; tx: string; block?: bigint; logIndex?: number }
export interface TransferEvent { from: Address; to: Address; value: bigint; tx: string; block: bigint; logIndex: number }
export interface PayEvent { kind: "created" | "claimed" | "cancelled"; link: Address; sender?: Address; to?: Address; amount: bigint; tx: string; block: bigint; logIndex: number }

const protectedEvent = parseAbiItem("event Protected(address indexed keeper, uint8 action, uint256 btcAdded, uint256 musdRepaid, uint256 icrBefore, uint256 icrAfter, uint256 tipBTC, uint256 tipMUSD)")
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")
const linkCreated = parseAbiItem("event LinkCreated(address indexed link, address indexed sender, uint256 amount, uint64 expiry)")
const linkClaimed = parseAbiItem("event LinkClaimed(address indexed link, address indexed to, uint256 amount, address relayer)")
const linkCancelled = parseAbiItem("event LinkCancelled(address indexed link, address indexed sender, uint256 amount)")

export class LiveChain implements ChainService {
  client: Client
  private sysCache: { at: number; v: SystemState } | null = null
  private trovesCache: { at: number; v: TroveSnapshot[] } | null = null

  constructor(readonly deployment: Deployment, rpcUrl?: string, private ttlMs = 8_000, private scanTtlMs = 60_000) {
    this.client = makeClient(deployment.network, rpcUrl)
  }

  async system(force = false): Promise<SystemState> {
    if (!force && this.sysCache && Date.now() - this.sysCache.at < this.ttlMs) return this.sysCache.v
    const v = await readSystem(this.client, this.deployment.musd)
    this.sysCache = { at: Date.now(), v }
    return v
  }

  async troves(): Promise<TroveSnapshot[]> {
    if (this.trovesCache && Date.now() - this.trovesCache.at < this.scanTtlMs) return this.trovesCache.v
    const sys = await this.system()
    const v = await scanTroves(this.client, this.deployment.musd, sys.price)
    this.trovesCache = { at: Date.now(), v }
    return v
  }

  async view(address: Address): Promise<UserView> {
    const keel = this.deployment.keel!
    const sys = await this.system()
    const guardianAddress = await findGuardian(this.client, keel, address)
    const guardian = guardianAddress ? await readGuardian(this.client, guardianAddress) : null

    let troveOwner: Address | null = null
    let trove: TroveState | null = null
    if (guardianAddress) {
      const t = await readTrove(this.client, this.deployment.musd, guardianAddress, sys.price)
      if (t.active) {
        troveOwner = guardianAddress
        trove = t
      }
    }
    if (!trove) {
      const t = await readTrove(this.client, this.deployment.musd, address, sys.price)
      if (t.active) {
        troveOwner = address
        trove = t
      }
    }
    const redemption = trove && troveOwner ? redemptionAhead(await this.troves(), troveOwner) : null
    return {
      kind: trove ? (troveOwner === guardianAddress ? "guardian" : "direct") : "none",
      address,
      troveOwner,
      trove,
      guardian,
      guardianAddress,
      redemption,
    }
  }

  async guardianCount(): Promise<number> {
    const n = await this.client.readContract({ address: this.deployment.keel!.guardianFactory, abi: keelGuardianFactoryAbi, functionName: "totalGuardians" })
    return Number(n)
  }

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  private times = new Map<bigint, number>()
  async blockTime(block: bigint): Promise<number> {
    const hit = this.times.get(block)
    if (hit) return hit
    const t = Number((await this.client.getBlock({ blockNumber: block })).timestamp)
    if (this.times.size > 5000) this.times.clear()
    this.times.set(block, t)
    return t
  }

  balance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address })
  }

  musdBalance(address: Address): Promise<bigint> {
    return this.client.readContract({ address: this.deployment.musd.musd, abi: erc20Abi, functionName: "balanceOf", args: [address] })
  }

  async guardianOf(address: Address): Promise<Address | null> {
    if (!this.deployment.keel) return null
    return (await findGuardian(this.client, this.deployment.keel, address)) ?? null
  }

  async protectedEvents(guardians: Address[], from: bigint, to: bigint): Promise<ProtectedEvent[]> {
    if (guardians.length === 0 || from > to) return []
    const logs = await this.client.getLogs({ address: guardians, event: protectedEvent, fromBlock: from, toBlock: to })
    return logs.map((l) => ({
      guardian: l.address, btcAdded: l.args.btcAdded!, musdRepaid: l.args.musdRepaid!,
      icrBefore: l.args.icrBefore!, icrAfter: l.args.icrAfter!, tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex,
    }))
  }

  async musdTransfers(addresses: Address[], from: bigint, to: bigint): Promise<TransferEvent[]> {
    if (addresses.length === 0 || from > to) return []
    const q = { address: this.deployment.musd.musd, event: transferEvent, fromBlock: from, toBlock: to } as const
    const [incoming, outgoing] = await Promise.all([this.client.getLogs({ ...q, args: { to: addresses } }), this.client.getLogs({ ...q, args: { from: addresses } })])
    const seen = new Set<string>()
    const out: TransferEvent[] = []
    for (const l of [...incoming, ...outgoing]) {
      const k = `${l.transactionHash}:${l.logIndex}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ from: l.args.from!, to: l.args.to!, value: l.args.value!, tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex })
    }
    return out
  }

  async payEvents(from: bigint, to: bigint): Promise<PayEvent[]> {
    const pay = this.deployment.keel?.pay
    if (!pay || from > to) return []
    const logs = await this.client.getLogs({ address: pay, events: [linkCreated, linkClaimed, linkCancelled], fromBlock: from, toBlock: to })
    return logs.map((l) => {
      const base = { link: l.args.link!, amount: l.args.amount!, tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex }
      if (l.eventName === "LinkCreated") return { ...base, kind: "created" as const, sender: l.args.sender }
      if (l.eventName === "LinkClaimed") return { ...base, kind: "claimed" as const, to: l.args.to }
      return { ...base, kind: "cancelled" as const, sender: (l.args as { sender?: Address }).sender }
    })
  }

  async receipt(hash: string, tries = 5): Promise<Receipt | null> {
    for (let i = 0; i < tries; i++) {
      const rc = await this.client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null)
      if (rc) return { ok: rc.status === "success", status: rc.status, from: rc.from, block: rc.blockNumber }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
    return null
  }
}
