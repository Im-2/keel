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
  /** The KeelPay contract holding this link (the claim signature's verifyingContract). */
  pay: Address
}

/** Gas-only relayer for claim links. The signature binds the recipient, so the relayer can never redirect funds. */
export interface ClaimRelayer {
  link(link: Address): Promise<LinkInfo | null>
  claim(link: Address, to: Address, signature: Hex): Promise<Hex>
}

export class LiveClaimRelayer implements ClaimRelayer {
  private wallet
  constructor(private chain: LiveChain, config: Config) {
    if (!config.relayerKey) throw new Error("RELAYER_PRIVATE_KEY (or KEEPER_PRIVATE_KEY) is required for claim relays")
    this.wallet = createWalletClient({ account: privateKeyToAccount(config.relayerKey), chain: chainFor(config.network), transport: http(config.rpcUrl) })
  }

  /** Looks the link up on the current KeelPay, then on legacy ones (links made before an upgrade). */
  async link(link: Address): Promise<LinkInfo | null> {
    for (const pay of this.chain.pays()) {
      const [sender, amount, expiry, settled] = await this.chain.client.readContract({ address: pay, abi: keelPayAbi, functionName: "links", args: [link] })
      if (sender !== "0x0000000000000000000000000000000000000000") return { sender, amount, expiry: Number(expiry), settled, pay }
    }
    return null
  }

  async claim(link: Address, to: Address, signature: Hex): Promise<Hex> {
    const pay = (await this.link(link))?.pay ?? this.chain.pays()[0]
    // simulating first surfaces BadSignature / Expired / LinkSettled without spending gas
    const call = { address: pay, abi: keelPayAbi, functionName: "claim", args: [link, to, signature], account: this.wallet.account } as const
    const { request } = await this.chain.client.simulateContract(call)
    const est = ((await this.chain.client.estimateContractGas(call)) * 3n) / 2n // same margin as the keeper
    const gas = est > 150_000n ? est : 150_000n // floor: a lagging node may price the reverted path
    const hash = await this.wallet.writeContract({ ...request, gas })
    const rc = await this.chain.client.waitForTransactionReceipt({ hash })
    if (rc.status !== "success") throw new Error("claim reverted")
    return hash
  }
}
