import { resolveDeployment, type Deployment } from "./addresses"
import type { NetworkName } from "./chains"
import testnet from "../deployments/testnet.json"
import mainnet from "../deployments/mainnet.json"
import local from "../deployments/local.json"

/** Resolve a network's deployment from the committed JSON files plus optional env overrides. */
export function getDeployment(network: NetworkName, overrides?: { guardianFactory?: string; pay?: string }): Deployment {
  return resolveDeployment(
    network,
    { testnet: testnet as never, mainnet: mainnet as never, local: local as never },
    overrides,
  )
}
