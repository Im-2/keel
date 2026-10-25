/**
 * Two people, two wallets, real Mezo testnet: the send / receive / history / notification paths end to end.
 *
 *   A = the deployer wallet (has MUSD), B = a fresh wallet funded with a little BTC for gas, C = a Telegram user
 *   with no wallet. A recording notifier stands in for Telegram (the scenarios check exactly what each person is
 *   told), the database is in memory (production data is never touched). Everything on-chain is real.
 *
 *   tsx scripts/payments-testnet.ts        (reads DEPLOYER_PRIVATE_KEY and the bot config from ../.env)
 */
import { createWalletClient, erc20Abi, http, parseEther, type Address, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFor, explorerTx } from "@keel/shared"
import { loadConfig } from "../src/config"
import { Store } from "../src/db"
import { LiveChain } from "../src/chain"
import { createApi } from "../src/api"
import { createCompletion } from "../src/completion"
import { History } from "../src/history"
import { LiveBus, type LiveEvent } from "../src/live"
import { BlockWatcher } from "../src/watcher"
import { flushOutbox, type Notifier, type NotifyOpts } from "../src/notify"
import { signInitData } from "../src/telegram-auth"

const config = { ...loadConfig(), dbPath: ":memory:" }
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
const completion = createCompletion({ config, store, chain, notifier, live })
const watcher = new BlockWatcher({ config, store, chain, notifier, live, completion })
const history = new History({ config, store, chain })
const app = createApi({ config, store, chain, notifier, live, completion, history })

const A = 1001, B = 1002, C = 1003
const aKey = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const bKey = privateKeyToAccount(generatePrivateKey())
store.upsertUser(A, "alice_kt", "Alice")
store.setAddress(A, aKey.address)
store.upsertUser(B, "Bob_KT", "Bob")
store.setAddress(B, bKey.address)
store.upsertUser(C, "carol_kt", "Carol") // started the bot, never linked a wallet

const events = new Map<number, LiveEvent[]>([[A, []], [B, []]])
live.subscribe(A, (e) => events.get(A)!.push(e))
live.subscribe(B, (e) => events.get(B)!.push(e))

const init = (id: number, username: string) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username }) }, config.botToken)
const call = async (id: number, username: string, method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init(id, username) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}
const chainDef = chainFor("testnet")
const wallet = (key: typeof aKey) => createWalletClient({ account: key, chain: chainDef, transport: http(config.rpcUrl) })
const musd = config.deployment.musd.musd
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`)
  if (!ok) failures++
}
async function mined(hash: Hex) {
  for (let i = 0; i < 90; i++) {
    const r = await chain.receipt(hash, 1)
    if (r) return r
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
// public nodes lag each other: a fresh nonce can be "too low" on the node that answers; retry like a wallet would
async function transfer(key: typeof aKey, to: Address, amount: bigint): Promise<Hex> {
  for (let i = 0; ; i++) {
    try {
      return await wallet(key).writeContract({ address: musd, abi: erc20Abi, functionName: "transfer", args: [to, amount] })
    } catch (e) {
      if (i >= 4 || !/nonce|underpriced|already known/i.test((e as Error).message)) throw e
      await sleep(3000)
    }
  }
}

console.log(`A ${aKey.address} (deployer)\nB ${bKey.address} (fresh)\n`)
await watcher.tick() // start the cursor at the head

console.log("0. fund B with gas")
await mined(await wallet(aKey).sendTransaction({ to: bKey.address, value: parseEther("0.0003") }))

console.log("1. Mini App: A sends 2 MUSD to @bob_kt (lower-case lookup) and confirms")
{
  const i = await call(A, "alice_kt", "POST", "/api/intent", { type: "send", to: "@bob_kt", amount: parseEther("2").toString(), memo: "Lunch" })
  check(i.status === 200 && i.body.params.to === bKey.address && i.body.params.label === "@Bob_KT", "username resolved case-insensitively to B's linked wallet")
  const hash = await transfer(aKey, bKey.address, parseEther("2"))
  await call(A, "alice_kt", "POST", `/api/intent/${i.body.id}/complete`, { status: "submitted", txHash: hash })
  check(events.get(A)!.some((e) => e.reason === "tx_submitted"), "A's open app got the pending row (tx_submitted)")
  const rc = await mined(hash)
  check(rc.ok, `receipt success ${explorerTx("testnet", hash)}`)
  let done: Record<string, any> = {}
  for (let k = 0; k < 6; k++) {
    const r = await call(A, "alice_kt", "POST", `/api/intent/${i.body.id}/complete`, { status: "done", txHash: hash })
    done = r.body
    if (r.status === 200) break
    await sleep(2500)
  }
  check(done.status === "done", "server confirmed it as done")
  check(sent.filter((m) => m.to === B && m.text.includes("You received <b>2 MUSD</b> from <b>@alice_kt</b>") && m.text.includes("Lunch")).length === 1, "B told once: You received 2 MUSD from @alice_kt (with the memo)")
  check(sent.some((m) => m.to === A && m.text.includes("✅ Sent")), "A told ✅ Sent")
  check(events.get(B)!.some((e) => e.reason === "received" && e.toast?.includes("@alice_kt")), "B's open app got a live 'received' update with a toast")
  await until("the watcher to record it", () => store.eventsFor(bKey.address).some((e) => e.tx === hash.toLowerCase()))
  check(sent.filter((m) => m.to === B && m.text.includes("You received")).length === 1, "the block watcher saw the same transfer and did not repeat the notice")
}

console.log("2. Chat: B sends 1 MUSD back to A; the app never confirms it (webview closed)")
{
  const i = store.createIntent(B, "send", { to: aKey.address, amount: parseEther("1").toString(), label: "@alice_kt", toTg: A, memo: "" }, B)
  const hash = await transfer(bKey, aKey.address, parseEther("1"))
  await mined(hash)
  const ok = await until("the watcher to settle B's send", () => store.getIntent(i.id)?.status === "done")
  check(ok && store.getIntent(i.id)?.tx_hash?.toLowerCase() === hash.toLowerCase(), `watcher matched the transfer to B's pending send and marked it done ${explorerTx("testnet", hash)}`)
  check(sent.filter((m) => m.to === A && m.text.includes("You received <b>1 MUSD</b> from <b>@Bob_KT</b>")).length === 1, "A told once: You received 1 MUSD from @Bob_KT")
  check(sent.some((m) => m.to === B && m.text.includes("✅ Sent")), "B told ✅ Sent even though the app never reported back")
}

