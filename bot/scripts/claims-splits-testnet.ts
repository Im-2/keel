/**
 * Claim links and bill splits end to end on Mezo testnet, with real wallets, the real relayer and the real block
 * watcher. A = the deployer wallet (has MUSD), B and C = fresh funded wallets, D = a Telegram user with no wallet
 * (links one mid-test), E = a participant Telegram can't reach. A recording notifier and Telegram stand in for the
 * bot; the database is in memory. Production data is never touched.
 *
 *   tsx scripts/claims-splits-testnet.ts   (reads DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY and the bot config from ../.env)
 */
import { createWalletClient, erc20Abi, http, parseEther, type Address, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFor, claimLink, explorerTx, keelPayAbi, keyToParam, parseStartParam, paramToKey } from "@keel/shared"
import { loadConfig } from "../src/config"
import { Store } from "../src/db"
import { LiveChain } from "../src/chain"
import { createApi } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus } from "../src/live"
import { BlockWatcher } from "../src/watcher"
import { Splits } from "../src/splits"
import { LiveClaimRelayer } from "../src/relayer"
import type { Notifier, NotifyOpts } from "../src/notify"
import { signInitData } from "../src/telegram-auth"

const config = { ...loadConfig(), dbPath: ":memory:", miniappShortName: "app" }
if (config.network !== "testnet") throw new Error("testnet only")
const store = new Store(":memory:")
const chain = new LiveChain(config.deployment, config.rpcUrl)
const sent: Array<{ to: number; text: string }> = []
const unreachable = new Set<number>()
const notifier: Notifier = {
  async send(to: number, text: string, _o?: NotifyOpts) {
    if (unreachable.has(to)) return false
    sent.push({ to, text })
    return true
  },
}
const live = new LiveBus()
const splits = new Splits({ config, store, notifier, live })
const cards = new Map<number, string>()
splits.attach({ post: async (_c, html) => (cards.set(cards.size + 1, html), cards.size), edit: async (_c, mid, html) => void cards.set(mid, html) })
const completion = createCompletion({ config, store, chain, notifier, live, splits })
const watcher = new BlockWatcher({ config, store, chain, notifier, live, completion, splits })
const history = new History({ config, store, chain })
const relayer = new LiveClaimRelayer(chain, config)
const app = createApi({ config: { ...config, adminIds: [1] }, store, chain, notifier, live, completion, history, splits, relayer })

const A = 2001, B = 2002, C = 2003, D = 2004, E = 2005
const aKey = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const bKey = privateKeyToAccount(generatePrivateKey())
const cKey = privateKeyToAccount(generatePrivateKey())
const dKey = privateKeyToAccount(generatePrivateKey())
store.upsertUser(A, "alice_kt", "Alice"); store.setAddress(A, aKey.address)
store.upsertUser(B, "bob_kt", "Bob"); store.setAddress(B, bKey.address)
store.upsertUser(C, "chidi_kt", "Chidi"); store.setAddress(C, cKey.address)
store.upsertUser(D, "dan_kt", "Dan") // no wallet yet
store.upsertUser(E, "eve_kt", "Eve") // started once, then blocked the bot

const names: Record<number, string> = { [A]: "alice_kt", [B]: "bob_kt", [C]: "chidi_kt", [D]: "dan_kt", [E]: "eve_kt" }
const call = async (id: number, method: string, path: string, body?: unknown) => {
  const init = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: names[id] }) }, config.botToken)
  const r = await app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}
