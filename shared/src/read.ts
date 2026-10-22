import { createPublicClient, http, type Address, type PublicClient } from "viem"
import { chainFor, type NetworkName } from "./chains"
import type { KeelAddresses, MusdAddresses } from "./addresses"
import {
  borrowerOperationsAbi,
  interestRateManagerAbi,
  keelGuardianAbi,
  keelGuardianFactoryAbi,
  priceFeedAbi,
  troveManagerAbi,
} from "./generated/abis"
import {
  computeIcr,
  liquidationPrice,
  priceBufferBps,
  riskLevel,
  type RiskLevel,
  type TroveSnapshot,
} from "./risk"

export type Client = PublicClient

export function makeClient(network: NetworkName, rpcUrl?: string): Client {
  const chain = chainFor(network)
  return createPublicClient({
    chain,
    // JSON-RPC batching keeps trove scans to a handful of HTTP round trips on any RPC.
    transport: http(rpcUrl ?? chain.rpcUrls.default.http[0], { batch: { batchSize: 100, wait: 10 }, retryCount: 3 }),
  }) as Client
}

export interface SystemState {
  price: bigint
  tcr: bigint
  recoveryMode: boolean
  minNetDebt: bigint
  borrowingRate: bigint
  interestRateBps: number
}

export async function readSystem(client: Client, a: MusdAddresses): Promise<SystemState> {
  const price = await client.readContract({ address: a.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice" })
  const [tcr, recoveryMode, minNetDebt, borrowingRate, interestRateBps] = await Promise.all([
    client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTCR", args: [price] }),
    client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "checkRecoveryMode", args: [price] }),
    client.readContract({ address: a.borrowerOperations, abi: borrowerOperationsAbi, functionName: "minNetDebt" }),
    client.readContract({ address: a.borrowerOperations, abi: borrowerOperationsAbi, functionName: "borrowingRate" }),
    client.readContract({ address: a.interestRateManager, abi: interestRateManagerAbi, functionName: "interestRate" }),
  ])
  return { price, tcr, recoveryMode, minNetDebt, borrowingRate, interestRateBps: Number(interestRateBps) }
}

export interface TroveState {
  troveOwner: Address
  active: boolean
  coll: bigint
  debt: bigint
  icr: bigint
  price: bigint
  liqPrice: bigint
  bufferBps: number
  risk: RiskLevel
  interestRateBps: number
}

export async function readTrove(client: Client, a: MusdAddresses, troveOwner: Address, knownPrice?: bigint): Promise<TroveState> {
  const price = knownPrice ?? (await client.readContract({ address: a.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice" }))
  const [status, entire, rate] = await Promise.all([
    client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTroveStatus", args: [troveOwner] }),
    client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getEntireDebtAndColl", args: [troveOwner] }),
    client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTroveInterestRate", args: [troveOwner] }),
  ])
  const [coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest] = entire
  const totalColl = coll + pendingColl
  const debt = principal + interest + pendingPrincipal + pendingInterest
  const active = Number(status) === 1
  const icr = active ? computeIcr(totalColl, debt, price) : 0n
  const liqPrice = active ? liquidationPrice(totalColl, debt) : 0n
  return {
    troveOwner,
    active,
    coll: totalColl,
    debt,
    icr,
    price,
    liqPrice,
    bufferBps: active ? priceBufferBps(price, liqPrice) : 0,
    risk: active ? riskLevel(icr) : "safe",
    interestRateBps: Number(rate),
  }
}

/** Read every active trove (owner, collateral, debt, ICR). Used for redemption-queue exposure. */
export async function scanTroves(client: Client, a: MusdAddresses, price: bigint, max = 5000): Promise<TroveSnapshot[]> {
  const count = Number(await client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTroveOwnersCount" }))
  const n = Math.min(count, max)
  const owners = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTroveFromTroveOwnersArray", args: [BigInt(i)] }),
    ),
  )
  const rows = await Promise.all(
    owners.map(async (owner) => {
      const [status, entire] = await Promise.all([
        client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getTroveStatus", args: [owner] }),
        client.readContract({ address: a.troveManager, abi: troveManagerAbi, functionName: "getEntireDebtAndColl", args: [owner] }),
      ])
      if (Number(status) !== 1) return null
      const coll = entire[0] + entire[3]
      const debt = entire[1] + entire[2] + entire[4] + entire[5]
      return { owner, coll, debt, icr: computeIcr(coll, debt, price) } satisfies TroveSnapshot
    }),
  )
  return rows.filter((r): r is TroveSnapshot => r !== null)
}

export interface GuardianState {
  guardian: Address
  owner: Address
  enabled: boolean
  tipBps: number
  cooldown: number
  minIcr: bigint
  targetIcr: bigint
  reserveBTC: bigint
  reserveMUSD: bigint
  canProtect: boolean
  btcToAdd: bigint
  musdToRepay: bigint
  resultingIcr: bigint
}

export async function findGuardian(client: Client, keel: KeelAddresses, owner: Address): Promise<Address | null> {
  const g = await client.readContract({ address: keel.guardianFactory, abi: keelGuardianFactoryAbi, functionName: "guardianOf", args: [owner] })
  return g === "0x0000000000000000000000000000000000000000" ? null : g
}

export async function readGuardian(client: Client, guardian: Address): Promise<GuardianState> {
  const [cfg, pos, status, owner] = await Promise.all([
    client.readContract({ address: guardian, abi: keelGuardianAbi, functionName: "config" }),
    client.readContract({ address: guardian, abi: keelGuardianAbi, functionName: "position" }),
    client.readContract({ address: guardian, abi: keelGuardianAbi, functionName: "protectionStatus" }).catch(() => null),
    client.readContract({ address: guardian, abi: keelGuardianAbi, functionName: "owner" }),
  ])
  const [enabled, tipBps, cooldown, minIcr, targetIcr] = cfg
  return {
    guardian,
    owner,
    enabled,
    tipBps,
    cooldown,
    minIcr,
    targetIcr,
    reserveBTC: pos[4],
    reserveMUSD: pos[5],
    canProtect: status ? status[0] : false,
    btcToAdd: status ? status[2] : 0n,
    musdToRepay: status ? status[3] : 0n,
    resultingIcr: status ? status[4] : 0n,
  }
}
