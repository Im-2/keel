// Local development chain: the REAL MUSD protocol + Keel, seeded with a realistic trove list.
//   pnpm dev:chain          (leave running; JSON-RPC on http://127.0.0.1:8545, chain id 31612)
// Writes shared/deployments/local.json (addresses) and contracts/.keel-local-keys.json (demo keys, gitignored).
import hre, { deployments, ethers, helpers } from "hardhat"
import fs from "node:fs"
import path from "node:path"
import { JsonRpcServer } from "hardhat/internal/hardhat-network/jsonrpc/server"
import { deployKeel, writeDeployment } from "./lib/keel"

const ZERO = ethers.ZeroAddress
const E18 = 10n ** 18n

async function main() {
  await deployments.fixture()
  const addr = async (n: string) => (await deployments.get(n)).address
  const musdAddrs = {
    musd: await addr("MUSDTester"),
    borrowerOperations: await addr("BorrowerOperations"),
    borrowerOperationsSignatures: await addr("BorrowerOperationsSignatures"),
    troveManager: await addr("TroveManagerTester"),
    sortedTroves: await addr("SortedTroves"),
    hintHelpers: await addr("HintHelpers"),
    priceFeed: await addr("PriceFeed"),
    interestRateManager: await addr("InterestRateManager"),
    stabilityPool: await addr("StabilityPool"),
  }
  const mockAggregator = await addr("MockAggregator")

  const keel = await deployKeel(musdAddrs)
  const signers = await helpers.signers.getUnnamedSigners()

  const bo = await ethers.getContractAt("BorrowerOperations", musdAddrs.borrowerOperations)
  const pf = await ethers.getContractAt("PriceFeed", musdAddrs.priceFeed)
  const price: bigint = await pf.fetchPrice()

  // Background troves so the redemption queue and TCR look like a real system.
  // Healthiest first, so system TCR never dips below the 150% critical line while seeding.
  const seed: Array<[number, bigint, number]> = [
    [8, 5_000n, 4.0], [7, 120_000n, 3.0], [6, 30_000n, 2.5], [5, 15_000n, 2.1],
    [4, 60_000n, 1.8], [3, 25_000n, 1.55], [2, 40_000n, 1.35], [1, 9_000n, 1.25],
  ]
  for (const [i, debt, icr] of seed) {
    const amount = debt * E18
    const fee: bigint = await bo.getBorrowingFee(amount)
    const total = amount + fee + 200n * E18
    const coll = (BigInt(Math.round(icr * 1e6)) * 10n ** 12n * total) / price
    await bo.connect(signers[i]).openTrove(amount, ZERO, ZERO, { value: coll })
  }

  // Demo user (signer 0): a Guardian-owned trove at 180% with a BTC reserve.
  const gf = await ethers.getContractAt("KeelGuardianFactory", keel.guardianFactory)
  await gf.connect(signers[0]).createGuardian()
  const g = await ethers.getContractAt("KeelGuardian", await gf.guardianOf(signers[0].address), signers[0])
  const demoDebt = 12_000n * E18
  const fee: bigint = await bo.getBorrowingFee(demoDebt)
  const total = demoDebt + fee + 200n * E18
  const coll = (18n * 10n ** 17n * total) / price
  await g.openTrove(demoDebt, ZERO, ZERO, ZERO, { value: coll })
  await g.fundReserve({ value: coll / 4n })

  const accounts = (hre.config.networks.hardhat.accounts as Array<{ privateKey: string }>).map((a, i) => ({
    index: i,
    address: signers[i]?.address,
    privateKey: a.privateKey,
  }))
  const file = writeDeployment("local", { chainId: 31612, musd: musdAddrs, keel, mockAggregator })
  fs.writeFileSync(
    path.join(__dirname, "../.keel-local-keys.json"),
    JSON.stringify({ deployerKey: accounts[0]?.privateKey, accounts }, null, 2),
  )
  console.log("Local Keel chain ready. Wrote", file)
  console.log("Demo user (signer 0):", signers[0].address, " guardian:", await g.getAddress())

  const server = new JsonRpcServer({ hostname: "127.0.0.1", port: 8545, provider: hre.network.provider })
  const { address, port } = await server.listen()
  console.log(`JSON-RPC listening on http://${address}:${port} (chain id 31612)`)
  await server.waitUntilClosed()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
