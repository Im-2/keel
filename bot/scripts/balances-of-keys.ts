// Read-only: BTC and MUSD held by the keys in .env (addresses only, never the keys).
import { createPublicClient, http, erc20Abi, formatUnits, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { MUSD, chainFor } from "@keel/shared"
const pub = createPublicClient({ chain: chainFor("testnet"), transport: http() })
for (const name of ["DEPLOYER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"]) {
  const k = process.env[name]
  if (!k) continue
  const a = privateKeyToAccount(k as Hex).address
  const [btc, musd] = await Promise.all([pub.getBalance({ address: a }), pub.readContract({ address: MUSD.testnet.musd, abi: erc20Abi, functionName: "balanceOf", args: [a] })])
  console.log(name.replace("_PRIVATE_KEY", ""), a, formatUnits(btc, 18), "BTC", formatUnits(musd, 18), "MUSD")
}
