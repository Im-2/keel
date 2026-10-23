import { createWalletClient, http, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { chainFor, keelPayAbi } from "@keel/shared"
import type { Config } from "./config"
import type { LiveChain } from "./chain"

export interface LinkInfo {
  sender: Address
  amount: bigint
  expiry: number
  settled: boolean
}

/** Gas-only relayer for claim links. The signature binds the recipient, so the relayer can never redirect funds. */
export interface ClaimRelayer {
  link(link: Address): Promise<LinkInfo | null>
  claim(link: Address, to: Address, signature: Hex): Promise<Hex>
}

export class LiveClaimRelayer implements ClaimRelayer {
  private wallet
  private pay: Address
  constructor(private chain: LiveChain, config: Config) {
    if (!config.relayerKey) throw new Error("RELAYER_PRIVATE_KEY (or KEEPER_PRIVATE_KEY) is required for claim relays")
    this.pay = chain.deployment.keel!.pay
    this.wallet = createWalletClient({ account: privateKeyToAccount(config.relayerKey), chain: chainFor(config.network), transport: http(config.rpcUrl) })
  }

  async link(link: Address): Promise<LinkInfo | null> {
    const [sender, amount, expiry, settled] = await this.chain.client.readContract({ address: this.pay, abi: keelPayAbi, functionName: "links", args: [link] })
    if (sender === "0x0000000000000000000000000000000000000000") return null
    return { sender, amount, expiry: Number(expiry), settled }
  }

  async claim(link: Address, to: Address, signature: Hex): Promise<Hex> {
    // simulating first surfaces BadSignature / Expired / LinkSettled without spending gas
    const call = { address: this.pay, abi: keelPayAbi, functionName: "claim", args: [link, to, signature], account: this.wallet.account } as const
    const { request } = await this.chain.client.simulateContract(call)
    const est = ((await this.chain.client.estimateContractGas(call)) * 3n) / 2n // same margin as the keeper
    const gas = est > 150_000n ? est : 150_000n // floor: a lagging node may price the reverted path
    const hash = await this.wallet.writeContract({ ...request, gas })
    const rc = await this.chain.client.waitForTransactionReceipt({ hash })
    if (rc.status !== "success") throw new Error("claim reverted")
    return hash
  }
}
