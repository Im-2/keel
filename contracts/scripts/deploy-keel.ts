// Deploy Keel against the live MUSD deployment on Mezo.
//   pnpm hardhat run scripts/deploy-keel.ts --network matsnet     (Mezo testnet)
//   pnpm hardhat run scripts/deploy-keel.ts --network mainnet
import { ethers, network } from "hardhat"
import { deployKeel, readMusdJson, writeDeployment } from "./lib/keel"

async function main() {
  const label = network.name === "mainnet" ? "mainnet" : network.name === "matsnet" ? "testnet" : null
  if (!label) throw new Error(`Use --network matsnet or --network mainnet (got ${network.name})`)
  const musd = readMusdJson()[label]
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error("No deployer key: set MATSNET_PRIVATE_KEY / MAINNET_PRIVATE_KEY in contracts/.env")
  console.log(`Deploying Keel to ${label} from ${await deployer.getAddress()} ...`)
  const keel = await deployKeel(musd)
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const file = writeDeployment(label, { chainId, keel })
  console.log("KeelGuardianFactory:", keel.guardianFactory)
  console.log("KeelPay:            ", keel.pay)
  console.log("Wrote", file)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
