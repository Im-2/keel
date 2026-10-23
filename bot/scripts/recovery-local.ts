// Recovery Mode alert against the real MUSD contracts on the local dev chain (pnpm dev:chain):
// drop the BTC price until the system ratio falls under 150%, run the AlertEngine, print what users would get.
import { execSync } from "node:child_process"
import { E18, fmtIcr, getDeployment } from "@keel/shared"
import { LiveChain } from "../src/chain"
import { Store } from "../src/db"
import { AlertEngine } from "../src/alerts"
import type { Notifier } from "../src/notify"
const DEMO = "0x1b1E98f4912aE9014064a70537025EF338e6aD67"
const chain = new LiveChain(getDeployment("local"))
const store = new Store(":memory:")
store.upsertUser(1, "demo", "Demo")
store.setAddress(1, DEMO)
const out: Array<{ text: string; buttons: string[] }> = []
const notifier: Notifier = { send: async (_id, html, o) => void out.push({ text: html.replace(/<[^>]+>/g, ""), buttons: (o?.buttons ?? []).flat().map((b) => b.text) }) }
const engine = new AlertEngine({ config: { network: "local", miniappUrl: "https://app" }, store, chain, notifier })
const s0 = await chain.system(true)
console.log("start: BTC", Number(s0.price / E18), "TCR", fmtIcr(s0.tcr), "recovery", s0.recoveryMode)
await engine.tick()
// find a price that puts the system under 150% (TCR scales with price)
const target = Number((s0.price * 145n) / ((s0.tcr * 100n) / E18) / E18)
execSync(`npx tsx scripts/set-price.ts ${target}`, { cwd: "../contracts", stdio: "inherit" })
const s1 = await chain.system(true)
console.log("after drop: BTC", Number(s1.price / E18), "TCR", fmtIcr(s1.tcr), "recovery", s1.recoveryMode)
await engine.tick()
console.log(JSON.stringify(out, null, 1))
execSync(`npx tsx scripts/set-price.ts ${Number(s0.price / E18)}`, { cwd: "../contracts", stdio: "inherit" })
await engine.tick()
console.log("restored:", out.at(-1)?.text)
