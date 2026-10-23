// Proves KeelPay claim links on Mezo testnet with the production code paths:
//  1. create (Mini App plan) -> gasless claim through the bot's relayer to a fresh wallet
//  2. create -> sender cancels -> refund
//  3. create with a short expiry -> after expiry ANYONE can trigger the refund to the sender
// Usage (repo root .env with DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY): pnpm tsx scripts/claimlink-testnet.ts
import { createWalletClient, http, type WalletClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { E18, chainFor, fmtMusd, getDeployment, keelPayAbi, makeClient, musdAbi } from "@keel/shared"
import { buildPlan } from "../../miniapp/src/lib/plan"
import { LiveChain } from "../src/chain"
import { LiveClaimRelayer } from "../src/relayer"
import { loadConfig } from "../src/config"

const dep = getDeployment("testnet")
const pub = makeClient("testnet")
const sender = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
const keeper = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as `0x${string}`)
const signer = createWalletClient({ account: sender, chain: chainFor("testnet"), transport: http() })
const wallet = { chain: signer.chain, writeContract: (r: object) => signer.writeContract({ ...r, account: sender } as never) } as unknown as WalletClient
const ctx = { pub, deployment: dep, account: sender.address }
const config = loadConfig({ ...process.env, NETWORK: "testnet" } as Record<string, string>)
const relayer = new LiveClaimRelayer(new LiveChain(dep), config)
const bal = (a: `0x${string}`) => pub.readContract({ address: dep.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [a] })
const must = (c: unknown, m: string) => { if (!c) throw new Error("FAILED: " + m) }
const tx = (h: string) => `https://explorer.test.mezo.org/tx/${h}`

async function createViaPlan(amount: bigint) {
  const plan = await buildPlan({ id: "x", tg_id: 1, type: "create_claim", params: { amount: amount.toString(), expiryHours: "72" }, status: "pending" }, ctx, {})
  must(!plan.blocked, plan.warnings.join("; "))
  let last = ""
  for (const s of plan.steps) {
    if (last) await new Promise((r) => setTimeout(r, 4000)) // let RPC nodes catch up between dependent steps
    last = await s.run(wallet, ctx)
    must((await pub.waitForTransactionReceipt({ hash: last as `0x${string}` })).status === "success", s.label)
    console.log(`   ${s.label}: ${tx(last)}`)
  }
  return { key: plan.claimKey!, link: privateKeyToAccount(plan.claimKey!).address }
}

console.log("sender", sender.address, "MUSD", fmtMusd(await bal(sender.address)))

const only3 = process.argv.includes("--only-expiry")
if (!only3) {
// 1. create + gasless claim
console.log("\n1) create 2 MUSD link, recipient claims with no gas")
const one = await createViaPlan(2n * E18)
const recipient = privateKeyToAccount(generatePrivateKey()).address
const sig = await privateKeyToAccount(one.key).signTypedData({
  domain: { name: "KeelPay", version: "1", chainId: dep.chainId, verifyingContract: dep.keel!.pay },
  types: { Claim: [{ name: "link", type: "address" }, { name: "to", type: "address" }] },
  primaryType: "Claim",
  message: { link: one.link, to: recipient },
})
const claimTx = await relayer.claim(one.link, recipient, sig)
console.log(`   relayed claim: ${tx(claimTx)}`)
must((await bal(recipient)) === 2n * E18, "recipient got 2 MUSD")
must((await pub.getBalance({ address: recipient })) === 0n, "recipient spent no gas")
console.log(`   recipient ${recipient} now holds ${fmtMusd(await bal(recipient))} and 0 BTC (paid no gas)`)

// 2. create + sender cancel
console.log("\n2) create 1 MUSD link, sender cancels")
const two = await createViaPlan(1n * E18)
const before2 = await bal(sender.address)
const c2 = await signer.writeContract({ address: dep.keel!.pay, abi: keelPayAbi, functionName: "cancel", args: [two.link], gas: 120_000n })
must((await pub.waitForTransactionReceipt({ hash: c2 })).status === "success", "cancel")
must((await bal(sender.address)) - before2 === E18, "refunded 1 MUSD")
console.log(`   cancel: ${tx(c2)} -> 1 MUSD back to sender`)

}
// 3. short-expiry link, refunded by a third party after expiry
console.log("\n3) create 1 MUSD link expiring in 45s, then a stranger triggers the refund")
const link3 = privateKeyToAccount(generatePrivateKey()).address
const gasFor = async (c: object, from = sender) => {
  // same rule as the Mini App: simulate until the node has caught up, then estimate with a margin
  for (let i = 0; ; i++) {
    try { await pub.simulateContract({ ...c, account: from } as never); break } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 2000)) }
  }
  const g = ((await pub.estimateContractGas({ ...c, account: from } as never)) * 13n) / 10n + 5_000n
  return g > 150_000n ? g : 150_000n
}
const approveCall = { address: dep.musd.musd, abi: musdAbi, functionName: "approve", args: [dep.keel!.pay, E18] } as const
const a3 = await signer.writeContract({ ...approveCall, gas: await gasFor(approveCall) })
await pub.waitForTransactionReceipt({ hash: a3 })
await new Promise((r) => setTimeout(r, 4000)) // public RPC nodes lag a few seconds behind each other
const expiry = BigInt(Math.floor(Date.now() / 1000) + 45)
const createCall = { address: dep.keel!.pay, abi: keelPayAbi, functionName: "create", args: [link3, E18, expiry] } as const
const k3 = await signer.writeContract({ ...createCall, gas: await gasFor(createCall) })
must((await pub.waitForTransactionReceipt({ hash: k3 })).status === "success", "create 3")
console.log(`   create: ${tx(k3)}`)
const stranger = createWalletClient({ account: keeper, chain: chainFor("testnet"), transport: http() })
const early = await pub.simulateContract({ address: dep.keel!.pay, abi: keelPayAbi, functionName: "cancel", args: [link3], account: keeper }).then(() => "allowed", (e) => (e as Error).message.match(/NotSender/) ? "NotSender" : "reverted")
console.log(`   stranger cancel before expiry: ${early}`)
must(early !== "allowed", "stranger cannot cancel before expiry")
await new Promise((r) => setTimeout(r, 60_000))
const before3 = await bal(sender.address)
const cancelCall = { address: dep.keel!.pay, abi: keelPayAbi, functionName: "cancel", args: [link3] } as const
const c3 = await stranger.writeContract({ ...cancelCall, gas: await gasFor(cancelCall, keeper) })
must((await pub.waitForTransactionReceipt({ hash: c3 })).status === "success", "expired refund")
must((await bal(sender.address)) - before3 === E18, "refunded to sender")
console.log(`   refund after expiry, sent by a stranger: ${tx(c3)} -> 1 MUSD back to sender`)
console.log("\nALL OK")
