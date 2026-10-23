import { createWalletClient, http, type Address, type Hex, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { chainFor, keelGuardianAbi, keelGuardianFactoryAbi } from "@keel/shared"
import type { Config } from "./config"
import type { LiveChain } from "./chain"
import type { Store } from "./db"

/** What the keeper needs from the chain; faked in tests. */
export interface KeeperBackend {
  guardians(): Promise<Address[]>
  canProtect(guardian: Address): Promise<boolean>
  protect(guardian: Address): Promise<Hex>
}

const ZERO = "0x0000000000000000000000000000000000000000" as const

export class LiveKeeperBackend implements KeeperBackend {
  wallet: WalletClient
  constructor(private chain: LiveChain, config: Config) {
    if (!config.keeperKey) throw new Error("KEEPER_PRIVATE_KEY is required to run the keeper")
    this.wallet = createWalletClient({ account: privateKeyToAccount(config.keeperKey), chain: chainFor(config.network), transport: http(config.rpcUrl) })
  }
  get address() {
    return this.wallet.account!.address
  }

  async guardians(): Promise<Address[]> {
    const factory = this.chain.deployment.keel!.guardianFactory
    const out: Address[] = []
    for (let offset = 0n; ; offset += 200n) {
      const page = await this.chain.client.readContract({ address: factory, abi: keelGuardianFactoryAbi, functionName: "guardians", args: [offset, 200n] })
      out.push(...page)
      if (page.length < 200) return out
    }
  }

  async canProtect(guardian: Address): Promise<boolean> {
    const s = await this.chain.client.readContract({ address: guardian, abi: keelGuardianAbi, functionName: "protectionStatus" }).catch(() => null)
    return !!s && s[0]
  }

  async protect(guardian: Address): Promise<Hex> {
    const call = { address: guardian, abi: keelGuardianAbi, functionName: "protect", args: [ZERO, ZERO], account: this.wallet.account! } as const
    const { request } = await this.chain.client.simulateContract(call)
    // protect() searches sorted-trove hints on-chain, whose cost varies between estimate and execution, and the
    // 63/64 gas rule starves the inner call near the limit: two testnet attempts ran out of gas at 97% used.
    const est = ((await this.chain.client.estimateContractGas(call)) * 3n) / 2n
    const gas = est > 1_200_000n ? est : 1_200_000n // floor: a lagging node may price the reverted path
    const hash = await this.wallet.writeContract({ ...request, gas })
    const rc = await this.chain.client.waitForTransactionReceipt({ hash })
    if (rc.status !== "success") throw new Error(`protect reverted: ${hash}`)
    return hash
  }
}

export class Keeper {
  constructor(private backend: KeeperBackend, private store: Store, private log: (m: string) => void = console.log) {}

  /** Scan every guardian once and protect the ones that need it. Returns the guardians protected. */
  async tick(): Promise<Address[]> {
    const done: Address[] = []
    for (const g of await this.backend.guardians()) {
      try {
        if (!(await this.backend.canProtect(g))) continue
        // public RPC nodes can lag or flake right after a state change: re-check once before giving up
        const tx = await this.backend.protect(g).catch(async (e) => {
          if (!(await this.backend.canProtect(g))) return null
          this.log(`keeper: ${g} retrying after: ${(e as Error).message.split("\n")[0]}`)
          return this.backend.protect(g)
        })
        if (!tx) continue
        this.log(`keeper: protected ${g} in ${tx}`)
        this.store.setKv("stat:keeper_protections", String(Number(this.store.getKv("stat:keeper_protections") ?? "0") + 1))
        done.push(g)
      } catch (e) {
        this.log(`keeper: ${g} failed: ${(e as Error).message.split("\n")[0]}`)
      }
    }
    return done
  }
}
