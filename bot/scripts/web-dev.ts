/**
 * API-only local server for developing the web app: real Mezo testnet reads, a local scratch database, and no
 * Telegram connection at all (notifications are printed). Never touches the production bot or its webhook.
 *
 *   tsx scripts/web-dev.ts      then: pnpm --filter @keel/miniapp dev, and open http://localhost:5173
 */
import { serve } from "@hono/node-server"
import { loadConfig } from "../src/config"
import { Store } from "../src/db"
import { LiveChain } from "../src/chain"
import { createApi } from "../src/api"
import { LiveBus } from "../src/live"
import { Splits } from "../src/splits"
import { LiveClaimRelayer } from "../src/relayer"
import type { Notifier } from "../src/notify"

const config = loadConfig({ ...process.env, BOT_TOKEN: "0:web-dev-no-telegram", MINIAPP_URL: "http://localhost:5173", DB_PATH: ".keel-data/web-dev.sqlite" })
const store = await Store.open(config.dbPath)
const chain = new LiveChain(config.deployment, config.rpcUrl)
const notifier: Notifier = { send: async (id, html) => (console.log(`[notify ${id}]`, html.replace(/<[^>]+>/g, "").slice(0, 120)), true) }
const live = new LiveBus()
const splits = new Splits({ config, store, notifier, live })
const relayer = config.relayerKey ? new LiveClaimRelayer(chain, config) : undefined
const app = createApi({ config, store, chain, notifier, live, splits, relayer })
serve({ fetch: app.fetch, port: config.apiPort }, (i) => console.log(`web-dev api on :${i.port} (${config.network}, no Telegram)`))
