import React from "react"
import { createRoot } from "react-dom/client"
import { WagmiProvider, createConfig, http } from "wagmi"
import { injected, walletConnect } from "wagmi/connectors"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit"
import "@rainbow-me/rainbowkit/styles.css"
import { chainFor } from "@keel/shared"
import { api, tg, type AppConfig } from "./lib/api"
import { App } from "./App"
import { inTelegram, readHandoffFromUrl } from "./lib/telegram"
import { scopeStorageToUser } from "./lib/session"
import "./styles.css"

tg?.ready()
tg?.expand()
try {
  tg?.setHeaderColor?.("#ffffff")
  tg?.setBackgroundColor?.("#ffffff")
  tg?.setBottomBarColor?.("#ffffff")
  tg?.disableVerticalSwipes?.()
} catch {
  /* older Telegram clients */
}

readHandoffFromUrl()
// before wagmi restores any stored connection: it must belong to this Telegram account
scopeStorageToUser(tg?.initDataUnsafe.user?.id)

const root = createRoot(document.getElementById("root")!)

async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) (await import("./dev/mock")).installMock()
  root.render(<div className="app"><div className="splash"><div className="splash-mark"><span className="splash-glow" /><img src="/keel-mark-red.svg" width={72} height={72} alt="Keel" /></div></div></div>)
  let cfg: AppConfig
  try {
    cfg = await api.config()
  } catch {
    root.render(
      <div className="app"><div className="state state-error"><img src="/keel-mark-red.svg" width={56} height={56} alt="Keel" /><h2>Can't reach Keel</h2><p className="muted">The server is not responding. Please try again in a moment.</p></div></div>,
    )
    return
  }
  const chain = chainFor(cfg.network)
  const projectId = import.meta.env.VITE_WC_PROJECT_ID || "keel-no-walletconnect"
  const transports = { [chain.id]: http(cfg.rpcUrl ?? chain.rpcUrls.default.http[0]) } as never
  // Inside Telegram we drive WalletConnect ourselves (see TelegramConnect): no modal, deep links via tg.openLink.
  // Elsewhere (desktop, or a wallet's own browser) RainbowKit's picker and injected wallets work as usual.
  const wagmi = inTelegram()
    ? createConfig({
        chains: [chain],
        transports,
        connectors: [
          walletConnect({ projectId, showQrModal: false, metadata: { name: "Keel", description: "BTC-backed dollars in Telegram", url: location.origin, icons: [`${location.origin}/keel-icon-512.png`] } }),
          injected(),
        ],
      })
    : getDefaultConfig({ appName: "Keel", projectId, chains: [chain], transports, ssr: false })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
  root.render(
    <React.StrictMode>
      <WagmiProvider config={wagmi}>
        <QueryClientProvider client={qc}>
          <RainbowKitProvider theme={lightTheme({ accentColor: "#E10600", accentColorForeground: "#FFFFFF", borderRadius: "large", overlayBlur: "small" })} modalSize="compact">
            <App cfg={cfg} />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  )
}
void boot()
