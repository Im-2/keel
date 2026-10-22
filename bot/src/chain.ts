import type { Address } from "viem"
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
}

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
}
