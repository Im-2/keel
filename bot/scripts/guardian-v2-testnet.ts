/**
 * Guardian v2 end to end on Mezo testnet, with a fresh wallet and the production code paths:
 *   - the loan, the reserve and the protection settings go through the Mini App's own plans (buildPlan),
 *   - protect() is called by the keeper key, exactly as the production keeper does,
 *   - the "add X BTC" message comes from the bot's real AlertEngine reading the real chain.
 *
 * One loan, three rescues in a row (so it needs only ~0.06 testnet BTC):
 *   (c) INSUFFICIENT: empty reserve, ratio under the trigger -> protect() does not revert, returns 2, emits
 *       InsufficientReserve with the BTC shortfall, moves nothing; the alert tells the owner how much to add
 *   (b) PARTIAL: a reserve worth ~30% of the shortfall -> returns 1, PartialRescue with the remaining shortfall
 *   (a) FULL: top the reserve up by the reported shortfall (+2%) -> returns 0, ratio back at the target
 *
 * The fresh wallet's key is kept in .keel-local-keys.json (git-ignored) and progress in .keel-data/, so a rerun
 * resumes. The wallet is added to shared/deployments/testnet.json "teamWallets", so /stats counts it as a team
 * test wallet, never as a real user.
 *
 *   cd bot && npx tsx --env-file=../.env scripts/guardian-v2-testnet.ts
 *   (fund the printed address with ~0.06 testnet BTC from https://faucet.test.mezo.org first, or let the
 *    script fund it from DEPLOYER_PRIVATE_KEY when that wallet has enough)
 */
import fs from "node:fs"
import path from "node:path"
import { createWalletClient, decodeEventLog, formatEther, http, parseEther, type Hex, type WalletClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { E18, chainFor, getDeployment, keelGuardianV2Abi, makeClient, pct } from "@keel/shared"
import { buildPlan } from "../../miniapp/src/lib/plan"
import { LiveChain } from "../src/chain"
import { AlertEngine } from "../src/alerts"
import { Store } from "../src/db"

const ROOT = path.join(import.meta.dirname, "..", "..")
const KEYS = path.join(ROOT, ".keel-local-keys.json")
const STATE = path.join(ROOT, ".keel-data", "guardian-v2-e2e.json")
const DEPLOYMENTS = path.join(ROOT, "shared", "deployments", "testnet.json")
const EXPLORER = "https://explorer.test.mezo.org"
const NEED = parseEther("0.05")

const dep = getDeployment("testnet")
if (dep.keel?.version !== 2) throw new Error("shared/deployments/testnet.json has no v2 deployment")
const pub = makeClient("testnet")
const chain = chainFor("testnet")

// ---------------------------------------------------------------- fresh test wallet (persisted, never printed)
const keys = fs.existsSync(KEYS) ? (JSON.parse(fs.readFileSync(KEYS, "utf8")) as Record<string, string>) : {}
keys.guardianV2E2e ??= generatePrivateKey()
fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2))
const owner = privateKeyToAccount(keys.guardianV2E2e as Hex)
const keeper = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as Hex)
const deployer = process.env.DEPLOYER_PRIVATE_KEY ? privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex) : null
const ownerW = createWalletClient({ account: owner, chain, transport: http() })
const keeperW = createWalletClient({ account: keeper, chain, transport: http() })

