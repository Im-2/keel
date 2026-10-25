// Read-only: decode a tx's receipt and MUSD Transfer logs, plus balances of the parties. Usage: tsx scripts/inspect-tx.ts <hash> [addr...]
import { createPublicClient, http, parseAbiItem, decodeEventLog, formatUnits, erc20Abi, type Hex, type Address } from "viem"
import { MUSD, chainFor } from "@keel/shared"
const d = { musd: MUSD.testnet! }
const pub = createPublicClient({ chain: chainFor("testnet"), transport: http() })
const [hash, ...addrs] = process.argv.slice(2)
const tx = await pub.getTransaction({ hash: hash as Hex })
const r = await pub.getTransactionReceipt({ hash: hash as Hex })
console.log({ from: tx.from, to: tx.to, status: r.status, block: r.blockNumber, input: tx.input.slice(0, 10), musd: d.musd.musd })
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")
for (const l of r.logs) {
  try {
    const e = decodeEventLog({ abi: [transfer], data: l.data, topics: l.topics })
    console.log("Transfer", l.address, e.args.from, "->", e.args.to, formatUnits(e.args.value, 18))
  } catch { console.log("log", l.address, l.topics[0]) }
}
for (const a of [tx.from, ...addrs]) console.log("MUSD balance", a, formatUnits(await pub.readContract({ address: d.musd.musd, abi: erc20Abi, functionName: "balanceOf", args: [a as Address] }), 18))
