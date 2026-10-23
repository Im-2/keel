// Live alert check: the real AlertEngine reads a real Mezo testnet loan (the demo wallet) and delivers the alert,
// with its one-tap buttons, to a real Telegram chat. Thresholds are raised for this run only so the 181% loan fires.
// Usage: pnpm tsx scripts/alert-live-test.ts <telegram-id> <loan-owner-address>
import { Bot } from "grammy"
import { getDeployment } from "@keel/shared"
import { LiveChain } from "../src/chain"
import { Store } from "../src/db"
import { AlertEngine } from "../src/alerts"
import { TelegramNotifier, type Notifier } from "../src/notify"
const [tgArg, owner] = process.argv.slice(2)
const TG = Number(tgArg)
const store = new Store(".keel-data/keel.sqlite")
const real = store.getUser(TG)
if (!real) throw new Error("that Telegram user has not started the bot")
store.boundUsers = () => [{ ...real, address: owner, settings: { ...real.settings, warnIcr: 2.0, dangerIcr: 1.3, redemptionAlertMusd: 1e12, muted: false } }]
store.setAlert(TG, "icr", "ok")
store.setAlert(TG, "redemption", "0")
const tg = new TelegramNotifier(new Bot(process.env.BOT_TOKEN!).api)
const log: unknown[] = []
const notifier: Notifier = {
  async send(id, html, opts) {
    log.push({ text: html.replace(/<[^>]+>/g, ""), buttons: (opts?.buttons ?? []).flat().map((b) => `${b.text} -> ${b.webApp ?? b.url}`) })
    await tg.send(id, "🧪 <b>TEST ALERT</b> (real Mezo testnet data from the demo wallet's loan)\n\n" + html, opts)
  },
}
await new AlertEngine({ config: { network: "testnet", miniappUrl: process.env.MINIAPP_URL! }, store, chain: new LiveChain(getDeployment("testnet")), notifier }).tick()
console.log(JSON.stringify(log, null, 1))
store.setAlert(TG, "icr", "ok")
store.setAlert(TG, "redemption", "0")
