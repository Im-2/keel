import { getDeployment, type Deployment, type NetworkName } from "@keel/shared"

export interface Config {
  botToken: string
  botUsername: string
  network: NetworkName
  rpcUrl?: string
  miniappUrl: string // https URL where the Mini App is hosted
  miniappShortName?: string // BotFather "Direct Link" short name, enables private startapp claim links
  apiPort: number
  dbPath: string
  keeperKey?: `0x${string}`
  relayerKey?: `0x${string}` // pays gas for claim-link relays (defaults to the keeper key)
  adminIds: number[]
  pollMs: number
  deployment: Deployment
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const network = (env.NETWORK ?? "testnet") as NetworkName
  if (!["testnet", "mainnet", "local"].includes(network)) throw new Error(`NETWORK must be testnet|mainnet|local, got ${network}`)
  const botToken = env.BOT_TOKEN
  if (!botToken) throw new Error("BOT_TOKEN is required (create a bot with @BotFather)")
  const deployment = getDeployment(network, { guardianFactory: env.KEEL_FACTORY, pay: env.KEEL_PAY })
  if (!deployment.keel) {
    throw new Error(`Keel contracts are not deployed on ${network}. Run the deploy script or set KEEL_FACTORY and KEEL_PAY.`)
  }
  return {
    botToken,
    botUsername: env.BOT_USERNAME ?? "KeelBot",
    network,
    rpcUrl: env.RPC_URL || undefined,
    miniappUrl: (env.MINIAPP_URL ?? "https://localhost:5173").replace(/\/$/, ""),
    miniappShortName: env.MINIAPP_SHORTNAME || undefined,
    apiPort: Number(env.PORT ?? 8787),
    dbPath: env.DB_PATH ?? ".keel-data/keel.sqlite",
    keeperKey: (env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined) || undefined,
    relayerKey: ((env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined) || (env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined)) || undefined,
    adminIds: (env.ADMIN_IDS ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean),
    pollMs: Number(env.POLL_MS ?? 30_000),
    deployment,
  }
}
