import type { Address } from "viem"
import type { NetworkName } from "./chains"
import musdJson from "../deployments/musd.json"

/** MUSD protocol addresses, taken from mezo-org/musd `solidity/artifacts/deployments/{matsnet,mainnet}`. */
export interface MusdAddresses {
  musd: Address
  borrowerOperations: Address
  borrowerOperationsSignatures: Address
  troveManager: Address
  sortedTroves: Address
  hintHelpers: Address
  priceFeed: Address
  interestRateManager: Address
  stabilityPool: Address
}

export const MUSD = musdJson as unknown as Record<"testnet" | "mainnet", MusdAddresses>

/** Keel's own contracts. Filled in by `contracts/scripts/deploy-keel.ts` -> shared/deployments/<network>.json */
export interface KeelAddresses {
  guardianFactory: Address
  pay: Address
  /** 1 = KeelGuardianFactory (reverts when the reserve can't reach the target), 2 = V2 (partial rescue). */
  version?: number
  guardianImplementation?: Address
  /** KeelPro subscriptions (v2 deployments). */
  pro?: Address
  /** Receives the protocol share of keeper tips and KeelPro payments (v2 deployments). */
  treasury?: Address
  protocolShareBps?: number
}

export const PYTH_MEZO: Address = "0x2880aB155794e7179c9eE2e38200202908C17B43"

export interface Deployment {
  network: NetworkName
  chainId: number
  musd: MusdAddresses
  /** The contracts new guardians and new claim links use. */
  keel: KeelAddresses | null
  /** Earlier Keel deployments that existing guardians and claim links still live on (read, never created on). */
  legacy?: KeelAddresses[]
  /** First block with a Keel contract (where log scans start). */
  deployBlock?: number
  /** The Keel team's own and test wallets, excluded from public stats by default. */
  teamWallets?: Address[]
}

const ZERO = "0x0000000000000000000000000000000000000000"

/**
 * Build the deployment for a network. `keel` comes from `shared/deployments/<network>.json`
 * (written by `contracts/scripts/deploy-keel.ts`) or, for hosted builds, from env overrides.
 * For `local`, the whole thing (including MUSD) comes from `deployments/local.json`.
 */
export function resolveDeployment(
  network: NetworkName,
  files: { testnet?: Partial<Deployment>; mainnet?: Partial<Deployment>; local?: Partial<Deployment> },
  overrides?: { guardianFactory?: string; pay?: string },
): Deployment {
  const f = files[network] ?? {}
  const musd = network === "local" ? (f.musd as MusdAddresses) : MUSD[network]
  if (!musd) throw new Error(`No MUSD addresses for ${network}. Run the local seed script first.`)
  const gf = (overrides?.guardianFactory || f.keel?.guardianFactory) as Address | undefined
  const pay = (overrides?.pay || f.keel?.pay) as Address | undefined
  const fromFile = !overrides?.guardianFactory && !overrides?.pay
  const keel = gf && pay && gf !== ZERO && pay !== ZERO ? { ...(fromFile ? f.keel : {}), guardianFactory: gf, pay } : null
  const legacy = ((f as { legacy?: KeelAddresses[] }).legacy ?? []).filter((l) => l.guardianFactory.toLowerCase() !== gf?.toLowerCase())
  const extra = f as { deployBlock?: number; teamWallets?: Address[] }
  return { network, chainId: network === "mainnet" ? 31612 : network === "testnet" ? 31611 : 31612, musd, keel, legacy, deployBlock: extra.deployBlock, teamWallets: extra.teamWallets ?? [] }
}