console.log("3. Recipient without a wallet: A tries to send to @carol_kt")
{
  const r = await call(A, "alice_kt", "POST", "/api/intent", { type: "send", to: "carol_kt", amount: parseEther("1").toString() })
  check(r.status === 404 && r.body.code === "not_on_keel" && String(r.body.error).includes("They haven't joined Keel yet, so I'll create a claim link they can open"), "refused with the claim-link offer, nothing sent")
}

console.log("4. Recipient Telegram can't reach (never pressed Start): A sends 0.5 MUSD to B")
{
  unreachable.add(B)
  const i = await call(A, "alice_kt", "POST", "/api/intent", { type: "send", to: "@Bob_KT", amount: parseEther("0.5").toString() })
  const hash = await transfer(aKey, bKey.address, parseEther("0.5"))
  await mined(hash)
  for (let k = 0; k < 6; k++) {
    if ((await call(A, "alice_kt", "POST", `/api/intent/${i.body.id}/complete`, { status: "done", txHash: hash })).status === 200) break
    await sleep(2500)
  }
  check(sent.some((m) => m.to === A && m.text.includes("@Bob_KT hasn't started Keel yet; they'll see it when they join.")), "A told: @Bob_KT hasn't started Keel yet; they'll see it when they join")
  check(store.hasQueued(B), "B's notice queued in the outbox")
  unreachable.delete(B)
  await flushOutbox(store, notifier, B) // what happens when B next messages the bot
  check(sent.some((m) => m.to === B && m.text.includes("You received <b>0.5 MUSD</b>")) && !store.hasQueued(B), "delivered when B shows up")
}

console.log("5. History and isolation")
{
  await until("the watcher to pass the last transfer", () => store.eventsFor(bKey.address).filter((e) => e.kind === "transfer_in").length >= 2)
  const hb = await call(B, "Bob_KT", "GET", "/api/activity?limit=20")
  const types = (hb.body.items as Array<{ type: string; counterparty: string | null; tx: string }>).map((x) => `${x.type}:${x.counterparty}`)
  console.log("    B's activity:", types.join(", "))
  check(types.filter((t) => t === "received:@alice_kt").length === 2, "B's Activity shows both received transfers from @alice_kt (from on-chain logs)")
  check(types.includes("send:@alice_kt"), "B's Activity shows B's own send")
  const ha = await call(A, "alice_kt", "GET", "/api/activity?limit=50")
  check((ha.body.items as Array<{ type: string; counterparty: string }>).some((x) => x.type === "received" && x.counterparty === "@Bob_KT"), "A's Activity shows the 1 MUSD received from @Bob_KT")
  const pb = await call(B, "Bob_KT", "GET", "/api/position")
  check(!JSON.stringify(pb.body).toLowerCase().includes(aKey.address.toLowerCase()) && pb.body.address === bKey.address, "B's position is B's wallet only")
  check(pb.body.wallet.musd === parseEther("1.5").toString(), `B's MUSD balance is live from chain: ${Number(pb.body.wallet.musd) / 1e18}`)
}

// give B's leftover MUSD back so repeated runs don't strand funds
await mined(await transfer(bKey, aKey.address, parseEther("1.5"))).catch(() => undefined)
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed")
await store.flush()
process.exit(failures ? 1 : 0)
