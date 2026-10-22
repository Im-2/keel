import { ethers } from "hardhat"
import fs from "node:fs"
import path from "node:path"

export const SHARED_DEPLOYMENTS = path.join(__dirname, "../../../shared/deployments")

export interface MusdAddrs {
  musd: string
  borrowerOperations: string
  troveManager: string
  sortedTroves: string
  hintHelpers: string
  priceFeed: string
  [k: string]: string
}

/** Deploy KeelGuardianFactory + KeelPay against an existing MUSD deployment. */
export async function deployKeel(a: MusdAddrs) {
  const Factory = await ethers.getContractFactory("KeelGuardianFactory")
  const factory = await Factory.deploy({
    borrowerOperations: a.borrowerOperations,
    troveManager: a.troveManager,
    priceFeed: a.priceFeed,
    hintHelpers: a.hintHelpers,
    sortedTroves: a.sortedTroves,
    musd: a.musd,
  })
  await factory.waitForDeployment()
  const Pay = await ethers.getContractFactory("KeelPay")
  const pay = await Pay.deploy(a.musd)
  await pay.waitForDeployment()
  return { guardianFactory: await factory.getAddress(), pay: await pay.getAddress() }
}

export function writeDeployment(network: "testnet" | "mainnet" | "local", data: Record<string, unknown>) {
  const file = path.join(SHARED_DEPLOYMENTS, `${network}.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  return file
}

export function readMusdJson(): Record<string, MusdAddrs> {
  return JSON.parse(fs.readFileSync(path.join(SHARED_DEPLOYMENTS, "musd.json"), "utf8"))
}
