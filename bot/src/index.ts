import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { loadConfig } from "./config"
import { Store } from "./db"
import { LiveChain } from "./chain"
import { createBot } from "./bot"
import { createApi } from "./api"
import { AlertEngine } from "./alerts"
import { Keeper, LiveKeeperBackend } from "./keeper"
import { LiveClaimRelayer } from "./relayer"
import { TelegramNotifier } from "./notify"
import { Premium } from "./premium"

const config = loadConfig()
const store = new Store(config.dbPath)
const chain = new LiveChain(config.deployment, config.rpcUrl)
const bot = createBot({ config, store, chain })
const notifier = new TelegramNotifier(bot.api)

const relayer = config.relayerKey ? new LiveClaimRelayer(chain, config) : undefined
if (!relayer) console.warn("No RELAYER_PRIVATE_KEY / KEEPER_PRIVATE_KEY: claim links cannot be relayed.")

const premium = new Premium(store)
const app = createApi({
  config, store, chain, notifier, relayer, premium,
  editMessage: (chatId, messageId, html, replyMarkup) =>
    bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", reply_markup: replyMarkup as never }),
})

// One process, one tunnel: serve the built Mini App from the same server when it exists.
const miniappDist = resolve(import.meta.dirname, "../../miniapp/dist")
if (existsSync(miniappDist)) {
  app.use("/*", serveStatic({ root: "../miniapp/dist" }))
  app.get("*", serveStatic({ path: "../miniapp/dist/index.html" }))
}

serve({ fetch: app.fetch, port: config.apiPort }, (i) => console.log(`api listening on :${i.port}`))

const loop = (name: string, ms: number, fn: () => Promise<unknown>) => {
  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try {
      await fn()
    } catch (e) {
      console.error(`${name} tick failed:`, (e as Error).message)
    } finally {
      running = false
    }
  }, ms)
}

// Premium users are checked every tick; everyone else every 4th tick.
const alerts = new AlertEngine({ config, store, chain, notifier, isPremium: premium.isPremium }, config.premium ? 4 : 1)
loop("alerts", config.pollMs, () => alerts.tick())

if (config.keeperKey) {
  const keeper = new Keeper(new LiveKeeperBackend(chain, config), store)
  loop("keeper", config.pollMs, () => keeper.tick())
  console.log("keeper enabled")
}

await bot.api.setMyCommands([
  { command: "position", description: "Your loan, ratio and liquidation price" },
  { command: "borrow", description: "Borrow MUSD against BTC, e.g. /borrow 1800 160" },
  { command: "protect", description: "Auto-protect your loan" },
  { command: "send", description: "Send MUSD, e.g. /send @friend 25" },
  { command: "claimlink", description: "Send MUSD to someone without a wallet" },
  { command: "request", description: "Request a payment in a chat" },
  { command: "split", description: "Split a bill, e.g. /split 90 @a @b" },
  { command: "premium", description: "Faster alerts, pay per use in MUSD" },
  { command: "alerts", description: "Liquidation & redemption alerts" },
  { command: "help", description: "All commands" },
]).catch((e) => console.warn("setMyCommands failed:", e.message))

// The chat menu button opens the Mini App at the stable production URL (MINIAPP_URL), never a per-deploy URL.
await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Open Keel", web_app: { url: config.miniappUrl } } }).catch((e) => console.warn("setChatMenuButton failed:", e.message))

bot.catch((e) => console.error("bot error", e.error))
bot.start({ onStart: (me) => console.log(`bot @${me.username} running on ${config.network}`) })
