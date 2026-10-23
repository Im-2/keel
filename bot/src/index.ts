import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { webhookCallback } from "grammy"
import { privateKeyToAccount } from "viem/accounts"
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
import { Ops, mountOps } from "./ops"
import { libsqlMirror } from "./mirror"

const config = loadConfig()
// Hosts with an ephemeral disk (Render free) keep the database in Turso: the local file is a fast cache that is
// rebuilt from the mirror on every start, and every write is replayed to it.
const mirror = process.env.TURSO_DATABASE_URL ? libsqlMirror(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN) : undefined
const store = await Store.open(config.dbPath, mirror)
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

// Premium users are checked every tick; everyone else every 4th tick.
const alerts = new AlertEngine({ config, store, chain, notifier, isPremium: premium.isPremium }, config.premium ? 4 : 1)
const keeper = config.keeperKey ? new Keeper(new LiveKeeperBackend(chain, config), store) : undefined

// Webhooks when there is a public URL (always-on host); long polling for local development.
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "")
const mode = publicUrl ? "webhook" : "polling"
let me: { username?: string } | null = null
const ops = new Ops({
  config, store, chain, notifier, alerts, keeper, mode,
  keeperAddress: config.keeperKey ? privateKeyToAccount(config.keeperKey).address : undefined,
  minKeeperBtc: Number(process.env.KEEPER_MIN_BTC ?? 0.001),
  botInfo: async () => (me ??= await bot.api.getMe()),
})
mountOps(app, ops, process.env.CRON_SECRET)

if (publicUrl) {
  // unguessable path + Telegram's secret header: only Telegram can post updates
  const secret = createHash("sha256").update(`keel-webhook:${config.botToken}`).digest("hex").slice(0, 48)
  app.post(`/tg/${secret.slice(0, 16)}`, webhookCallback(bot, "hono", { secretToken: secret }))
  await bot.init()
  await bot.api.setWebhook(`${publicUrl}/tg/${secret.slice(0, 16)}`, { secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false })
  console.log(`bot @${bot.botInfo.username} receiving updates by webhook at ${publicUrl}`)
}

// Local all-in-one: serve the built Mini App from the same server when it exists (production uses Vercel).
const miniappDist = resolve(import.meta.dirname, "../../miniapp/dist")
if (!publicUrl && existsSync(miniappDist)) {
  app.use("/*", serveStatic({ root: "../miniapp/dist" }))
  app.get("*", serveStatic({ path: "../miniapp/dist/index.html" }))
}

const server = serve({ fetch: app.fetch, port: config.apiPort }, (i) => console.log(`api listening on :${i.port}`))

// Internal schedule. The external pinger (/cron/tick) runs the same jobs; Ops skips a job that is still running.
setInterval(() => void ops.runAlerts(), config.pollMs)
if (keeper) setInterval(() => void ops.runKeeper(), config.pollMs)
void ops.runKeeper()
void ops.runAlerts()

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
if (!publicUrl) {
  // switching back to polling needs the webhook removed first
  await bot.api.deleteWebhook().catch(() => undefined)
  void bot.start({ onStart: (info) => console.log(`bot @${info.username} polling on ${config.network}`) })
}

// Graceful shutdown: let the last database writes reach the mirror before the host stops us.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    console.log(`${sig}: flushing ${store.mirrorBacklog} pending writes`)
    if (!publicUrl) await bot.stop().catch(() => undefined)
    server.close()
    await Promise.race([store.flush(), new Promise((r) => setTimeout(r, 8000))])
    process.exit(0)
  })
}
