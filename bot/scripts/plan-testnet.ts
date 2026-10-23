// Runs Mini App transaction plans (the exact code the Mini App signs) on Mezo testnet from the demo wallet.
// Usage: pnpm tsx scripts/plan-testnet.ts add_collateral 0.0002 | send 1 <0xaddress>
import { createWalletClient, http, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { chainFor, getDeployment, makeClient, parseUnits18 } from "@keel/shared"
import { buildPlan } from "../../miniapp/src/lib/plan"

const [type, amount, to] = process.argv.slice(2)
const dep = getDeployment("testnet")
const pub = makeClient("testnet")
const acct = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
const signer = createWalletClient({ account: acct, chain: chainFor("testnet"), transport: http() })
const wallet = { chain: signer.chain, writeContract: (r: object) => signer.writeContract({ ...r, account: acct } as never) } as unknown as WalletClient
const ctx = { pub, deployment: dep, account: acct.address }
const params: Record<string, string> = type === "send" ? { to, amount: parseUnits18(amount).toString(), label: to.slice(0, 8) } : {}
const plan = await buildPlan({ id: "x", tg_id: 1, type, params, status: "pending" }, ctx, type === "send" ? {} : { amount })
console.log(`== ${plan.title}${plan.blocked ? " (BLOCKED)" : ""}`)
for (const [k, v] of plan.rows) console.log(`   ${k}: ${v}`)
for (const w of plan.warnings) console.log(`   ! ${w}`)
if (plan.blocked) process.exit(1)
for (const s of plan.steps) {
  const h = await s.run(wallet, ctx)
  const rc = await pub.waitForTransactionReceipt({ hash: h })
  console.log(`   ${s.label}: ${rc.status} https://explorer.test.mezo.org/tx/${h}`)
  if (rc.status !== "success") process.exit(1)
}