const pub = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}
const chainDef = chainFor("testnet")
const wallet = (key: typeof aKey) => createWalletClient({ account: key, chain: chainDef, transport: http(config.rpcUrl) })
const musd = config.deployment.musd.musd
const pay = config.deployment.keel!.pay
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`)
  if (!ok) failures++
}
async function mined(hash: Hex) {
  for (let i = 0; i < 90; i++) {
    const r = await chain.receipt(hash, 1)
    if (r) {
      if (!r.ok) throw new Error(`reverted: ${hash}`)
      return r
    }
    await sleep(2000)
  }
  throw new Error(`not mined: ${hash}`)
}
async function until(what: string, cond: () => boolean, ms = 150_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await watcher.tick().catch((e) => console.log("    watcher:", (e as Error).message.split("\n")[0]))
    if (cond()) return true
    await sleep(4000)
  }
  console.log(`    timed out waiting for: ${what}`)
  return false
}
// public nodes lag each other: retry a send the way a wallet would
async function write(key: typeof aKey, req: Parameters<ReturnType<typeof wallet>["writeContract"]>[0]): Promise<Hex> {
  for (let i = 0; ; i++) {
    try {
      // explicit gas: a lagging node can estimate below Mezo's EIP-7623 floor (the Mini App's write() pads the same way)
      const h = await wallet(key).writeContract({ ...(req as object), gas: 300_000n } as never)
      await mined(h)
      return h
    } catch (e) {
      if (i >= 4 || !/nonce|underpriced|already known|floor/i.test((e as Error).message)) throw e
      await sleep(3000)
    }
  }
}
const transfer = (key: typeof aKey, to: Address, amount: bigint) => write(key, { address: musd, abi: erc20Abi, functionName: "transfer", args: [to, amount] } as never)
const balance = (a: Address) => chain.musdBalance(a)

console.log(`A ${aKey.address}\nB ${bKey.address}\nC ${cKey.address}\nD ${dKey.address} (links mid-test)\n`)
await watcher.tick()

console.log("0. gas for B, C, D; a little MUSD for B and C")
for (const k of [bKey, cKey, dKey]) await mined(await wallet(aKey).sendTransaction({ to: k.address, value: parseEther("0.0002"), gas: 30_000n }))
await transfer(aKey, bKey.address, parseEther("4"))
await transfer(aKey, cKey.address, parseEther("4"))

console.log("1. Claim link: A escrows 3 MUSD; the link fits Telegram; B claims it gaslessly")
let linkAddr: Address
{
  const key = generatePrivateKey()
  const link = privateKeyToAccount(key)
  linkAddr = link.address
  const url = claimLink(config.botUsername, "app", key)
  const param = url.split("startapp=")[1]
  check(param.length <= 64 && parseStartParam(param).kind === "claim" && paramToKey(param.slice(6)) === key, `link fits Telegram's 64-char limit (${param.length}) and decodes back to the key: ${url.slice(0, 48)}…`)
  await write(aKey, { address: musd, abi: erc20Abi, functionName: "approve", args: [pay, parseEther("3")] } as never)
  const created = await write(aKey, { address: pay, abi: keelPayAbi, functionName: "create", args: [link.address, parseEther("3"), BigInt(Math.floor(Date.now() / 1000) + 72 * 3600)] } as never)
  await until("the watcher to see LinkCreated", () => store.linkOwner(link.address) !== null)
  const info = await pub("GET", `/api/claim/${link.address}`)
  check(info.body.status === "open" && info.body.senderName === "@alice_kt" && info.body.amount === parseEther("3").toString(), `claim screen data: @alice_kt sent you 3 MUSD, open ${explorerTx("testnet", created)}`)
  const before = await balance(bKey.address)
  const signature = await link.signTypedData({
    domain: { name: "KeelPay", version: "1", chainId: config.deployment.chainId, verifyingContract: pay },
    types: { Claim: [{ name: "link", type: "address" }, { name: "to", type: "address" }] },
    primaryType: "Claim",
    message: { link: link.address, to: bKey.address },
  })
  // destination-bound: the same signature can't send the money anywhere else
  const hijack = await pub("POST", "/api/claim/relay", { link: link.address, to: cKey.address, signature })
  check(hijack.status === 400 && /not valid/.test(hijack.body.error), "a signature for B can't be redirected to C (destination-bound)")
  const r = await pub("POST", "/api/claim/relay", { link: link.address, to: bKey.address, signature })
  check(r.status === 200 && !!r.body.txHash, `relayer submitted the claim ${explorerTx("testnet", r.body.txHash)}`)
  const after = await balance(bKey.address)
  check(after - before === parseEther("3"), "B received exactly 3 MUSD and paid no gas")
  check(sent.filter((m) => m.to === A && m.text.includes("was claimed by <b>@bob_kt</b>")).length === 1, "A told once: your claim link was claimed by @bob_kt")
  await until("the watcher to record the claim", () => store.eventsFor(aKey.address).some((e) => e.kind === "link_claimed"))
  check(sent.filter((m) => m.to === A && m.text.includes("was claimed")).length === 1, "the watcher saw the claim too and didn't repeat the notice")
  const again = await pub("POST", "/api/claim/relay", { link: link.address, to: bKey.address, signature })
  check(again.body.code === "settled", `claiming twice: "${again.body.error}"`)
  const info2 = await pub("GET", `/api/claim/${link.address}`)
  check(info2.body.status === "claimed" && info2.body.claimedBy === "@bob_kt", "claim screen now says: already claimed by @bob_kt")
}

