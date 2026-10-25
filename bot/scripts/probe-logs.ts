// Read-only: how consistently does the public RPC return MUSD Transfer logs to an address around a block?
import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem"
import { MUSD, chainFor } from "@keel/shared"
const pub = createPublicClient({ chain: chainFor("testnet"), transport: http() })
const [to, ...hashes] = process.argv.slice(2)
const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")
for (const h of hashes) {
  for (let i = 0; i < 4; i++) {
    const r = await pub.getTransactionReceipt({ hash: h as Hex }).catch(() => null)
    if (r) { console.log(h.slice(0, 10), "block", r.blockNumber); break }
  }
}
const head = await pub.getBlockNumber()
console.log("head", head)
for (let i = 0; i < 6; i++) {
  const logs = await pub.getLogs({ address: MUSD.testnet.musd, event: ev, args: { to: [to as Address] }, fromBlock: head - 9000n, toBlock: head }).catch((e) => e.shortMessage as string)
  console.log("try", i, typeof logs === "string" ? "ERROR " + logs : logs.map((l) => `${l.blockNumber}:${l.transactionHash.slice(0, 10)}`).join(" ") || "(none)")
}