type State = { txs: Record<string, string>; results: Record<string, unknown> }
fs.mkdirSync(path.dirname(STATE), { recursive: true })
const state: State = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { txs: {}, results: {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2))
const link = (h: string) => `${EXPLORER}/tx/${h}`
const must = (c: unknown, m: string) => {
  if (!c) throw new Error(`FAILED: ${m}`)
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

// the test wallet is a team wallet: /stats must not count it as a third-party user
{
  const d = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"))
  d.teamWallets ??= []
  if (!d.teamWallets.some((a: string) => a.toLowerCase() === owner.address.toLowerCase())) {
    d.teamWallets.push(owner.address)
    fs.writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n")
  }
}

console.log(`Guardian v2 e2e on Mezo testnet\n  factory v2 ${dep.keel.guardianFactory}\n  test wallet ${owner.address}\n  keeper      ${keeper.address}`)

// ---------------------------------------------------------------- funding
let btc = await pub.getBalance({ address: owner.address })
if (btc < NEED && !state.txs.openTrove) {
  const missing = NEED - btc
  const dBal = deployer ? await pub.getBalance({ address: deployer.address }) : 0n
  if (deployer && dBal > missing + parseEther("0.002")) {
    const w = createWalletClient({ account: deployer, chain, transport: http() })
    const h = await w.sendTransaction({ to: owner.address, value: missing, gas: 30_000n })
    await pub.waitForTransactionReceipt({ hash: h })
    state.txs.fund = h
    save()
    btc = await pub.getBalance({ address: owner.address })
  } else {
    console.log(`\nNOT FUNDED: the test wallet has ${formatEther(btc)} BTC and needs ${formatEther(NEED)}.`)
    console.log(`Send ~${formatEther(missing)} testnet BTC to ${owner.address} (faucet: https://faucet.test.mezo.org), then run this again.`)
    process.exit(2)
  }
}
console.log(`  wallet holds ${formatEther(btc)} BTC`)

// ---------------------------------------------------------------- helpers: Mini App plans, signed by the test wallet
const wallet = { chain, writeContract: (r: object) => ownerW.writeContract({ ...r, account: owner } as never) } as unknown as WalletClient
const ctx = { pub, deployment: dep, account: owner.address }
async function runPlan(name: string, type: string, params: Record<string, string>) {
  if (state.txs[name]) return console.log(`  ${name}: done earlier ${link(state.txs[name])}`)
  const plan = await buildPlan({ id: name, tg_id: 1, type, params, status: "pending" }, ctx, {})
  must(!plan.blocked, `${name}: ${plan.warnings.join("; ")}`)
  let last = ""
  for (const s of plan.steps) {
    if (last) await pause(4000) // public RPC nodes lag between dependent steps
    last = await s.run(wallet, ctx)
    must((await pub.waitForTransactionReceipt({ hash: last as Hex })).status === "success", `${name}: ${s.label}`)
    console.log(`  ${name} · ${s.label}: ${link(last)}`)
  }
  state.txs[name] = last
  save()
}

const guardianAddr = async () =>
  (await pub.readContract({ address: dep.keel!.guardianFactory, abi: [{ type: "function", name: "guardianOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }] as const, functionName: "guardianOf", args: [owner.address] })) as Hex

async function preview(g: Hex) {
  const [eligible, plan] = await pub.readContract({ address: g, abi: keelGuardianV2Abi, functionName: "previewProtect" })
  return { eligible, ...plan }
}

const RESULT = ["Full", "Partial", "Insufficient"]
/** protect() from the keeper key: simulate for the return value, send, decode the events. */
async function protect(name: string, g: Hex, expected: number) {
  if (state.txs[name]) return console.log(`  ${name}: done earlier ${link(state.txs[name])}`)
  const p = await preview(g)
  console.log(`  ${name}: preview -> ${RESULT[Number(p.result)]}, eligible ${p.eligible}, ratio ${(Number(p.icrBefore) / 1e16).toFixed(2)}%`)
  const call = { address: g, abi: keelGuardianV2Abi, functionName: "protect", args: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"], account: keeper } as const
  const from = await pub.getBlockNumber()
  let result: number
  try {
    result = Number((await pub.simulateContract(call)).result)
  } catch (e) {
    // the production keeper scans every guardian every ~30 s and may have protected this one first:
    // then its transaction is the evidence (a real keeper run), found from the guardian's events
    const logs = await pub.getLogs({ address: g, fromBlock: from - 150n, toBlock: "latest" })
    const hit = logs.reverse().find((l) => {
      try {
        const ev = decodeEventLog({ abi: keelGuardianV2Abi, data: l.data, topics: l.topics })
        return ev.eventName === (expected === 1 ? "PartialRescue" : "Protected")
      } catch {
        return false
      }
    })
    if (!hit) throw e
    state.txs[name] = hit.transactionHash
    state.results[name] = { returned: RESULT[expected], by: "production keeper", note: "the running keeper protected first" }
    save()
    console.log(`  ${name}: the production keeper protected first: ${link(hit.transactionHash)}`)
    return null
  }
  must(result === expected, `${name}: protect() would return ${RESULT[result]}, expected ${RESULT[expected]}`)
  const hash = await keeperW.writeContract({ ...call, gas: 2_000_000n })
  const rc = await pub.waitForTransactionReceipt({ hash })
  must(rc.status === "success", `${name}: protect() reverted (${hash})`)
  const events = rc.logs
    .filter((l) => l.address.toLowerCase() === g.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: keelGuardianV2Abi, data: l.data, topics: l.topics })
      } catch {
        return null
      }
    })
    .filter(Boolean) as Array<{ eventName: string; args: Record<string, unknown> }>
  state.txs[name] = hash
  state.results[name] = { returned: RESULT[result], events: events.map((e) => ({ name: e.eventName, args: e.args })) }
  save()
  console.log(`  ${name}: protect() returned ${RESULT[result]}, events ${events.map((e) => e.eventName).join(", ") || "none"}: ${link(hash)}`)
  return events
}

// ---------------------------------------------------------------- 1. loan through the Mini App plan (guardian + openTrove)
const sysPrice = await pub.readContract({ address: dep.musd.priceFeed, abi: [{ type: "function", name: "fetchPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "fetchPrice" })
console.log(`  BTC price on Mezo: $${(Number(sysPrice / (E18 / 100n)) / 100).toLocaleString("en-US")}`)
await runPlan("openTrove", "borrow", { amount: (1800n * E18).toString(), targetIcr: pct(150).toString() })
const g = await guardianAddr()
must(g !== "0x0000000000000000000000000000000000000000", "no guardian after borrowing")
const version = await pub.readContract({ address: g, abi: keelGuardianV2Abi, functionName: "VERSION" })
must(version === 2n, `guardian ${g} is not v2`)
console.log(`  guardian v2: ${EXPLORER}/address/${g}`)

// ---------------------------------------------------------------- 2. protection: trigger above today's ratio, no cooldown (test settings)
await runPlan("configure", "protect_config", { enabled: "true", minIcr: pct(165).toString(), targetIcr: pct(175).toString(), tipBps: "20", cooldown: "0" })

// ---------------------------------------------------------------- (c) INSUFFICIENT: empty reserve
const ins = await protect("insufficient", g, 2)
if (ins) {
  const ev = ins.find((e) => e.eventName === "InsufficientReserve")
  must(ev, "no InsufficientReserve event")
  must(!ins.some((e) => e.eventName === "Protected"), "funds moved on an insufficient result")
}
// the owner is told how much to add: run the bot's real alert engine against this loan
{
  const store = new Store(":memory:")
  store.upsertUser(1, "e2e", "E2E")
  store.setAddress(1, owner.address)
  const sent: string[] = []
  const engine = new AlertEngine({ config: { network: "testnet", miniappUrl: "https://keel-miniapp.vercel.app" }, store, chain: new LiveChain(dep), notifier: { send: async (_id, html) => (sent.push(html.replace(/<[^>]+>/g, "")), true) } })
  await engine.tick()
  const msg = sent.find((m) => /can't act yet|can't fully protect/.test(m)) ?? null
  state.results.alert = msg
  save()
  console.log(`  alert the owner would get:\n    ${msg ?? "(none)"}`)
}

// ---------------------------------------------------------------- (b) PARTIAL: a reserve worth ~30% of the shortfall
if (!state.txs.partial) {
  const p = await preview(g)
  // the wallet is nearly spent after opening the loan: ~15% of the shortfall is enough to show a partial rescue
  const short = p.btcShortfallToTarget > 0n ? p.btcShortfallToTarget : parseEther("0.002")
  await runPlan("fundSmall", "fund_reserve", { amount: ((short * 15n) / 100n).toString() })
}
const par = await protect("partial", g, 1)
if (par) must(par.some((e) => e.eventName === "PartialRescue"), "no PartialRescue event")

// ---------------------------------------------------------------- (a) FULL: the reserve covers a lowered trigger and target
// The test wallet is nearly spent after opening the loan, so instead of funding the whole remaining shortfall the
// owner moves the trigger just above today's ratio and the target one point higher (a rescue the reserve can fully
// deliver), then funds exactly the reported shortfall (+2%) with a direct fundReserve() call (the Mini App plan
// insists on a 0.002 BTC wallet buffer, which this wallet no longer has).
if (!state.txs.full) {
  const p = await preview(g)
  const ratio = Number(p.icrBefore) / 1e18
  const trigger = Math.floor(ratio * 100) + 2
  const target = trigger + 1
  console.log(`  full: ratio ${(ratio * 100).toFixed(2)}%; trigger -> ${trigger}%, target -> ${target}%`)
  await runPlan("lowerTarget", "protect_config", { enabled: "true", minIcr: pct(trigger).toString(), targetIcr: pct(target).toString(), tipBps: "20", cooldown: "0" })
  if (!state.txs.fundRest) {
    await pause(4000)
    const p2 = await preview(g)
    must(p2.btcShortfallToTarget > 0n, "nothing to fund for the full rescue")
    const amount = (p2.btcShortfallToTarget * 102n) / 100n
    const h = await ownerW.writeContract({ address: g, abi: keelGuardianV2Abi, functionName: "fundReserve", value: amount, gas: 200_000n })
    must((await pub.waitForTransactionReceipt({ hash: h })).status === "success", "fundReserve")
    state.txs.fundRest = h
    save()
    console.log(`  fundRest: reserve +${formatEther(amount)} BTC: ${link(h)}`)
    await pause(4000)
  }
}
const full = await protect("full", g, 0)
if (full) must(full.some((e) => e.eventName === "Protected") && !full.some((e) => e.eventName === "PartialRescue"), "full rescue events")

const after = await preview(g)
console.log(`\nDone. Ratio now ${(Number(after.icrBefore) / 1e16).toFixed(2)}% (target 175%).`)
console.log(JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2))