console.log("2. A cancels a second link and gets the money back")
{
  const link = privateKeyToAccount(generatePrivateKey())
  await write(aKey, { address: musd, abi: erc20Abi, functionName: "approve", args: [pay, parseEther("1")] } as never)
  await write(aKey, { address: pay, abi: keelPayAbi, functionName: "create", args: [link.address, parseEther("1"), BigInt(Math.floor(Date.now() / 1000) + 3600)] } as never)
  await until("LinkCreated", () => store.linkOwner(link.address) !== null)
  const i = await call(A, "POST", "/api/intent", { type: "cancel_claim", link: link.address })
  check(i.status === 200 && i.body.params.amount === parseEther("1").toString(), "Activity's Cancel & refund creates a cancel intent for A's own link")
  const notMine = await call(B, "POST", "/api/intent", { type: "cancel_claim", link: link.address })
  check(notMine.status === 404, "B can't cancel A's link")
  const hash = await write(aKey, { address: pay, abi: keelPayAbi, functionName: "cancel", args: [link.address] } as never)
  await call(A, "POST", `/api/intent/${i.body.id}/complete`, { status: "done", txHash: hash })
  await until("LinkCancelled", () => store.eventsFor(aKey.address).some((e) => e.kind === "link_cancelled"))
  check((await pub("GET", `/api/claim/${link.address}`)).body.status === "cancelled", "the link now reads: cancelled")
}

