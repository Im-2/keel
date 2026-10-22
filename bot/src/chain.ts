import { parseAbiItem, type Address } from "viem"
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
  /** Receipt summary for completion checks; null if not mined yet. */
  receipt(hash: string): Promise<{ ok: boolean; from: Address } | null>
  /** Keeper `Protected` events emitted by the given guardians in [from, to]. */
  protectedEvents(guardians: Address[], from: bigint, to: bigint): Promise<ProtectedEvent[]>
  /** MUSD transfers received by the given addresses in [from, to]. */
  incomingTransfers(addresses: Address[], from: bigint, to: bigint): Promise<TransferEvent[]>
}

export interface ProtectedEvent { guardian: Address; btcAdded: bigint; musdRepaid: bigint; icrBefore: bigint; icrAfter: bigint; tx: string }
export interface TransferEvent { from: Address; to: Address; value: bigint; tx: string }

const protectedEvent = parseAbiItem("event Protected(address indexed keeper, uint8 action, uint256 btcAdded, uint256 musdRepaid, uint256 icrBefore, uint256 icrAfter, uint256 tipBTC, uint256 tipMUSD)")
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")

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

  async protectedEvents(guardians: Address[], from: bigint, to: bigint): Promise<ProtectedEvent[]> {
    if (guardians.length === 0 || from > to) return []
    const logs = await this.client.getLogs({ address: guardians, event: protectedEvent, fromBlock: from, toBlock: to })
    return logs.map((l) => ({
      guardian: l.address, btcAdded: l.args.btcAdded!, musdRepaid: l.args.musdRepaid!,
      icrBefore: l.args.icrBefore!, icrAfter: l.args.icrAfter!, tx: l.transactionHash,
    }))
  }

  async incomingTransfers(addresses: Address[], from: bigint, to: bigint): Promise<TransferEvent[]> {
    if (addresses.length === 0 || from > to) return []
    const logs = await this.client.getLogs({ address: this.deployment.musd.musd, event: transferEvent, args: { to: addresses }, fromBlock: from, toBlock: to })
    return logs.map((l) => ({ from: l.args.from!, to: l.args.to!, value: l.args.value!, tx: l.transactionHash }))
  }

  async receipt(hash: string): Promise<{ ok: boolean; from: Address } | null> {
    const rc = await this.client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null)
    return rc ? { ok: rc.status === "success", from: rc.from } : null
  }
}
