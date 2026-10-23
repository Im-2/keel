// Real x402 payment on Mezo testnet against Keel's production premium route:
// Hono + @x402/hono paywall (bot/src/premium.ts) -> facilitator.vativ.io -> MUSD settles on chain.
// Runs the real API code on localhost with an in-memory database, so the live bot's data is untouched.
import { serve } from "@hono/node-server"
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch"
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm"
import { privateKeyToAccount } from "viem/accounts"
import { E18, fmtMusd, getDeployment, makeClient, musdAbi } from "@keel/shared"
import { createApi } from "../src/api"
import { Store } from "../src/db"
import { LiveChain } from "../src/chain"
import { Premium } from "../src/premium"
import { loadConfig } from "../src/config"
import { signInitData } from "../src/telegram-auth"

const payer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
const payTo = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as `0x${string}`).address // a different wallet than the payer
const config = loadConfig({ ...process.env, NETWORK: "testnet", PREMIUM_PAY_TO: payTo, PREMIUM_PRICE_MUSD: "1", PREMIUM_DAYS: "30", MINIAPP_URL: "http://localhost:8799" } as Record<string, string>)
const store = new Store(":memory:")
const chain = new LiveChain(getDeployment("testnet"))
const premium = new Premium(store)
const notices: string[] = []
const app = createApi({ config, store, chain, premium, notifier: { send: async (_id, t) => void notices.push(t) } })
const server = serve({ fetch: app.fetch, port: 8799 })
const pub = makeClient("testnet")
const bal = (a: `0x${string}`) => pub.readContract({ address: chain.deployment.musd.musd, abi: musdAbi, functionName: "balanceOf", args: [a] })

const TG = 900000001 // test identity, only in the in-memory store
const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: TG, username: "x402_audit", first_name: "Audit" }) }, config.botToken)
// the x402 client retries with a Request object that carries the payment header: keep its headers, add ours
const authed: typeof fetch = (u, i) => {
  const r = new Request(u, i)
  r.headers.set("content-type", "application/json")
  r.headers.set("x-telegram-init-data", initData)
  return fetch(r)
}

try {
  const status0 = await (await authed("http://localhost:8799/api/premium")).json()
  console.log("premium before:", JSON.stringify(status0))
  const unpaid = await authed("http://localhost:8799/api/premium/subscribe", { method: "POST", body: "{}" })
  console.log("without payment:", unpaid.status, unpaid.headers.get("payment-required") ? "(PAYMENT-REQUIRED header present)" : "")
  const req = JSON.parse(Buffer.from(unpaid.headers.get("payment-required") ?? "", "base64").toString() || "{}")
  console.log("requirements:", JSON.stringify(req.accepts?.[0] ?? req).slice(0, 400))

  const [p0, r0] = await Promise.all([bal(payer.address), bal(payTo)])
  const client = new x402Client().register("eip155:31611", new ExactEvmScheme(toClientEvmSigner(payer, pub as never)))
  const paid = await wrapFetchWithPayment(authed, client)("http://localhost:8799/api/premium/subscribe", { method: "POST", body: "{}" })
  const body = await paid.text()
  console.log("with payment:", paid.status, body)
  const again = paid.headers.get("payment-required")
  if (again) console.log("server says:", JSON.stringify(JSON.parse(Buffer.from(again, "base64").toString())).slice(0, 600))
  const pr = paid.headers.get("payment-response")
  if (pr) console.log("settlement:", JSON.stringify(decodePaymentResponseHeader(pr)))
  await new Promise((r) => setTimeout(r, 4000))
  const [p1, r1] = await Promise.all([bal(payer.address), bal(payTo)])
  console.log(`payer MUSD ${fmtMusd(p0)} -> ${fmtMusd(p1)}; payTo MUSD ${fmtMusd(r0)} -> ${fmtMusd(r1)}`)
  console.log("premium after:", JSON.stringify(await (await authed("http://localhost:8799/api/premium")).json()))
  console.log(paid.status === 200 && r1 - r0 === E18 ? "X402 OK" : "X402 NOT SETTLED")
} finally {
  server.close()
}
