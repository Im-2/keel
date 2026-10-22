// Move the local BTC price (demo helper):  pnpm set-price 60000
import fs from "node:fs"
import path from "node:path"
import { JsonRpcProvider, Wallet, Contract } from "ethers"

async function main() {
  const usd = Number(process.argv[2] ?? process.env.PRICE)
  if (!usd || usd <= 0) throw new Error("usage: pnpm set-price <usd>")
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/deployments/local.json"), "utf8"))
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, "../.keel-local-keys.json"), "utf8"))
  const provider = new JsonRpcProvider(process.env.LOCAL_RPC ?? "http://127.0.0.1:8545")
  const w = new Wallet(keys.deployerKey, provider)
  const agg = new Contract(dep.mockAggregator, ["function setPrice(uint256) returns (bool)"], w)
  const price = BigInt(Math.round(usd * 1e6)) * 10n ** 12n
  await (await agg.setPrice(price)).wait()
  console.log(`BTC price set to $${usd.toLocaleString()}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