console.log("3. 3-person split: A + B + C share 10 MUSD; B pays in Keel, C from a wallet app")
{
  const r = await call(A, "POST", "/api/splits", { total: parseEther("10").toString(), title: "Dinner", people: [{ raw: "@BOB_KT" }, { raw: "chidi_kt" }], includeMe: true })
  check(r.status === 200, `split created: ${r.body.id}`)
  const id = r.body.id as string
  const view = (await call(A, "GET", `/api/split/${id}`)).body
  check(view.mine === parseEther("3.34").toString() && view.shares.every((s: { amount: string }) => s.amount === parseEther("3.33").toString()), "shares 3.34 (A) + 3.33 + 3.33 = 10.00 exactly")
  check(sent.some((m) => m.to === B && m.text.includes("Your share: <b>3.33 MUSD</b>")) && sent.some((m) => m.to === C), "B and C were each asked in Telegram")
  check((await call(A, "POST", `/api/split/${id}/pay`, {})).body.code === "own", "A paying their own split: friendly refusal")
  const intent = (await call(B, "POST", `/api/split/${id}/pay`, {})).body
  const bTx = await transfer(bKey, aKey.address, BigInt(intent.params.amount))
  for (let k = 0; k < 6; k++) {
    if ((await call(B, "POST", `/api/intent/${intent.id}/complete`, { status: "done", txHash: bTx })).status === 200) break
    await sleep(2500)
  }
  check(sent.filter((m) => m.to === A && m.text.includes("<b>@bob_kt</b> paid <b>3.33 MUSD</b> for Dinner")).length === 1, `A told: @bob_kt paid 3.33 MUSD for Dinner ${explorerTx("testnet", bTx)}`)
  check([...cards.values()].some((c) => c.includes("✅ @bob_kt")), "the card shows @bob_kt ✅")
  const cTx = await transfer(cKey, aKey.address, parseEther("3.33")) // straight from a wallet, no Keel intent
  const ok = await until("the watcher to match C's payment", () => (store.getSplit(id)?.status ?? "") === "settled")
  check(ok, `C's plain wallet transfer matched on-chain and settled the split ${explorerTx("testnet", cTx)}`)
  check(sent.filter((m) => m.to === A && m.text.includes("<b>@chidi_kt</b> paid")).length === 1 && sent.some((m) => m.to === A && m.text.includes("<b>Dinner</b> is settled")), "A told once that @chidi_kt paid, then that Dinner is settled")
  check(!sent.some((m) => m.to === A && m.text.includes("You received <b>3.33 MUSD</b>")), "no duplicate generic 'you received' notices")
  check((await call(B, "POST", `/api/split/${id}/pay`, {})).body.code === "paid", "B paying again: 'You've already paid your share'")
}

console.log("4. 2-person split with D, who has no wallet yet")
{
  const r = await call(A, "POST", "/api/splits", { total: parseEther("2").toString(), title: "Taxi", people: [{ raw: "@dan_kt" }], includeMe: true })
  const id = r.body.id as string
  check(sent.some((m) => m.to === D && m.text.includes("Your share: <b>1 MUSD</b>")), "D is asked in Telegram")
  check((await call(D, "POST", `/api/split/${id}/pay`, {})).body.code === "need_wallet", "D must link a wallet first")
  store.setAddress(D, dKey.address)
  await transfer(aKey, dKey.address, parseEther("1")) // so D has MUSD to pay with
  const intent = (await call(D, "POST", `/api/split/${id}/pay`, {})).body
  const dTx = await transfer(dKey, aKey.address, BigInt(intent.params.amount))
  await mined(dTx)
  await until("the watcher to settle Taxi", () => store.getSplit(id)?.status === "settled")
  check(store.getSplit(id)?.status === "settled" && store.getIntent(intent.id)?.status === "done", `D paid after linking; settled (watcher closed D's review screen too) ${explorerTx("testnet", dTx)}`)
}

console.log("5. A participant who never started the bot")
{
  unreachable.add(E)
  const r = await call(A, "POST", "/api/splits", { total: parseEther("2").toString(), title: "Snacks", people: [{ raw: "@eve_kt" }, { raw: "@nobody_kt" }], includeMe: false })
  check(JSON.stringify(r.body.notReached) === JSON.stringify(["@nobody_kt", "@eve_kt"]) || JSON.stringify(r.body.notReached) === JSON.stringify(["@eve_kt", "@nobody_kt"]), `can't reach: ${r.body.notReached.join(", ")}`)
  check(store.hasQueued(E), "Eve's request waits in the outbox for when she opens the bot")
  const v = (await call(A, "GET", `/api/split/${r.body.id}`)).body
  check(v.shares.every((s: { link?: string }) => s.link?.startsWith("https://t.me/") && s.link.split("startapp=")[1].length <= 64), "A gets a pay link per person to share (each fits Telegram)")
  await call(A, "POST", `/api/split/${r.body.id}/cancel`, {})
}

// tidy up: send the test wallets' MUSD back to A
for (const k of [bKey, cKey, dKey]) {
  const bal = await balance(k.address)
  if (bal > 0n) await transfer(k, aKey.address, bal).catch(() => undefined)
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed")
await store.flush()
process.exit(failures ? 1 : 0)
