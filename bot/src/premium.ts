import { paymentMiddleware, x402ResourceServer } from "@x402/hono"
import { ExactEvmScheme } from "@x402/evm/exact/server"
import { HTTPFacilitatorClient } from "@x402/core/server"
import { declareEip2612GasSponsoringExtension } from "@x402/extensions"
import { parseUnits } from "viem"
import type { Hono } from "hono"
import type { Config } from "./config"
import type { Store } from "./db"

const DAY = 86_400

/** Premium alerts are a pay-per-use x402 purchase: N days of faster polling, paid in MUSD. */
export class Premium {
  constructor(private store: Store, private now: () => number = () => Math.floor(Date.now() / 1000)) {}
  until(tgId: number): number {
    return Number(this.store.getKv(`premium:${tgId}`) ?? 0)
  }
  isPremium = (tgId: number) => this.until(tgId) > this.now()
  /** Extends from the current expiry so early renewals never lose time. */
  grant(tgId: number, days: number): number {
    const from = Math.max(this.until(tgId), this.now())
    const next = from + days * DAY
    this.store.setKv(`premium:${tgId}`, String(next))
    return next
  }
}

export interface PremiumRouteDeps {
  config: Config
  premium: Premium
  /** Hono middleware that sets the authenticated Telegram user (see api.ts). */
  auth: Parameters<Hono["use"]>[1]
  tgIdOf: (c: never) => number
  onGranted?: (tgId: number, until: number) => Promise<void> | void
}

/** Mounts POST /api/premium/subscribe behind Telegram auth + an x402 paywall priced in MUSD. */
export function mountPremium(app: Hono<any>, d: PremiumRouteDeps) {
  const cfg = d.config.premium
  if (!cfg) return
  const musd = d.config.deployment.musd.musd
  const network = `eip155:${d.config.deployment.chainId}` as const
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(network, new ExactEvmScheme())

  app.use("/api/premium/*", d.auth)
  app.use(
    paymentMiddleware(
      {
        "POST /api/premium/subscribe": {
          accepts: [
            {
              scheme: "exact",
              network,
              payTo: cfg.payTo,
              price: {
                asset: musd,
                amount: parseUnits(cfg.priceMusd, 18).toString(),
                extra: { name: "Mezo USD", version: "1", assetTransferMethod: "permit2" },
              },
            },
          ],
          description: `Keel Premium alerts: ${cfg.days} days of faster liquidation and redemption monitoring`,
          mimeType: "application/json",
          // MUSD is EIP-2612: the payer signs a permit for Permit2 instead of sending an approve transaction,
          // and the facilitator submits it with the payment, so paying needs no BTC for gas at all.
          extensions: { ...declareEip2612GasSponsoringExtension() },
        },
      },
      server,
      // syncFacilitatorOnStart defaults to true: the server must learn the facilitator's supported kinds
      // (eip155:31611 / MUSD / permit2) before it can build payment requirements.
    ),
  )
  app.get("/api/premium", (c) => {
    const tgId = d.tgIdOf(c as never)
    const until = d.premium.until(tgId)
    return c.json({ active: until > Math.floor(Date.now() / 1000), until, priceMusd: cfg.priceMusd, days: cfg.days })
  })
  app.post("/api/premium/subscribe", async (c) => {
    const tgId = d.tgIdOf(c as never)
    const until = d.premium.grant(tgId, cfg.days)
    await d.onGranted?.(tgId, until)
    return c.json({ active: true, until })
  })
}
