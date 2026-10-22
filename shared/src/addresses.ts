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
}

export const PYTH_MEZO: Address = "0x2880aB155794e7179c9eE2e38200202908C17B43"

export interface Deployment {
  network: NetworkName
  chainId: number
  musd: MusdAddresses
  keel: KeelAddresses | null
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
  const keel = gf && pay && gf !== ZERO && pay !== ZERO ? { guardianFactory: gf, pay } : null
  return { network, chainId: network === "mainnet" ? 31612 : network === "testnet" ? 31611 : 31612, musd, keel }
}
