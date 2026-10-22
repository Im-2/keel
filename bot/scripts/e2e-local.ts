// End-to-end check against `pnpm dev:chain`: the Mini App's transaction plans, the keeper and claim relay, on a real MUSD stack.
//   cd contracts && KEEL_SOLCJS=1 pnpm dev:chain      (terminal 1)
//   cd bot && pnpm tsx scripts/e2e-local.ts           (terminal 2)
import { execSync } from "node:child_process"
import { createWalletClient, http, type Hex, type WalletClient } from "viem"
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFor, findGuardian, fmtIcr, fmtMusd, getDeployment, keelPayAbi, musdAbi, pct, readGuardian, readSystem, readTrove, E18 } from "@keel/shared"
import { loadConfig } from "../src/config"
import { LiveChain } from "../src/chain"
import { Keeper, LiveKeeperBackend } from "../src/keeper"
import { LiveClaimRelayer } from "../src/relayer"
import { Store } from "../src/db"
import { buildPlan } from "../../miniapp/src/lib/plan"
import type { IntentDto } from "../../miniapp/src/lib/api"

const MNEMONIC = "test test test test test test test test test test test junk"
const user = mnemonicToAccount(MNEMONIC, { addressIndex: 15 })
const keeperAcct = mnemonicToAccount(MNEMONIC, { addressIndex: 18 })
const friend = mnemonicToAccount(MNEMONIC, { addressIndex: 17 })
const keeperKey = `0x${Buffer.from(keeperAcct.getHdKey().privateKey!).toString("hex")}` as Hex

const config = loadConfig({ NETWORK: "local", BOT_TOKEN: "1:x", KEEPER_PRIVATE_KEY: keeperKey })
const dep = getDeployment("local")
const chain = new LiveChain(dep, config.rpcUrl)
const pub = chain.client
const signer = createWalletClient({ account: user, chain: chainFor("local"), transport: http() })
// plans pass the address as `account` (browser wallets sign remotely); here sign locally with the mnemonic key
const wallet = { chain: signer.chain, writeContract: (req: object) => signer.writeContract({ ...req, account: user } as never) } as unknown as WalletClient
const ctx = { pub, deployment: dep, account: user.address }
const must = (c: unknown, m: string) => { if (!c) throw new Error("FAILED: " + m) }
let n = 0

async function run(type: string, params: Record<string, string>, amount?: string) {
  const intent = { id: String(++n), tg_id: 1, type, params, status: "pending" } as IntentDto
  const plan = await buildPlan(intent, ctx, { amount })
  must(!plan.blocked, `${type} blocked: ${plan.warnings.join("; ")}`)
  console.log(`\n== ${plan.title}`)
  for (const [k, v] of plan.rows) console.log(`   ${k}: ${v}`)
  for (const s of plan.steps) {
    const hash = await s.run(wallet, ctx)
    const rc = await pub.waitForTransactionReceipt({ hash })
    must(rc.status === "success", `${s.label} reverted`)
    console.log(`   ✓ ${s.label}`)
  }
  return plan
}

for (const a of [user.address, keeperAcct.address]) {
  await pub.transport.request({ method: "hardhat_setBalance", params: [a, "0x" + (10n * E18).toString(16)] } as never)
}
const sys0 = await readSystem(pub, dep.musd)
console.log("BTC price", sys0.price / E18)
await run("borrow", { amount: (5000n * E18).toString(), targetIcr: pct(250).toString() })
const g = (await findGuardian(pub, dep.keel!, user.address))!
must(g, "guardian created")
let t = await readTrove(pub, dep.musd, g)
must(t.active && t.icr >= pct(249), `trove open at ~250%, got ${fmtIcr(t.icr)}`)
const bal = await pub.readContract({ address: dep.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [user.address] })
must(bal === 5000n * E18, `received 5000 MUSD, got ${fmtMusd(bal)}`)

await run("add_collateral", {}, "0.01")
await run("repay", {}, "500")
await run("fund_reserve", {}, "0.2")
await run("protect_config", { enabled: "true", minIcr: pct(180).toString(), targetIcr: pct(220).toString(), tipBps: "20", cooldown: "0" })
await run("send", { to: friend.address, amount: (25n * E18).toString(), label: "friend" })

// claim link: create (plan), then relay with the ephemeral key
const claimPlan = await run("create_claim", { amount: (100n * E18).toString(), expiryHours: "72" })
const linkKey = claimPlan.claimKey!
const link = privateKeyToAccount(linkKey)
const store = new Store(":memory:")
const relayer = new LiveClaimRelayer(chain, config)
const sig = await link.signTypedData({
  domain: { name: "KeelPay", version: "1", chainId: dep.chainId, verifyingContract: dep.keel!.pay },
  types: { Claim: [{ name: "link", type: "address" }, { name: "to", type: "address" }] },
  primaryType: "Claim",
  message: { link: link.address, to: friend.address },
})
const before = await pub.readContract({ address: dep.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [friend.address] })
await relayer.claim(link.address, friend.address, sig)
const after = await pub.readContract({ address: dep.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [friend.address] })
must(after - before === 100n * E18, "friend received the claimed 100 MUSD")
console.log("\n✓ claim relayed")
void keelPayAbi

// price drop -> keeper protects
t = await readTrove(pub, dep.musd, g)
const drop = Number((t.price * pct(150)) / t.icr / E18) // price at which ICR = 150%
console.log(`\nICR ${fmtIcr(t.icr)}; dropping BTC to $${drop.toFixed(0)}`)
execSync(`npx tsx scripts/set-price.ts ${drop.toFixed(0)}`, { cwd: "../contracts", stdio: "inherit" })
const keeper = new Keeper(new LiveKeeperBackend(chain, config), store)
const done = await keeper.tick()
t = await readTrove(pub, dep.musd, g, (await readSystem(pub, dep.musd)).price)
const gs = await readGuardian(pub, g)
console.log(`keeper protected ${done.length} guardian(s); ICR now ${fmtIcr(t.icr)}; reserve ${gs.reserveBTC}`)
must(done.includes(g), "keeper protected our guardian")
must(t.icr >= pct(215), "ratio restored towards target")
execSync(`npx tsx scripts/set-price.ts ${Number(sys0.price / E18)}`, { cwd: "../contracts", stdio: "inherit" })
console.log("\nALL OK")
