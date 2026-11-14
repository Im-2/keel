// Deploy Keel v2 next to the live v1 contracts: KeelGuardianFactoryV2 (+ its KeelGuardianV2 implementation),
// a new KeelPay and KeelPro. The v1 factory and KeelPay move to `legacy` in shared/deployments/<network>.json, so
// existing guardians and claim links keep working; new guardians and new links use v2.
//   MATSNET_PRIVATE_KEY=… pnpm hardhat run scripts/deploy-keel-v2.ts --network matsnet
// Optional: KEEL_TREASURY (default: the deployer), KEEL_PROTOCOL_SHARE_BPS (default 2000 = 20% of the keeper tip),
// KEEL_PRO_PRICE (MUSD per 30 days, default 5).
import fs from "node:fs"
import path from "node:path"
import { ethers, network } from "hardhat"
import { SHARED_DEPLOYMENTS, readMusdJson } from "./lib/keel"

async function main() {
  const label = network.name === "mainnet" ? "mainnet" : network.name === "matsnet" ? "testnet" : null
  if (!label) throw new Error(`Use --network matsnet or --network mainnet (got ${network.name})`)
  const a = readMusdJson()[label]
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error("No deployer key: set MATSNET_PRIVATE_KEY")
  const from = await deployer.getAddress()
  const treasury = process.env.KEEL_TREASURY || from
  const share = Number(process.env.KEEL_PROTOCOL_SHARE_BPS ?? 2000)
  const proPrice = ethers.parseUnits(process.env.KEEL_PRO_PRICE ?? "5", 18)
  console.log(`Deploying Keel v2 to ${label} from ${from}; treasury ${treasury}, protocol share ${share} bps of the tip`)

  const protocol = {
    borrowerOperations: a.borrowerOperations,
    troveManager: a.troveManager,
    priceFeed: a.priceFeed,
    hintHelpers: a.hintHelpers,
    sortedTroves: a.sortedTroves,
    musd: a.musd,
  }
  const F = await ethers.getContractFactory("KeelGuardianFactoryV2")
  const factory = await F.deploy(protocol, treasury, share)
  await factory.waitForDeployment()
  const factoryAddr = await factory.getAddress()
  const implementation = await factory.implementation()
  console.log("KeelGuardianFactoryV2:", factoryAddr, "tx", factory.deploymentTransaction()?.hash)
  console.log("KeelGuardianV2 impl:  ", implementation)

  const Pay = await ethers.getContractFactory("KeelPay")
  const pay = await Pay.deploy(a.musd)
  await pay.waitForDeployment()
  console.log("KeelPay (v2):         ", await pay.getAddress(), "tx", pay.deploymentTransaction()?.hash)

  const Pro = await ethers.getContractFactory("KeelPro")
  const pro = await Pro.deploy(a.musd, treasury, proPrice)
  await pro.waitForDeployment()
  console.log("KeelPro:              ", await pro.getAddress(), "tx", pro.deploymentTransaction()?.hash)

  const file = path.join(SHARED_DEPLOYMENTS, `${label}.json`)
  const prev = JSON.parse(fs.readFileSync(file, "utf8"))
  const legacy = [...(prev.legacy ?? []), ...(prev.keel ? [{ ...prev.keel, version: prev.keel.version ?? 1 }] : [])]
  const next = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    keel: {
      version: 2,
      guardianFactory: factoryAddr,
      guardianImplementation: implementation,
      pay: await pay.getAddress(),
      pro: await pro.getAddress(),
      treasury,
      protocolShareBps: share,
    },
    legacy,
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n")
  console.log("Wrote", file)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
